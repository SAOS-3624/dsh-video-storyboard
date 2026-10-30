# Setup · Reading web links

> For two audiences: local users who want the URL mode, and anyone cloning this from GitHub.
> If you only ever pass local files (`video_storyboard({ input: "D:/a.mp4" })`), you can skip this document entirely.

---

## 1. What you need

| Dependency | Local files | URL mode | Notes |
|---|---|---|---|
| **ffmpeg** | ✅ required | ✅ required | 7.0+, on `PATH`, under `$DSH_HOME/tools/ffmpeg/bin`, or via `DSH_FFMPEG_PATH` |
| **yt-dlp** | — | ✅ required | Resolves direct URLs and pulls the low-res copy. **Never bundled.** |
| **cookies.txt** | — | ✅ required | Login is required by default (see §3) |

Installing ffmpeg is covered in `USAGE.md`.

---

## 2. Installing yt-dlp

### Windows

```powershell
pip install --user -U yt-dlp
```

⚠️ The script lands in `%APPDATA%\Python\Python3xx\Scripts`, which is **usually not on `PATH`**. The plugin looks in this order:

1. `yt-dlp` / `yt-dlp.exe` on `PATH`
2. `%APPDATA%\Python\Python3xx\Scripts\yt-dlp.exe`
3. Whatever `DSH_YTDLP_PATH` points to

If none of them exist it fails loudly with the install command — it never silently degrades into "feature unavailable".

Other options:

```powershell
winget install yt-dlp     # single binary, on PATH — recommended
```

### macOS / Linux

```bash
brew install yt-dlp        # macOS
pipx install yt-dlp        # cross-platform, isolated — recommended
sudo apt install yt-dlp    # Debian/Ubuntu (may lag behind)
```

### How big

| Method | Size |
|---|---|
| `pip install` | **~25 MB** (`yt_dlp/` package) + 0.1 MB launcher |
| Standalone `yt-dlp.exe` | ~17 MB (bundles the Python runtime) |

**This is a user-side dependency, not plugin weight.** The plugin's `package.json` still has zero dependencies.

### Verify

```bash
yt-dlp --version          # expect a date-based version, e.g. 2026.10.26
```

---

## 3. Exporting cookies.txt

### Why you cannot just read the browser's cookie jar

Chromium 127+ ships **App-Bound Encryption**. Key cookies such as `SESSDATA` are stored with a `v20` prefix, whose key is bound to the browser process identity and can only be decrypted through the `IElevator` COM interface.

Measured on Windows 11 + Edge:

| Cookie | Prefix | Decryptable by a normal process |
|---|---|---|
| `enable_web_push` / `LIVE_BUVID` / `theme_style` | `v10` | ✅ |
| **`SESSDATA`** / `bili_jct` / `DedeUserID` / `buvid3` | **`v20`** | ❌ |

So `yt-dlp --cookies-from-browser chrome/edge` fails with `Failed to decrypt with DPAPI`. **That is not a misconfiguration** — the mechanism changed. Export a file instead.

### Steps

1. Install the **Cookie-Editor** extension (by cgagnier; available for Chrome and Edge)
2. Open and sign in to `example.com`
3. Click the extension → **Export** (bottom right) → choose **Netscape**
4. Save as `cookies.txt`

You should get a **Netscape HTTP Cookie File** that looks like this:

```
# Netscape HTTP Cookie File
.example.com	TRUE	/	FALSE	1799999999	<session-cookie-name>	<value>
.example.com	TRUE	/	FALSE	1799999999	<second-cookie>	<value>
```

⚠️ **This file is equivalent to your session credentials.** Never commit it. Keep it under `.secrets/` or anywhere covered by `.gitignore`.

### Where to put it

```bash
# Option A: environment variable (recommended)
setx DSH_VIDEO_COOKIES "D:\path\to\cookies.txt"

# Option B: pass it per call
video_storyboard({ input: "...", cookies: "D:/path/to/cookies.txt" })
```

### Config file — on Desktop, use this instead of setx

**DSH Desktop cannot read environment variables set with `setx`** (the ASR side already hit the same
wall). You can export `DSH_VIDEO_COOKIES` in a terminal and the plugin will still report "no cookies" —
not because it ignores it, but because it never sees it.

So configure through a file:

```json
// ~/.dsh/video.json
{
  "cookies": "D:/path/to/cookies.txt",
  "scanHeight": 360,
  "zoomHeight": 1080
}
```

Precedence: **tool argument > environment variable > `~/.dsh/video.json`**.

A missing cookie no longer raises an error: the plugin probes anonymously first and proceeds if the
source already offers the target tier (plenty of videos do, even anonymously). Only when it cannot does
it mark `degraded` and add a note.

### Expiry

`SESSDATA` typically lasts a few months. When it lapses yt-dlp reports a `Sign in` / `login` message; the plugin recognises it and tells you to re-export instead of dumping raw stderr.

---

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_YTDLP_PATH` | auto-discovered | Path to the yt-dlp binary |
| `DSH_VIDEO_COOKIES` | none | Path to cookies.txt |
| `DSH_VIDEO_MEDIA_DIR` | `os.tmpdir()/dsh-video-storyboard/media` | Where the low-res copy is cached |
| `DSH_VIDEO_MEDIA_MAX_MB` | `300` | Media cache cap; evicts oldest by mtime |
| `DSH_FFMPEG_PATH` | auto-discovered | ffmpeg path; explicit value wins over `DSH_HOME`/PATH lookup |

---

## 5. Verification order

Work through these in order — when something breaks you will know exactly which layer it is.

```bash
# 1. Is yt-dlp there, and is the version sane?
yt-dlp --version

# 2. Can it list formats? (no download, no cookies needed)
yt-dlp -F "<a URL you are allowed to download>"

# 3. Can it resolve a direct URL? (~2.6 s)
yt-dlp -g -f "bv*[height<=360]/b" "<same URL>"

# 4. Real download, 360p (~3 MB / 3 s)
yt-dlp -f "bv*[height<=360]+ba/b[height<=360]" -o "test.%(ext)s" \
  "<same URL>"

# 5. With cookies, check 1080p is visible (proves the login actually took)
yt-dlp --cookies "$DSH_VIDEO_COOKIES" -F "same URL"
```

### The format selector must use DASH syntax

**Many sites** hand back **DASH tracks** (video-only + audio-only) rather than one progressive mp4. When that happens:

```bash
-f "b[height<=360]"              # ❌ Requested format is not available
-f "bv*[height<=360]+ba"         # ✅ video track + best audio
-f "bv*[height<=360]"            # ✅ video only (for zoom — halves the bytes)
```

> **Per-site and per-video permissions vary a lot.** Which ladder you can actually reach depends on the
> site, the video, and whether you are signed in. That is why the default policy still prefers a
> cookie file when one is configured: it removes the "thought I got 1080p, actually got 360p"
> failure mode. Verify with `yt-dlp -F` before trusting a resolution.

---

## 6. Troubleshooting

| Symptom | Real cause | Fix |
|---|---|---|
| `yt-dlp not found` | Installed under `%APPDATA%\Python\...\Scripts`, not on `PATH` | Set `DSH_YTDLP_PATH` |
| `Requested format is not available` | Used progressive `b[height<=N]` syntax | Use `bv*[height<=N]+ba` |
| `Failed to decrypt with DPAPI` | Tried to read browser cookies (v20 encryption) | Export cookies.txt per §3 |
| `Sign in to confirm` / login required | Cookie expired or not passed | Re-export; check `DSH_VIDEO_COOKIES` |
| `HTTP Error 412` | Site risk control (rate limiting, missing UA) | Slow down; make sure a UA is sent |
| Download stuck at 0% | Network or CDN node | Retry; check proxy needs |
| Portrait video squashed | Rotation metadata not normalised | Fixed in 0.2.x — file a bug |
| Media dir keeps filling | Normal rolling within the 300 MB cap | Raise `DSH_VIDEO_MEDIA_MAX_MB` or clear it |
| Direct URL dies after ~2 h | Signed URLs expire | The plugin re-resolves once, then falls back to the low-res copy |

---

## 7. Privacy and compliance

- Video content stays in a local temp directory. **Never uploaded, never redistributed.**
- cookies.txt is only passed by path to the yt-dlp child process. **Never written into return values, logs, or the manifest.**
- Direct URLs are signed temporary credentials: cached for 90 minutes, then dropped. They never enter the persistent cache layer.
- Use it only for material you have the right to process. The plugin bundles no downloader, no search, and never caches or redistributes content.
