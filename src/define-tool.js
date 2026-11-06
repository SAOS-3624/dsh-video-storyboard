/**
 * define-tool.js — `@deepseek-ai/dsh-tools` 的**离线兜底**。
 *
 * ## 为什么需要它（2026-11-06 社区实报）
 *
 * 插件的工具定义要用宿主的 `defineTool()`：它把 author spec 编译成 JSON Schema、
 * 给 execute 包一层参数校验。但 `@deepseek-ai/dsh-tools` **被打包进宿主的 `app.asar`**，
 * 插件从自己的 `node_modules` 往上解析时**找不到这个包** →
 * `import()` 抛 → `apply()` 被 catch 吞掉 → **整个插件静默不注册任何工具**。
 *
 * 社区原话：「根源没变：它 `import('@deepseek-ai/dsh-tools')`，宿主的这份被打进 `app.asar`，
 * plugins 侧解析不到，加载时就在注册工具之前抛了」。
 *
 * ## 兜底做什么、不做什么
 *
 * **做**：把 author spec 编译成宿主 `register()` 认的 JSON Schema。规则逐条照抄
 * `dsh-tools/lib/index.js` 的 `runSchemaCompiler`：
 *   - `property-map`：每个属性的 `required: true` 提升到父级 `required` 数组，并从属性里删掉；
 *     没写 `required: true` 的属性 = 可选（宿主的参数**默认全是可选**）。
 *   - `type: 'json'` 是 author-only 节点 → 退化成 `{}`（任意 JSON，只保留 description 等注解）。
 *   - `properties` / `items` 递归；其余键（`description` / `enum` / `additionalProperties`）原样透传。
 *
 * **不做**：运行时参数校验（宿主那层 `validateJsonSchemaValue` 拿不到）。
 * 代价是模型传错参数时不再抛 `ToolArgsError`，而是走各 handler 自己的默认值分支 ——
 * 真出问题时表现为"参数没生效"，所以 `schema-audit.test.mjs` 那套静态审计更要守住。
 *
 * **首选仍然是宿主的版本**：`loadDefineTool()` 先 import、再 `DSH_TOOLS_PATH`，
 * 两个都不行才落到这里，并打一条 warn 让用户知道降级了。
 */

const AUTHOR_ONLY_JSON = 'json';

/**
 * 编译一个属性表（`parameters` 或某个 object 节点的 `properties`）。
 * @param {object} map - 属性名 → author value spec
 * @param {string} path - 报错用的路径前缀
 * @returns {{properties: object, required?: string[]}}
 */
function compilePropertyMap(map, path) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${path} 必须是对象（属性名 → 值 schema）`);
  }
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${path}.${key} 必须是值 schema 对象`);
    }
    const { required: mark, ...rest } = spec;
    if (mark !== undefined && mark !== true) throw new Error(`${path}.${key}.required 写了就只能是 true`);
    if (mark === true) required.push(key);
    properties[key] = compileValue(rest, `${path}.${key}`);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/**
 * 编译一个值 schema。`type: 'json'` 退化成注解（不写 `type`）。
 * @param {object} spec
 * @param {string} path
 * @returns {object}
 */
function compileValue(spec, path) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} 必须是值 schema 对象`);
  }
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required') continue; // 由 compilePropertyMap 提走
    if (key === 'properties') {
      const compiled = compilePropertyMap(value, `${path}.properties`);
      out.properties = compiled.properties;
      if (compiled.required) out.required = compiled.required;
      continue;
    }
    if (key === 'items') {
      out.items = compileValue(value, `${path}.items`);
      continue;
    }
    // author-only：任意 JSON。宿主把它变成"只有注解、没有 type"的 schema
    if (key === 'type' && value === AUTHOR_ONLY_JSON) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 编译 `parameters`：隐式开放对象，根上不写 `required`（除非属性显式标了）。
 * @param {object} spec
 * @returns {object}
 */
export function parametersToJsonSchema(spec) {
  const { properties, required } = compilePropertyMap(spec, 'parameters');
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

/**
 * 编译 `output.schema`。
 * @param {object} spec
 * @returns {object}
 */
export function outputSchemaToJsonSchema(spec) {
  return compileValue(spec, 'schema');
}

/**
 * `defineTool` 的兜底实现：**签名和返回值与宿主一致，只是不做运行时参数校验**。
 * @param {object} options - 与宿主 `defineTool` 相同的入参
 * @returns {object} registry-ready definition
 */
export function defineToolCompat(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options 必须是对象');
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== 'string' || !name) throw new Error('defineTool: name 必须是非空字符串');
  if (!output || typeof output !== 'object') throw new Error(`defineTool(${name}): 缺 output`);
  if (typeof output.render !== 'function') throw new Error(`defineTool(${name}): output.render 必须是函数`);
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute 必须是函数`);
  if (options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${name}): timeoutMs 必须是正数`);
  }

  const tool = {
    name,
    description,
    parameters: parametersToJsonSchema(parameters ?? {}),
    output: {
      schema: outputSchemaToJsonSchema(output.schema ?? {}),
      render: output.render,
      ...(typeof output.presentationMeta === 'function' ? { presentationMeta: output.presentationMeta } : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      return execute(args, exec);
    },
  };
  if (typeof options.projectContent === 'function') tool.projectContent = options.projectContent;
  if (typeof options.finalizeContent === 'function') tool.finalizeContent = options.finalizeContent;
  if (typeof options.presentCall === 'function') tool.presentCall = options.presentCall;
  if (typeof options.presentResult === 'function') tool.presentResult = options.presentResult;
  if (typeof options.isConcurrencySafe === 'function') tool.isConcurrencySafe = options.isConcurrencySafe;
  return tool;
}
