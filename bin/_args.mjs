/**
 * 极简参数解析：`--k v` 与裸参。零依赖，够用即可。
 *
 * `$unknown` 里收集**默认值表里没有**的选项名 —— 不认识的参数一律照收，
 * 但调用方要能拿到它们：0.6 删掉了 `--cells` / `--sheets` / `--need`，
 * 老命令却还在跑，静默忽略会让人以为"参数生效了、只是效果不明显"。
 */
export function args(argv, defaults = {}) {
  const out = { ...defaults, _: [] };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (!(key in defaults)) unknown.push(key);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else {
      out._.push(token);
    }
  }
  out.$unknown = unknown;
  return out;
}
