---
name: baidu-pan-download
description: 用浏览器里已有的登录态调百度网盘网页接口，把分享链接或网盘目录里的文件直接下载到本地，不安装百度网盘客户端。Use when the user pastes a pan.baidu.com share link (with or without 提取码) and wants the file(s) on disk, when they ask to download from 百度网盘/网盘/pan, or when the editing pipeline needs source clips out of the user's own 网盘 folder.
---

# 百度网盘免客户端下载 / Baidu Pan Ingest

这个技能解决一件事：**把 `pan.baidu.com/s/...`（或 `/我的资源/xxx` 这样的网盘路径）变成本地文件**，
不装百度网盘客户端、不装任何第三方客户端二进制，只用本机浏览器里已经登录的 Cookie 走网页接口。

它住在 `portal/agent-skills/baidu-pan-download/`，脚本是 `scripts/baidu_pan_dl.py`，
MCP 工具在 `portal/server/baidu-pan-tools.mjs`。接口细节和踩过的坑在 `references/api-notes.md`。

## 先记住三条硬事实

1. **网页接口给的是普通 HTTP 直链，这才是免客户端的根据。** `POST/GET` 几个 JSON 接口拿到
   `dlink`，就是一个支持 Range 的 URL，多线程分段能跑到带宽上限（实测 8~36 MB/s）。不需要客户端协议。
   客户端在很多场景只是「官方允许我下」的通行证，不是技术必需。
2. **直链和 UA 绑定。** 下载时必须用 `User-Agent: pan.baidu.com`（或 `netdisk`），
   用浏览器 UA 会稳定拿到 `403 {"error_code":31326,"hitcode:119}`。这是整件事最容易踩的坑：
   API 请求用浏览器 UA 没问题，**文件流必须换 UA**。脚本已经分开了，不要「统一一下 UA」。
3. **登录态只在本机，不经过任何第三方。** 脚本从 Chrome/Chromium/Edge/Brave 的 `Cookies` 库里
   解出 `BDUSS` + `STOKEN`（Linux 上是 AES-128-CBC + PBKDF2，密钥来自 `peanuts` 或系统钥匙串），
   缓存在 `~/.cache/baidu-pan-download/cookies.json`（600 权限，6 小时过期）。
   任何情况下都不要把 Cookie 发给别人的服务或贴进对话。

## 什么时候用

- 用户贴了 `pan.baidu.com/s/...`（常带 `?pwd=xxxx` 或 `提取码: xxxx`），要「下载/保存/拿到文件」。
- 用户说「从我网盘里拿 XX 到本地」，给的是网盘路径。
- 剪辑流水线缺素材，来源是网盘。

不要用它做：批量抓取别人整个网盘、下载你没有权限访问的内容、绕过付费/会员限制。
**别人的分享会先「转存」到你自己的网盘再下载**，这会占用你的网盘空间 —— 大文件先跟用户说一声。

## 一条命令跑通

```bash
S=portal/agent-skills/baidu-pan-download/scripts/baidu_pan_dl.py

python3 $S selfcheck --json                    # 环境 + 登录态（先跑这个）
python3 $S whoami --json                       # 账号 / 会员 / 容量
python3 $S list "<链接或路径>" --videos --json   # 先看有什么、多大
python3 $S download "<链接或路径>" --videos --out ~/Downloads/videos --json
```

挑文件：

```bash
python3 $S download "<链接>" --match "香港" --json      # 文件名包含「香港」的
python3 $S download "<链接>" --index 1,3,5 --json       # 按列举顺序挑第 1/3/5 个
python3 $S download "<链接>" --pick 5 --videos --json   # 前 5 个视频
python3 $S download "<链接>" --dry-run --json           # 只列出，不落盘
```

本机没有登录态时：

```bash
BAIDU_BDUSS=... BAIDU_STOKEN=... python3 $S download ...   # 环境变量
python3 $S download ... --cookie-file ~/bd-cookies.json    # 或 {"BDUSS":"…","STOKEN":"…"}
```

## 输出契约

`--json` 时 stdout 只有一个对象，日志全走 stderr：

```json
{
  "ok": true,
  "outDir": "/abs/out",
  "downloaded": [
    {"name":"x.mp4","path":"/abs/out/x.mp4","bytes":133821472,"skipped":false,
     "elapsed":26.0,"durationSeconds":125.78,"width":1080,"height":1920,
     "videoCodec":"h264","audioCodec":"aac","verified":true}
  ],
  "failed": [],
  "bytes": 133821472,
  "transferredTo": "/来自分享/知识流程科普"
}
```

失败时 `{"ok": false, "error": "…", "code": "not-logged-in|share-gone|need-password|dlink-failed|transfer-failed|range-failed|size-mismatch|verify-failed"}`。
退出码：`0` 成功 / `2` 分享或登录失败 / `3` 下载失败 / `4` 校验失败 / `5` 参数或环境错误。

## 验证门（不要跳过）

1. `verified: true` 表示 ffprobe 读到了视频流；`false` 说明没读到 —— 要在报告里说清楚，不要含糊过去。
2. 大小必须等于远端 `size`（脚本自己会卡，不一致会 `size-mismatch` 退出）。
3. 想确认「下对了」，抽一帧看画面：
   ```bash
   ffmpeg -v error -ss 30 -i "<路径>" -frames:v 1 /tmp/frame.jpg
   ```
   然后真的看这张图。文件大小和退出码都不能代替「画面是对的」。
4. 目标在 SMB/移动硬盘时，`--sha256` 比对一次，避免半截文件。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `403 hitcode:119` | 下载用了浏览器 UA | 文件流必须 `User-Agent: pan.baidu.com`；脚本已分开，别合并 |
| `403 hitcode:104` | UA 是 `netdisk;P2SP;...` 这类老客户端 UA | 只用 `pan.baidu.com` |
| `not-logged-in` | Cookie 过期或被清 | 让用户在 Chrome 登录 pan.baidu.com，再 `--refresh-cookies` |
| `no-login` | 本机浏览器里没有百度 Cookie | 换 `--cookie-file` 或环境变量；不要猜 Cookie |
| `need-password` | 链接没带 `pwd` | 让用户补 `?pwd=xxxx`；`/share/verify` 遇到验证码就没法自动过 |
| `share-gone` | 分享被取消/过期 | 直接告诉用户，不要反复重试 |
| `transfer-failed errno=12` | 对方关闭了转存 | 说明拿不到，请对方开转存或直接发文件 |
| `transfer-failed errno=-33` | 你的网盘满了 | 先清理或换 `--pan-dir` |
| `filemetas` 里的 `md5` 对不上 | **那个字段不是 MD5**，是文件令牌 | 别拿它校验；校验用 size + ffprobe |
| 目录被当成视频 | 百度给目录的 `category` 也是 6 | 脚本已按 `isdir` 排除；手写请求时注意 |
| `share/list` 报 `errno=2` | `dir` 要传**所有者网盘里的绝对路径**，不是相对分享根 | 从根列表的 `path` 字段拿绝对路径再递归 |
| 下载到一半断了 | 直链 `expires=8h`，也会被限流 | 直接重跑，脚本会按大小跳过已完成的文件 |

## 拿不到文件时的降级路径

按顺序试，并如实说明每一步结果：

1. 让用户在浏览器里打开一次分享、点一下下载（有时能刷新 `BDCLND`，转存就通了）。
2. 让对方把文件改成「公开分享 + 允许转存」，或直接发到别的渠道。
3. 让用户直接提供文件，本技能只做 `probe` 和归档。

**永远不要**为了「看起来成功」而编造路径、时长或分辨率。

## MCP 工具

`portal/server/baidu-pan-tools.mjs` 把同一套能力包成 stdio MCP server：

- `baidu_pan_whoami({})` — 账号、会员、容量
- `baidu_pan_list({ target, videosOnly?, limit? })` — 列分享或网盘目录
- `baidu_pan_download({ target, subdir?, pick?, index?, match?, videosOnly?, jobs?, force?, dryRun?, panDir? })` — 默认写进工作区 `downloads/`
- `baidu_pan_probe({ path })` — ffprobe 检查

注册示例：

```json
{ "mcpServers": { "baidu-pan": { "command": "node",
  "args": ["portal/server/baidu-pan-tools.mjs", "/abs/workdir", "/abs/workdir/.audit/baidu-pan.jsonl"] } } }
```

它复用同一份 Python 脚本，所以 Cookie 来源、命名、分片、校验、退出码与 CLI 完全一致。
离线回归：`node server/baidu-pan-tools.verify.mjs`（本地假 pan 服务，覆盖列目录→直链→分片→校验→越界拒绝）。
