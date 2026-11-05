/**
 * 档位映射进设置页（storyboard 侧）：`storyboard.strategy` + `storyboard.tierMap`。
 *
 * 要守住的三条：
 *   ① 恒等项（`3: 3`）**不写进文件** —— 写了也没用，只会让用户下次打开看不懂自己改过什么；
 *   ② 空值（`''` / `{}`）是**真的删掉那一项**，不是留个空壳；
 *   ③ 越界的档位要**报错**，不能默默吞掉 —— 用户以为设上了、结果没生效，最难查。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-vs-tiermap-'));
process.env.DSH_HOME = home;
mkdirSync(home, { recursive: true });

const { readVideoSettings, writeVideoSettings, videoConfigPath } =
  await import('../src/settings/config.js');

const path = videoConfigPath({ DSH_HOME: home });
const seed = (obj) => writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
const onDisk = () => JSON.parse(readFileSync(path, 'utf8'));

test('读：没配过时 strategy 是 null、tierMap 是空对象', () => {
  seed({});
  const v = readVideoSettings({ DSH_HOME: home });
  assert.equal(v.strategy, null);
  assert.deepEqual(v.tierMap, {});
});

test('读：恒等项被过滤掉（文件里写了也不当它存在）', () => {
  seed({ storyboard: { strategy: 'native', tierMap: { 1: 3, 2: 2, 5: 4 } } });
  const v = readVideoSettings({ DSH_HOME: home });
  assert.equal(v.strategy, 'native');
  assert.deepEqual(v.tierMap, { 1: 3, 5: 4 }, '2→2 是恒等，不该出现在读出来的表里');
});

test('写：只写非恒等项，其余键不动', () => {
  seed({ storyboard: { auto: true, cutFloor: 60 } });
  writeVideoSettings({ strategy: 'native', tierMap: { 1: 3, 3: 3, 5: 4 } }, { DSH_HOME: home });
  const raw = onDisk();
  assert.equal(raw.storyboard.strategy, 'native');
  assert.deepEqual(raw.storyboard.tierMap, { 1: 3, 5: 4 }, '3→3 不该写进去');
  assert.equal(raw.storyboard.auto, true, '别的键不许被抹掉');
  assert.equal(raw.storyboard.cutFloor, 60, '别的键不许被抹掉');
});

test('写：空 tierMap 是"删掉这一项"，不是留个 {}', () => {
  seed({ storyboard: { tierMap: { 1: 3 }, strategy: 'native' } });
  writeVideoSettings({ tierMap: {} }, { DSH_HOME: home });
  const raw = onDisk();
  assert.equal('tierMap' in raw.storyboard, false, '留空对象会让下次读出来还要再判一次');
  assert.equal(raw.storyboard.strategy, 'native', '只清 tierMap，不该动 strategy');
});

test('写：空 strategy 也是删掉，走回内核默认', () => {
  seed({ storyboard: { strategy: 'skim', cutFloor: 60 } });
  writeVideoSettings({ strategy: '' }, { DSH_HOME: home });
  const raw = onDisk();
  assert.equal('strategy' in raw.storyboard, false);
  assert.equal(raw.storyboard.cutFloor, 60);
});

test('写：越界档位必须报错（不能默默吞掉）', () => {
  seed({});
  assert.throws(() => writeVideoSettings({ tierMap: { 9: 3 } }, { DSH_HOME: home }), /1-8/);
  assert.throws(() => writeVideoSettings({ tierMap: { 1: 0 } }, { DSH_HOME: home }), /1-8/);
});

test('往返：写进去再读回来，就是用户设的那张表', () => {
  seed({});
  writeVideoSettings({ strategy: 'native', tierMap: { 1: 2, 5: 4, 6: 4, 7: 4, 8: 4 } }, { DSH_HOME: home });
  const v = readVideoSettings({ DSH_HOME: home });
  assert.equal(v.strategy, 'native');
  assert.deepEqual(v.tierMap, { 1: 2, 5: 4, 6: 4, 7: 4, 8: 4 });
});

// ---- 参数优先序：显式 > 配置 > 内核默认 -------------------------------------

const { boardOptions } = await import('../src/storyboard/board.js');

test('boardOptions：配置里的 strategy / tierMap 生效', () => {
  seed({ storyboard: { strategy: 'skim', tierMap: { 5: 4 } } });
  const o = boardOptions({ input: 'x.mp4' }, { kind: 'board' });
  assert.equal(o.strategy, 'skim');
  assert.deepEqual(o.tierMap, { 5: 4 });
});

test('boardOptions：某次调用显式传的优先（设置页不该压掉单次指定）', () => {
  seed({ storyboard: { strategy: 'skim', tierMap: { 5: 4 } } });
  const o = boardOptions({ input: 'x.mp4', strategy: 'full', tierMap: { 1: 3 } }, { kind: 'board' });
  assert.equal(o.strategy, 'full');
  assert.deepEqual(o.tierMap, { 1: 3 });
});

test('boardOptions：没配也没传 → 走内核默认，不硬塞 tierMap', () => {
  seed({});
  const o = boardOptions({ input: 'x.mp4' }, { kind: 'board' });
  // 自动选档默认是开的，所以"什么都不指定"落在 'auto' 上；关掉 auto 才落到 compact
  assert.equal(o.strategy, 'auto', '默认是自动选档（autoStrategyEnabled() 默认 true）');
  assert.equal('tierMap' in o, false, '没映射就别塞一个空对象进去');
});

test('boardOptions：关掉自动选档时才落回 compact', () => {
  seed({ storyboard: { auto: false } });
  const o = boardOptions({ input: 'x.mp4' }, { kind: 'board' });
  assert.equal(o.strategy, 'compact', 'storyboard.auto=false 时默认是 compact');
});

// ---- 「每帧固定多大」= 八项全指向同一档 ------------------------------------
//
// 守一个**等价关系**：想让切点密度不影响尺寸，正确做法是把八项都填成同一档。
// 曾经为此加过独立的"锁定"开关，后来删了 —— 它和全映射到同一档逐字节相同，
// 多一个概念只会让人以为还有别的东西。

const { applyStrategy, applyTierMap } = await import('../src/storyboard/tiers.js');

const allSame = (n) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((i) => [i, n]));

test('八项全指向同一档 = 每帧一样大，切点密度被整表吃掉', () => {
  const apply = (tiers, n) => {
    const mapped = applyStrategy(tiers, 'native');
    return mapped.map((t) => allSame(n)[Math.round(Number(t))] ?? t);
  };
  assert.deepEqual(apply([1, 3, 6, 8], 4), [4, 4, 4, 4]);
  assert.deepEqual(apply([1, 5], 2), [2, 2]);
});

test('全映射不吃掉 0 档（自由尺寸补位帧）', () => {
  assert.deepEqual(applyTierMap([0, 5], allSame(3)), [0, 3]);
});

test('对照：compact 是"每档 +1"，结果仍随密度变', () => {
  const base = [1, 5, 8];
  assert.deepEqual(applyStrategy(base, 'compact'), [2, 6, 8]);
  assert.notDeepEqual(applyStrategy(base, 'compact'), [2, 2, 2], '这就是"没锁定"的样子');
});
