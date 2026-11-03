# 发版交接：npm + GitHub

> 面向接手发版的人（或 agent）。
> **所有凭据都在本机，不在仓库里** —— 这个仓库是 public，任何 token / key / cookie
> 一旦写进被跟踪的文件就等于已泄露。本文只写"在哪、怎么取"，不写值。

---

## 一、凭据在哪

| 用途 | 位置 | 怎么验证 | 注意 |
|---|---|---|---|
| npm 发布 | `~/.npmrc` 里的 `//registry.npmjs.org/:_authToken` | `npm whoami` → `saos_3624` | 仓库根目录**也有一份**同内容的 `.npmrc`，`.gitignore` 第 24 行已忽略，`npm pack` 也不收 |
| GitHub API（建 Release、关 issue、读 PR、打标签） | Git Credential Manager | 见下方命令 | 前缀 `gho_`，是 GCM 换来的 **OAuth token，会过期**（不是 `ghp_` / `github_pat_` 那种长期 PAT） |
| `git push` | SSH 部署密钥 `~/.ssh/id_ed25519_storyboard` | `ssh -i ~/.ssh/id_ed25519_storyboard -T git@github.com` → `Hi SAOS-3624/dsh-video-storyboard!` | 仓库级 `core.sshCommand` 已指向它（**必须写 Windows 绝对路径**），直接 `git push` 就行 |

取 GitHub token（脚本里用这一行）：

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null \
  | grep '^password=' | cut -d= -f2)
```

**token 过期怎么办**：`gho_` 是 OAuth 短期凭据，GCM 会在失效后弹一次登录（`git push` 或
`git fetch` 时触发）。想强制重新认证：

```bash
printf 'protocol=https\nhost=github.com\n\n' | git credential reject
```

**没有 gh CLI**，所有 GitHub 操作走 REST API + curl。

---

## 二、环境前提

- Node ≥ 22（本机用托管版 `C:/Users/<你>/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`）
- `ffmpeg` 在 PATH（全量测试里有几条 e2e 要它；缺了会挂 `spawn ffmpeg ENOENT`）
- 工作目录：仓库根
- **npm 账号没开强制 2FA**（实测 `npm publish` 不索要 OTP）。哪天开了，publish 会卡在
  `Enter OTP:`，要加 `--otp=<6位数>`
- 仓库 remote 走 SSH：`git@github.com:SAOS-3624/dsh-video-storyboard.git`

---

## 三、改版本号：只有两处，必须同步

```
package.json        "version": "0.6.5"
dsh.plugin.json     "version": "0.6.5"
```

没有第三处。改完自查：

```bash
python -c "
import json
for f in ['package.json','dsh.plugin.json']:
    print(f, json.load(open(f,encoding='utf-8'))['version'])
"
```

---

## 四、写 CHANGELOG

在 `CHANGELOG.md` 顶部插入新段，格式跟上一版对齐：

```md
## [0.6.5] - 2026-11-03

> 主题：**一句话抓住这一版的核心**。后面两三句把"为什么"说清；
> 如果基线（`strategy:auto` 的默认代价 / `pack.solve` 排布口径 / 图片 token 换算）
> 一处没动，就在这儿明写 —— 接着提 PR 的人需要知道。

### Added / Changed / Fixed

- **一条一句粗体结论**（issue 号 / PR 号 / @作者）。为什么不这么做、实测数字。
```

约定：**结论在前、数字在后**；有实测就写实测（文件数、字符数、通过条数），没数字的改动
说明为什么值得进这一版。

---

## 五、发布前四道闸（一条都不能跳）

```bash
# 1. 语法（当前 71 个文件）
node scripts/check-syntax.mjs

# 2. 全量测试（当前 505 条；约 50~80 秒）
#    必须隔离两个环境变量，否则会读到你自己的缓存/媒体目录
export DSH_HOME="$PWD/.tmp-dsh"
export DSH_VIDEO_CACHE_DIR="$PWD/.tmp-cache"
node --test

# 3. 打包内容（当前 101 文件 / 1.8 MB）
npm pack --dry-run | grep -E "test/|__pycache__|\.npmrc|total files|package size"
#    期望：没有 test/、没有 __pycache__、没有 .npmrc；total files 与上一版同量级

# 4. 工作区必须干净（`npm pack` 打包的是**磁盘文件**，不是 git 提交）
node scripts/guard-publish.mjs
```

> 第 3 步是历史教训：0.5.11 就是在"以为发的是提交"的误解下，把工作区里别人未提交的改动
> 一起打进了包。`files` 字段要写精确 glob，`examples` 这种目录名会顺手把 `__pycache__` 收进去。

---

## 六、提交 + 打 tag + 推送

```bash
rm -rf .tmp-dsh .tmp-cache
git add -A
git commit -m "release: 0.6.5 —— 一句话主题"

git push origin main
git tag -a v0.6.5 -m "0.6.5 —— 一句话主题"
git push origin v0.6.5
```

提交邮箱已在本仓库配成 `348517238+SAOS-3624@users.noreply.github.com`（GitHub noreply），
不必再改。

---

## 七、`npm publish` —— 这一节最容易翻车

```bash
npm publish --ignore-scripts
```

### 为什么加 `--ignore-scripts`

`package.json` 里有 `prepublishOnly: "node scripts/guard-publish.mjs && npm test"`。
`npm publish` 会**自动重跑一遍**：guard + 全量 505 条测试。

实测：3 分 43 秒才跑到第 450 条，**看起来像卡死**（不是在等 OTP）。第一次发 0.6.5 时
就是这么误判、被 kill 掉的（退出码 143）。

因为第五节已经手动跑过 guard 和全量测试，这一步是纯重复，用 `--ignore-scripts` 跳过。

### 怎么判断是不是真卡住

```bash
ps -ef | grep "npm publish" | grep -v grep
ps -ef | grep "node --test" | grep -v grep   # 有子进程 = 正在跑测试，不是卡死
```

### 返回码

| 现象 | 含义 | 处理 |
|---|---|---|
| `+ dsh-video-storyboard@0.6.5` + 退出码 0 | 成功（可能进暂存） | 去第八节验证 |
| `Your package is being processed...` | **暂存（202），不是失败** | 等，别重发 |
| `409 Cannot publish over previously staged version` | 上次其实已经收下了 | 等它上线，**不要改版本号重发** |
| `403 Forbidden` / `ENEEDAUTH` | token 失效或没登录 | `npm whoami` 确认是 `saos_3624` |

---

## 八、验证真的上线了（三件都成立才算）

```bash
# ① dist-tags 指向新版本
npm view dsh-video-storyboard dist-tags --json

# ② 具体版本能取到（HTTP 200）
curl -s -o /dev/null -w "%{http_code}\n" \
  https://registry.npmjs.org/dsh-video-storyboard/0.6.5

# ③ 内容与本地一致
curl -s https://registry.npmjs.org/dsh-video-storyboard/0.6.5 | python -c "
import json,sys; d=json.load(sys.stdin)
print('shasum :', d['dist']['shasum'])
print('gitHead:', d.get('gitHead'))
print('files  :', d['dist'].get('fileCount'))
"
npm pack >/dev/null 2>&1 && sha1sum dsh-video-storyboard-*.tgz && rm -f dsh-video-storyboard-*.tgz
```

- `dist.shasum` 必须和本地 `npm pack` 的 sha1 **逐字一致**
- `gitHead` 必须是这次 release commit 的完整 SHA
- registry 元数据有 **40~100 秒延迟**；真进暂存时可能等十几分钟（0.2.6 实测 18 分钟）

---

## 九、GitHub Release

只给正式版建，不给预发布建。文案结构（对齐 v0.6.4）：

```
0.6.5 — 一句话主题

> 主题引语 + 基线有没有动

### Fixed / Added / Changed
- 结论（issue/PR/作者）+ 实测数字

### 验证
- 全量 node --test xxx/xxx
- 打包 xxx 文件 / x.x MB

安装：`npm i dsh-video-storyboard@0.6.5`
```

建 Release（用 API）：

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null \
  | grep '^password=' | cut -d= -f2)

python - <<'PY'
import json
body = open('release-body.md', encoding='utf-8').read()
json.dump({
    "tag_name": "v0.6.5",
    "name": "0.6.5 — 一句话主题",
    "body": body,
    "draft": False,
    "prerelease": False,
}, open('.rel.json','w',encoding='utf-8'), ensure_ascii=False)
PY

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  --data-binary @.rel.json \
  https://api.github.com/repos/SAOS-3624/dsh-video-storyboard/releases
```

发完把 `.rel.json` / `release-body.md` 删掉（虽然不含密钥，但没必要留在工作区）。

---

## 十、常见事故对照表

| 症状 | 根因 | 处理 |
|---|---|---|
| publish 半天没动静 | 在跑 `prepublishOnly` 的全量测试 | 看 `ps` 有没有 `node --test`；有就别 kill。下次加 `--ignore-scripts` |
| publish 后版本查不到 | 进暂存了（202） | 等 15~20 分钟再查，别重发 |
| `409 Cannot publish over previously staged version` | 同一版本发过两次 | 等上线；实在要改内容就升 patch 版本 |
| guard 报"工作区有未提交的改动" | `npm pack` 打包磁盘，脏工作区会被打进去 | 先 commit / stash |
| 包里有 `test/`、`__pycache__` | `files` 字段写宽了 | 改 `files` 为精确 glob，别写目录名 |
| `git push` 卡在认证 | OAuth token 过期 | `git credential reject` 后重试，GCM 会重新登录 |
| 全量测试挂 `spawn ffmpeg ENOENT` | 机器上没有 `ffmpeg` | 装 ffmpeg 或设 `DSH_FFMPEG_PATH` |
| 全量测试偶发 `ytdlp-discovery` 超时 | 该文件要扫 PATH + npx 缓存，并发下会抖 | 重跑；与本版改动无关时可以先记一笔 |

---

## 十一、给 agent 的最短路径

如果只是"按现有改动发一个小版本"，照这个顺序做完就行：

1. `package.json` + `dsh.plugin.json` 版本号 +1
2. `CHANGELOG.md` 顶部插入新段
3. 第五节四道闸全过
4. 第六节提交 + tag + push
5. `npm publish --ignore-scripts`
6. 第八节三项验证
7. 第九节建 Release
8. 把临时文件（`.tmp-*`、`*.tgz`、`.rel.json`）删干净，`git status` 必须为空
