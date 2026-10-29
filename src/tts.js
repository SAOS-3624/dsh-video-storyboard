/**
 * tts.js — 让**脚本**把台词念出来，不经过模型。
 *
 * 为什么要这一层：台词是提前写好的，让模型"等到点、再输出一遍"纯属浪费——
 * 等待期间模型被占着，输出还要花 token，而它说的每一个字早在几分钟前就定好了。
 *
 * 把这件事交给系统 TTS 之后：
 *   - 时间点由脚本守着（毫秒级，比模型自觉准）
 *   - 说话不花 token、不占上下文
 *   - 模型的时间全部留给"看画面、想点什么"——那才是它真正值钱的部分
 *
 * 走 Windows 自带的 SAPI（`SAPI.SpVoice`）。中文声音本机已装：
 *   Microsoft Huihui Desktop / Microsoft Yaoyao / Microsoft Kangkang
 * 注意：**不要用 Add-Type**（安全策略会拦），用 COM 对象即可。
 */

import { execFile } from 'node:child_process';

/** 本机常见的中文声音，按偏好排序 */
export const PREFERRED_VOICES = [
  'Microsoft Huihui Desktop',
  'Microsoft Yaoyao',
  'Microsoft Kangkang',
  'Microsoft Huihui',
];

/**
 * 把文本转成 PowerShell 单引号字面量。
 * 单引号字符串里唯一需要处理的就是单引号本身：写两遍。
 * 换行/反引号/美元符号在单引号里都是字面量，不用管。
 */
export function psLiteral(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/** 生成"念一句"的 PowerShell 命令（不执行，便于测试与排查） */
export function buildSpeakCommand({ text, voice = null, rate = 0, volume = 100 } = {}) {
  const parts = [
    '$v = New-Object -ComObject SAPI.SpVoice',
    `$v.Rate = ${Number.isFinite(rate) ? Math.max(-10, Math.min(10, rate)) : 0}`,
    `$v.Volume = ${Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100}`,
  ];
  if (voice) {
    // 选声音失败不该影响念内容，所以吞掉异常
    parts.push(`try { $v.Voice = $v.GetVoices() | Where-Object { $_.GetDescription() -like ${psLiteral(`*${voice}*`)} } | Select-Object -First 1 } catch { }`);
  }
  parts.push(`$null = $v.Speak(${psLiteral(text)})`);
  return parts.join('; ');
}

/** 真正念出来（异步，等它念完再 resolve；失败不抛，返回原因） */
export function speak(text, {
  voice = PREFERRED_VOICES[0], rate = 0, volume = 100, timeoutMs = 30_000, dryRun = false,
} = {}) {
  const command = buildSpeakCommand({ text, voice, rate, volume });
  if (dryRun) return Promise.resolve({ ok: true, dryRun: true, command });
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) resolve({ ok: false, reason: String(stderr || err.message).slice(0, 200) });
        else resolve({ ok: true });
      });
  });
}

/** 列出本机可用声音（从注册表读，不实例化 COM） */
export function listVoices() {
  const ps = [
    "$out = @()",
    "foreach ($p in @('HKLM:\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens','HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens')) {",
    "  if (Test-Path $p) { Get-ChildItem $p | ForEach-Object { $out += (Get-ItemProperty $_.PSPath).'(default)' } }",
    '}',
    '$out | Sort-Object -Unique',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  });
}
