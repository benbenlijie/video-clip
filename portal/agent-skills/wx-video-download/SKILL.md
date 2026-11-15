---
name: wx-video-download
description: 把视频号分享链接（weixin.qq.com/sph/…）解析并下载为本地 MP4，附 ffprobe 与 SHA-256 校验。Use when the user pastes a WeChat Channels/视频号 link and wants the file, or when the editing pipeline needs the source clip before transcription.
---

# 视频号素材下载 / WeChat Channels Ingest

这个技能解决一件事：**把 `https://weixin.qq.com/sph/<id>` 变成可剪辑的本地 MP4**，并且诚实报告拿到了什么、没拿到什么。

它被放在 `portal/agent-skills/wx-video-download/`，脚本在 `scripts/wx_video_dl.py`，MCP 工具在 `portal/server/wx-video-tools.mjs`。

## 先记住三条硬事实

1. **网页端没有媒体地址。** `weixin.qq.com/sph/...` 会 302 到 `channels.weixin.qq.com/finder-preview/pages/sph?id=...`。桌面浏览器只渲染「封面 + 可扫码前往微信观看」的二维码；页面调用的 `POST /finder-preview/api/feed/get_feed_info` 只返回标题、作者、封面、互动数据，**没有 media 字段**。换微信用 UA（Android / Windows / Mac）页面直接白屏。
2. **官方直链必须带微信登录态。** `finder.video.qq.com/251/20302/stodownload?encfilekey=…` 的签名由客户端会话签发。没有登录态时，任何「猜 URL」的做法都拿不到文件。
3. **因此本技能把「链接 → 直链」交给解析器**：一个持有已登录会话的服务，输入分享链接，返回带签名的直链。默认用内置公共解析器，可用 `WX_VIDEO_RESOLVER` 换成自建。**解析器是第三方：只把用户有权访问的公开链接发过去，不要把 cookie、登录态或私密内容传给任何解析器。**

## 什么时候用

- 用户贴了视频号链接，要求「下载 / 保存 / 拿到文件 / 做素材」。
- 剪辑流水线缺 `input.mp4`，且来源是视频号。
- 需要视频号素材的元数据（标题、作者、发布时间、封面）做归档或 brief。

不要用它做：批量爬取账号全部作品、下载无权保存的私密内容、绕过付费或地域限制。

## 一条命令跑通

```bash
# 只看元数据，不落盘
python3 portal/agent-skills/wx-video-download/scripts/wx_video_dl.py resolve "https://weixin.qq.com/sph/AEk8OfjLuG" --json

# 解析 + 下载 + 校验，默认写到 ~/Downloads/videos
python3 portal/agent-skills/wx-video-download/scripts/wx_video_dl.py download "https://weixin.qq.com/sph/AEk8OfjLuG" --json

# 指定目录与文件名，同时写一份元数据给后续剪辑用
python3 portal/agent-skills/wx-video-download/scripts/wx_video_dl.py download "<链接>" \
  --out ~/Downloads/videos --name "访谈-光羽" --meta ~/Downloads/videos/访谈-光羽.json --json
```

环境自检先跑一次：`… selfcheck --json`（确认 python、ffprobe、解析器地址）。

也可以直接吃直链：如果已经有 `https://.../stodownload?...` 这种签名地址，`download` 会跳过解析，直接下载。

## 解析器配置

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `WX_VIDEO_RESOLVER` | 解析器地址（POST JSON） | `https://video.zacao.top/api/parse` |
| `WX_VIDEO_RESOLVER_TOKEN` | 需要鉴权时发 `Authorization: Bearer …` | 空 |
| `WX_VIDEO_ALLOW_PUBLIC_RESOLVER` | 设为 `0` 时禁用内置公共解析器，强制自建 | `1` |
| `WX_VIDEO_OUT_DIR` | 默认输出目录 | `~/Downloads/videos` |
| `WX_VIDEO_FFPROBE` | ffprobe 路径覆盖 | `PATH` 里的 ffprobe |

解析器协议见 `references/resolver.md`：请求 `{"text": "<链接或口令>"}`（失败自动退回 `{"url": …}`），成功返回 `data.url` / `data.source_video_url` / `data.video_backup[]`。

**自建优先。** 生产环境不要把公共解析器当依赖：它会消失、会限流、会改名。自建一个持有会话的小服务，把 `WX_VIDEO_RESOLVER` 指过去即可，脚本不用改。

## 输出契约

`--json` 时 stdout 只有一个对象：

```json
{
  "ok": true,
  "path": "/abs/path/标题-作者.mp4",
  "bytes": 29278336,
  "sha256": "…",
  "durationSeconds": 651.264,
  "width": 1280,
  "height": 720,
  "videoCodec": "h264",
  "audioCodec": "aac",
  "verified": true,
  "title": "…",
  "author": "光羽的平行世界",
  "publishedAt": "2026-11-03T16:00:00+08:00",
  "videoId": "AEk8OfjLuG",
  "resolver": "https://video.zacao.top/api/parse",
  "sourceLink": "https://weixin.qq.com/sph/AEk8OfjLuG"
}
```

失败时：`{"ok": false, "error": "…", "code": "resolve-failed|expired-url|no-video-stream|…"}`。
退出码：`0` 成功 / `2` 解析失败 / `3` 下载失败 / `4` 校验失败 / `5` 参数或环境错误。人类可读日志一律走 stderr。

## 验证门（不要跳过）

1. `verified: true`：ffprobe 能读出至少一条视频流。`false` 说明本机没有 ffprobe，只做了 MP4 容器头检查——要在报告里说清楚。
2. 时长和分辨率写进报告；用户给的是「一个视频」时，不要让 2 秒的错误页混过去。
3. 想确认「下对了」，抽一帧看画面：
   ```bash
   ffmpeg -v error -ss 30 -i "<路径>" -frames:v 1 /tmp/frame.jpg
   ```
   然后真的看这张图，不要用文件大小或退出码代替。
4. 目标在 SMB/移动硬盘时，复制后比对 sha256，避免半截文件。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `resolver-http 401/403` | 公共解析器要鉴权或已下线 | 换 `WX_VIDEO_RESOLVER` 自建；或让用户提供文件 |
| `resolve-failed` / `no-media-url` | 直播回放、图文、或需要登录的内容 | 直接告诉用户拿不到，说明原因；不要反复重试 |
| `expired-url` | 直链 5–30 分钟过期 | 重新解析再下（脚本每次都会重新解析） |
| `download-denied 403` | 签名过期或 IP/UA 不符 | 重新解析；确认没开全局代理导致出口 IP 变化 |
| 下到的是 HTML/JSON | 链接失效，返回了错误页 | 脚本会按 `expired-url` 报错，重新解析 |
| 只有 720p | 解析器只给了一档 | 在报告里写明清晰度；不要假装是 1080p |

## 拿不到文件时的降级路径

按顺序尝试，并如实说明每一步的结果：

1. 换自建解析器（如果用户有会话）。
2. 让用户在微信里打开视频，用本机抓包（mitmproxy + 系统代理 + 根证书）截获直链；这会改动系统代理，必须先取得同意，结束后恢复。
3. 让用户直接提供文件，本技能只做 `probe` 和归档。

**永远不要**为了「看起来成功」而编造路径、时长或分辨率。

## MCP 工具

`portal/server/wx-video-tools.mjs` 把同一套能力包成 stdio MCP server：

- `mcp__wxvideo__resolve_video({ link })`
- `mcp__wxvideo__download_video({ link, fileName?, subdir? })` — 默认写进工作区 `downloads/`
- `mcp__wxvideo__probe_video({ path })`

注册示例：

```json
{ "mcpServers": { "wxvideo": { "command": "node", "args": ["portal/server/wx-video-tools.mjs", "/abs/workdir", "/abs/workdir/.audit/wx-video.jsonl"] } } }
```

它复用同一份 Python 脚本，因此解析器、命名、校验、退出码与 CLI 完全一致。
