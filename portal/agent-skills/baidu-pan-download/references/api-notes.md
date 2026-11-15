# 百度网盘网页接口笔记（2026-11 实测）

这份笔记记录的是「为什么脚本要这么写」。接口会变，遇到新行为先在这里补一行，再改脚本。

## 1. 端点一览

| 用途 | 方法与路径 | 关键参数 | 备注 |
| --- | --- | --- | --- |
| 登录校验 | `GET /rest/2.0/xpan/nas?method=uinfo` | — | 返回 `uk`、`baidu_name`、`vip_type`（2 = 超级会员） |
| bdstoken | `GET /api/gettemplatevariable` | `fields=["bdstoken",…]` | 写操作用，会变 |
| 会员 | `GET /rest/2.0/membership/user?method=query` | — | `current_product.detail_cluster` = svip/vip |
| 容量 | `GET /api/quota` | `checkfree=1&checkexpire=1` | 返回的是字节数 |
| 打开分享 | `GET /s/<surl>?pwd=xxxx` | — | 页面里能找到 `"shareid":<num>` 与 `"share_uk":"<uk>"`，同时下发 `BDCLND` |
| 提取码校验 | `POST /share/verify?surl=<surl>` | form: `pwd`、`v`（验证码） | 有验证码就没法自动过，别硬试 |
| 列分享 | `GET /share/list` | `shareid`、`uk`、`dir`、`root=1`、`page`、`num` | **`dir` 是所有者网盘里的绝对路径** |
| 列自己网盘 | `GET /api/list` | `dir`、`start`、`limit` | 错误码 `-9` = 路径不存在 |
| 转存 | `POST /share/transfer` | `shareid`、`from`、`sekey`、`fsidlist`、`path`、`bdstoken`、`ondup=newcopy`、`async=1` | `sekey` = `decodeURIComponent(BDCLND)` |
| 取直链 | `GET /api/filemetas` | `target=[…]` 的 JSON、`dlink=1` | 一次别超过 20 个路径 |
| 建目录 | `POST /api/create` | `a=commit`、`path`、`isdir=1`、`bdstoken` | `-8` = 已存在，可忽略 |
| 删除 | `POST /api/filemanager` | `opera=delete`、`filelist=[…]`、`bdstoken` | 清理测试目录用 |

所有请求都带 `app_id=250528&web=1&clienttype=0`，Cookie 至少要有 `BDUSS` + `STOKEN`。

## 2. Cookie：为什么脚本要自己解

- Chrome Linux 存的 `encrypted_value` 前缀是 `v10`/`v11`，正文是 **AES-128-CBC**，
  key = `PBKDF2-HMAC-SHA1(password, "saltysalt", 1 次, 16 字节)`，IV = 16 个空格 `0x20`。
- `password` 两种来源：没有钥匙串时是固定串 `peanuts`；启用了 libsecret 时是钥匙串里
  label 为 `Chrome Safe Storage`、schema 以 `chrome_libsecret_os_crypt_password` 开头的那条的 secret。
  脚本两个都试，能解出可打印 ASCII 才算成功。
- **新版本 Chrome 会在明文前加 32 字节 `sha256(host_key)`**。不解掉的话，解出来是「乱码 + 真值」，
  看起来像解密失败。判定方法：明文前 32 字节等于 `sha256(host_key)` 就切掉。
- 还有 `v20` 前缀（App-Bound 加密），Linux 上目前不处理，遇到就报错让用户手工给 Cookie。
- 浏览器运行时会锁 `Cookies` 库，**先 `copy2` 到临时目录再用 `file:…?mode=ro` 打开**，别直接开原库。

## 3. 直链与 UA（最容易翻车的地方）

- `filemetas` 返回的 `dlink` 形如 `https://d.pcs.baidu.com/file/<token>?fid=…&sign=…&expires=8h`。
- 直接 GET 会 **302** 到 `*.baidupcs.com` 的 CDN 地址；**必须跟随重定向**（curl 要 `-L`，
  requests 默认跟）。不跟随只会拿到 50 字节的 `{"error_code":302}`，很容易误判成「链接坏了」。
- 下载请求的 `User-Agent` 必须是 `pan.baidu.com`。浏览器 UA 会被拒：
  `403 {"error_code":31326,"error_msg":"user is not authorized","hitcode":119}`。
  老客户端 UA（`netdisk;P2SP;…`）会拿到 `hitcode:104`。
- 支持 Range（`206 Partial Content`）。单连接常见 2~4 MB/s，8~10 连接聚合能到 12~36 MB/s。
- 一个 `dlink` 有效约 8 小时；过期重新 `filemetas` 即可。

## 4. `share/list` 的 `dir` 语义

第一次很容易写错：分享根目录用 `dir=/&root=1` 列，返回的条目里带
`"path":"/自媒体/个人IP视频号/知识流程科普"` —— 这是**分享者网盘里的绝对路径**。
下钻时要把 `dir` 直接传这个绝对路径、并且**不要**带 `root=1`：

```
GET /share/list?shareid=…&uk=…&dir=/自媒体/个人IP视频号/知识流程科普      -> 子目录列表
GET /share/list?shareid=…&uk=…&dir=/知识流程科普                          -> errno 2
```

`errno=2` 就是「路径不对」，不是「分享失效」。

## 5. 「md5」是假的

`filemetas`（以及 `file_list`）里的 `md5` 字段，对第三方调用方返回的其实是**文件令牌**
（和 `dlink` 里的 token 一致），不是真实 MD5。拿它做校验会 100% 失败。
真实完整性靠：远端 `size` 与本地区块写入后的 `st_size` 相等 + `ffprobe` 能读出流 + 需要时本地算 SHA-256。

## 6. 转存行为

- 别人的分享不能直接 `filemetas`，必须先 `share/transfer` 到自己网盘，再按自己网盘的路径取直链。
- `sekey` 来自 `BDCLND` Cookie（URL 解码一次）；没打开过分享页时这个 Cookie 可能不存在。
- `async=1` 时转存是异步的，文件要等 1~2 秒才出现在目录里 —— 脚本会轮询最多 30 秒。
- 已知错误码：`2` 同名文件已存在/路径非法，`12` 转存被拒（对方关闭了转存），`-33` 空间不足。
- 转存会占用**你自己**的网盘配额，大文件先跟用户确认。

## 7. 自检清单

```bash
python3 …/baidu_pan_dl.py selfcheck --json   # crypto / ffprobe / 登录 / 会员
node portal/server/baidu-pan-tools.verify.mjs  # 离线全链路（假 pan 服务）
```

离线验证脚本会故意用浏览器 UA 打一次 `dlink` 并断言 403 —— 防止以后有人把 UA 统一成浏览器 UA。
