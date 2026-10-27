#!/usr/bin/env node
/**
 * Portable `node --check` over package sources (Windows cmd / PowerShell / bash).
 * Replaces the bash `for f in …` loop in package.json which fails on cmd.exe.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

function listFiles(dir, exts, { recursive = false } = {}) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory() && recursive) out.push(...listFiles(p, exts, { recursive: true }));
    else if (d.isFile() && exts.some((e) => d.name.endsWith(e))) out.push(p);
  }
  return out.sort();
}

const files = [
  ...listFiles(join(root, "src"), [".js"], { recursive: true }),
  ...listFiles(join(root, "bin"), [".mjs"]),
  ...listFiles(join(root, "scripts"), [".mjs"]),
];

if (!files.length) {
  console.error("syntax-check: no files found");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = relative(root, file);
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    failed += 1;
    const msg = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    console.error(`FAIL ${rel}\n${msg}`);
  } else {
    console.log(`ok ${rel}`);
  }
}

if (failed) {
  console.error(`syntax-check: ${failed}/${files.length} failed`);
  process.exit(1);
}
console.log(`syntax-check: ${files.length} ok`);
