# 解析器协议与实现边界

本技能的下载能力依赖一个**外部解析器**把视频号分享链接换成签名直链。
理解这份协议，就能把默认的公共解析器换成自建服务，或者判断某次失败到底卡在哪一层。

## 1. 为什么要解析器

视频号网页端（`channels.weixin.qq.com/finder-preview`）对匿名访客只开放元数据：

```http
POST /finder-preview/api/feed/get_feed_info?_rid=<uuid>&_pageUrl=<encoded page url>
Content-Type: application/json
Origin: https://channels.weixin.qq.com
Referer: https://channels.weixin.qq.com/finder-preview/pages/sph?id=<shortId>
```

```json
{ "baseReq": { "generalToken": "" }, "shortUri": "AEk8OfjLuG" }
```

返回里只有 `feedInfo.description / coverUrl / createtime / likeCountFmt …` 和
`sceneInfo.dynamicExportId`，**没有 `media` / `videoUrl` / `encfilekey` 之外的可用直链**，
响应带 `sceneInfo.entryCardType`，页面据此渲染「扫码前往微信观看」。

真正可播放的地址形如：

```
https://finder.video.qq.com/251/20302/stodownload?encfilekey=…&token=…&idx=1&…
https://51.wxapp.tc.qq.com/251/20302/stodownload?encfilekey=…&token=…&sign=…
```

`encfilekey` + `token` + `sign` 由已登录的微信会话签发，几分钟到几十分钟后失效。
所以解析器的本质是：**它自己持有一个登录会话，替你向微信换一张短时门票。**

## 2. 请求

```
POST <resolver-url>
Content-Type: application/json
Authorization: Bearer <token>        # 可选，配 WX_VIDEO_RESOLVER_TOKEN
```

请求体（脚本会自动兼容两种写法）：

```json
{ "text": "3.21 复制打开微信… https://weixin.qq.com/sph/AEk8OfjLuG" }
```

脚本先发 `{"text": …}`（保留整段分享口令，很多解析器会自己正则提 URL）；
如果对方返回 4xx，再退回 `{"url": "https://weixin.qq.com/sph/AEk8OfjLuG"}`。

## 3. 响应

脚本接受以下任一形状，字段取到第一个可用值即停止：

```json
{
  "code": 200,
  "succ": true,
  "data": {
    "title": "标题",
    "desc": "完整描述",
    "url": "https://…/stodownload?…",
    "source_video_url": "https://…",
    "video_url": "https://…",
    "cover_url": "https://…",
    "video_id": "AEk8OfjLuG",
    "author": { "nickname": "…", "id": "…" },
    "author_name": "…",
    "video_backup": [
      { "label": "1080p", "codec": "h264", "url": "https://…" }
    ]
  }
}
```

判定规则：

- `succ === false` 或 `code ∉ {0, 200, null}` → 解析失败，`msg/message/error` 作为错误原因。
- 直链按 `url → source_video_url → video_url → play_url → mp4_url → video_backup[].url` 顺序取第一个 `http(s)`。
- 一个都取不到 → `no-media-url`（通常是直播回放、图文或需要登录的内容）。

## 4. 元数据补全

解析器常常只回直链，不回作者。脚本会额外调一次官方预览接口补 `author / publishedAt / stats / cover`：

- 匿名叫得通（带 `Origin` 头；不带时偶发 401）。
- 只补缺，不覆盖解析器已给的字段。
- 失败静默忽略，绝不阻塞下载。

## 5. 自建解析器的最低要求

1. 会话凭据放在服务端 secret（环境变量 / KMS），不要写进仓库或前端。
2. 对外只暴露 `POST /parse`（或同等路径），加访问令牌、限流和日志脱敏。
3. 不记录完整分享链接、直链、cookie。
4. 直链一拿到就返回，缓存控制在分钟级；过期链接重试没有意义。
5. 给调用方返回结构化的错误（非 2xx + `{"error": "..."}`），脚本会把 `msg/error` 原样带进报告。

自建后设置：

```bash
export WX_VIDEO_RESOLVER=https://your-resolver.example.com/api/parse
export WX_VIDEO_RESOLVER_TOKEN=…            # 需要时
export WX_VIDEO_ALLOW_PUBLIC_RESOLVER=0     # 彻底禁用内置公共解析器
```

## 6. 公共解析器

内置默认值 `https://video.zacao.top/api/parse` 是一个**公开的第三方服务**，匿名可用、无需 key。
它在本机可用，但这不构成任何可用性承诺：

- 可能限流、改协议、加鉴权或直接下线；
- 会把分享链接发到第三方；
- 只对公开内容有意义。

因此：**只在用户接受、且内容本就有权保存时使用**；生产/批量场景请自建。
设置 `WX_VIDEO_ALLOW_PUBLIC_RESOLVER=0` 可以在团队环境里硬性关掉它。

## 7. 直链本身

拿到直链后，脚本用下列请求头下载，缺一个都可能 403：

```
User-Agent: Mozilla/5.0 … Chrome/131 …
Referer:    https://channels.weixin.qq.com/
Accept-Encoding: identity
```

支持 `Range` 断点续传；服务端忽略 Range 时自动从头开始。
`401/403/404/410/451` 直接判死（重试无意义），其余错误按指数退避退避重试。
