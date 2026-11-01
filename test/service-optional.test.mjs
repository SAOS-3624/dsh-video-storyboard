/**
 * service-optional.test.mjs — 取**可选服务**必须走 `ctx.get()`，不能靠 `ctx?.xxx`。
 *
 * ## 事故
 *
 * 0.5.9 为了修"装插件后宿主卡死"，把 `attachments` 从 `inject` 里去掉（cordis 的
 * `inject` 是硬依赖，服务缺失时 `apply` 根本不会被调用）。但访问点只加了个 `?.`：
 *
 *     const saveImage = ctx?.attachments?.saveImage;   // 看着像运行期探测
 *
 * **在 cordis 里照样抛**：它的 ctx 是 Proxy，服务没在 `inject` 里声明时 `get` 陷阱
 * 直接 throw `cannot get property "attachments" without inject`。`?.` 只挡
 * null/undefined，挡不住异常。
 *
 * 用户实报（2026-11-01，Win10 / DSH 0.2.1-rc.3 / Node 24.21）：
 * 装 0.5.9 后分镜工具直接报 `cannot get property "attachments" without inject`，
 * 退回 0.5.3 才正常。
 *
 * ## 这里钉住什么
 *
 * 造一个"像 cordis 那样抛"的 ctx，断言 `serviceOf()` 收得住、`attachSheetImages()`
 * 给的是**可读错误**而不是宿主内部的原话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { serviceOf, attachSheetImages } from '../src/tools/shared.js';

/** 模拟 cordis 的 scoped ctx：访问没 inject 的服务就抛 */
function cordisCtx({ provided = {}, hasGet = true } = {}) {
  const ctx = hasGet
    ? { get: (name) => provided[name] }
    : {};
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return target[prop];
      if (prop in target) return target[prop];
      if (prop in provided) return provided[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
}

test('serviceOf：cordis 抛"without inject"时收住，返回 null', () => {
  const ctx = cordisCtx();
  assert.equal(serviceOf(ctx, 'attachments'), null, '服务没注册时要给 null，不能抛');
});

test('serviceOf：注册过的服务照常取到', () => {
  const saveImage = async () => ({ url: 'x' });
  const ctx = cordisCtx({ provided: { attachments: { saveImage } } });
  assert.equal(serviceOf(ctx, 'attachments')?.saveImage, saveImage);
});

test('serviceOf：老宿主没有 get() 时退回属性访问', () => {
  const attachments = { saveImage: 'fn' };
  const plain = { attachments };
  assert.equal(serviceOf(plain, 'attachments'), attachments);
  // 但**抛错的**普通对象也收得住（Proxy 不一定带 get()）
  const throwing = { get attachments() { throw new Error('boom'); } };
  assert.equal(serviceOf(throwing, 'attachments'), null);
});

test('serviceOf：null / undefined ctx 直接给 null', () => {
  assert.equal(serviceOf(null, 'attachments'), null);
  assert.equal(serviceOf(undefined, 'attachments'), null);
});

test('attachSheetImages：没有 attachments 时报可读错误，不是宿主原话', async () => {
  const ctx = cordisCtx();          // 访问 attachments 会抛 without inject
  await assert.rejects(
    () => attachSheetImages(ctx, { sheets: [{ png: Buffer.from('x'), sheet: 1 }] }),
    (e) => {
      assert.match(e.message, /no `attachments` service/, `要给人话，实得：${e.message}`);
      assert.doesNotMatch(e.message, /without inject/, '不该把宿主的内部错误原样抛出去');
      return true;
    },
  );
});

test('attachSheetImages：有 attachments 时正常提交每张图', async () => {
  const saved = [];
  const ctx = cordisCtx({
    provided: { attachments: { saveImage: async (a) => { saved.push(a.name); return { url: a.name }; } } },
  });
  const images = await attachSheetImages(ctx, {
    sheets: [{ png: Buffer.from('a'), sheet: 1 }, { png: Buffer.from('b'), sheet: 2 }],
  });
  assert.deepEqual(saved, ['storyboard-1.png', 'storyboard-2.png']);
  assert.equal(images.length, 2);
});

/* ------------------------------------------------------------------ this 绑定 */

/**
 * 新版宿主的 `attachments.saveImage` 内部读 `this.compression`（0.2.1-rc.5）。
 * 把方法从服务上取下来裸调 → `this` 是 undefined →
 * `Cannot read properties of undefined (reading 'compression')`。
 *
 * 用户实报（2026-11-01，B 站评论）：所有要出图的工具在"存成附件"最后一步报这个错。
 * 所以调用点必须 `.call(attachments, ...)`，不能 `const f = svc.m; f(...)`。
 */
function ctxWithThisBoundService(extra = {}) {
  const attachments = {
    compression: 'zstd',
    calls: [],
    async saveImage({ data, mediaType, name }) {
      // 这正是宿主内部会做的事：读实例上的配置
      if (!this || typeof this.compression !== 'string') {
        throw new TypeError("Cannot read properties of undefined (reading 'compression')");
      }
      this.calls.push({ bytes: data?.length ?? 0, mediaType, name });
      return { attachmentId: `${name}#${this.compression}`, mediaType, bytes: data?.length ?? 0 };
    },
    ...extra,
  };
  return { get: (n) => (n === 'attachments' ? attachments : undefined), _svc: attachments };
}

test('attachSheetImages: saveImage 必须带着服务实例调用（新版宿主读 this.compression）', async () => {
  const ctx = ctxWithThisBoundService();
  const result = { sheets: [{ sheet: 1, png: Buffer.alloc(64) }, { sheet: 2, png: Buffer.alloc(32) }] };
  const images = await attachSheetImages(ctx, result);
  assert.equal(images.length, 2);
  assert.equal(images[0].attachmentId, 'storyboard-1.png#zstd', 'this 丢了就会拼不出这个 id');
  assert.deepEqual(ctx._svc.calls.map((c) => c.name), ['storyboard-1.png', 'storyboard-2.png']);
  assert.equal(ctx._svc.calls[0].mediaType, 'image/png');
});

test('attachSheetImages: 服务不存在时给可读错误，不是 TypeError', async () => {
  const ctx = { get: () => undefined };
  await assert.rejects(
    () => attachSheetImages(ctx, { sheets: [{ sheet: 1, png: Buffer.alloc(8) }] }),
    /no `attachments` service/,
  );
});
