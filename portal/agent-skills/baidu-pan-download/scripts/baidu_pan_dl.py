#!/usr/bin/env python3
"""baidu_pan_dl.py — 百度网盘免客户端下载器（video-clip 项目技能）

解决一件事：**给一个百度网盘分享链接（或你自己的网盘路径），把文件落到本地**，
不安装百度网盘客户端、不装第三方客户端二进制，只用浏览器里已经登录的 Cookie
调 pan.baidu.com 的网页接口。

为什么可以不用客户端：网页端给文件的 `dlink` 是普通 HTTP 直链，只要
1) 带正确的 Cookie（BDUSS + STOKEN），2) 用客户端 UA `pan.baidu.com`，
3) 支持 Range，就能多线程分段拉满带宽。真正卡人的不是协议，而是三件小事：
dlink 和 UA 绑定（用浏览器 UA 直接下会被 403 `hitcode:119`）、`filemetas`
返回的 "md5" 其实是文件令牌而不是真 MD5、以及 Chrome v10 Cookie 需要先从
系统钥匙串取密钥才能解。

子命令：
  selfcheck   环境 + 登录态自检
  whoami      当前账号、会员类型、容量
  list        列出分享 / 网盘目录（递归、只看视频）
  download    下载（分享链接或自己的网盘路径）
  probe       本地文件 ffprobe 信息

约定：人类可读日志走 stderr；`--json` 时 stdout 只有一个 JSON 对象，便于 MCP 包装。

退出码：0 成功 / 2 分享或登录失败 / 3 下载失败 / 4 校验失败 / 5 参数或环境错误
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable

try:
    import requests
except ImportError:  # pragma: no cover - 环境问题
    sys.stderr.write("缺少 requests：python3 -m pip install --user requests\n")
    raise SystemExit(5)

# ---------------------------------------------------------------- 常量

APP_ID = "250528"
API = os.environ.get("BAIDU_API_BASE", "https://pan.baidu.com").rstrip("/")
UA_BROWSER = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
# 下载直链必须用这个 UA。用浏览器 UA 会被 pcs 拒绝（403 hitcode:119）。
UA_PCS = "pan.baidu.com"

DEFAULT_OUT = os.path.expanduser("~/Downloads/videos")
CACHE_DIR = os.environ.get(
    "BAIDU_DL_CACHE", os.path.join(os.path.expanduser("~/.cache"), "baidu-pan-download")
)

VIDEO_EXT = {"mp4", "mov", "m4v", "mkv", "avi", "flv", "wmv", "ts", "webm", "m2ts", "mpg", "mpeg"}

EXIT_OK, EXIT_SHARE, EXIT_DOWNLOAD, EXIT_VERIFY, EXIT_USAGE = 0, 2, 3, 4, 5

CHUNK = 8 * 1024 * 1024
VIDEO_CATEGORY = "6"

# /share/transfer 的 errno 含义（实测 + 社区常见值），用来给出人话错误
TRANSFER_ERRNO = {
    2: "同名文件已存在或路径非法",
    4: "登录态或权限问题",
    12: "转存被拒绝（对方可能关闭了转存/分享已失效）",
    -33: "网盘空间不足",
}


class Fail(Exception):
    """带退出码和机器可读 code 的失败。"""

    def __init__(self, message: str, code: str = "failed", exit_code: int = EXIT_SHARE):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def log(msg: str) -> None:
    sys.stderr.write(f"{msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- Cookie 提取


def _aes_cbc_decrypt(data: bytes, key: bytes) -> bytes:
    """Chrome Linux 的 v10/v11 Cookie：AES-128-CBC，IV 是 16 个空格。"""
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        dec = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
        return dec.update(data) + dec.finalize()
    except ImportError:
        pass
    openssl = shutil.which("openssl")
    if not openssl:
        raise Fail("解 Cookie 需要 cryptography 或 openssl", "no-crypto", EXIT_USAGE)
    proc = subprocess.run(
        [openssl, "enc", "-d", "-aes-128-cbc", "-K", key.hex(), "-iv", (b" " * 16).hex()],
        input=data,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise Fail("openssl 解密失败", "decrypt-failed", EXIT_USAGE)
    return proc.stdout


def _keyring_password() -> bytes | None:
    """Chrome 在 Linux 上若使用 libsecret，密码存在登录钥匙串里。"""
    try:
        import secretstorage
    except ImportError:
        return None
    try:
        bus = secretstorage.dbus_init()
        col = secretstorage.get_default_collection(bus)
        if col.is_locked():
            col.unlock()
        for item in col.get_all_items():
            if item.get_label() == "Chrome Safe Storage":
                attrs = item.get_attributes()
                if attrs.get("xdg:schema", "").startswith("chrome_libsecret_os_crypt_password"):
                    return item.get_secret()
    except Exception:
        return None
    return None


def _decode_cookie(raw: bytes, host: str) -> str | None:
    """v10/v11 前缀 + 可选 32 字节 sha256(host) 前缀 + PKCS7。"""
    if raw[:3] not in (b"v10", b"v11"):
        if raw[:3] == b"v20":
            return None  # Chrome 的 App-Bound 加密，Linux 上暂不处理
        return None
    body = raw[3:]
    for password in filter(None, (b"peanuts", _keyring_password())):
        key = hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1, 16)
        try:
            plain = _aes_cbc_decrypt(body, key)
        except Fail:
            continue
        if not plain:
            continue
        pad = plain[-1]
        if 0 < pad < 17:
            plain = plain[:-pad]
        if plain[:32] == hashlib.sha256(host.encode()).digest():
            plain = plain[32:]
        try:
            text = plain.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if len(text) >= 10 and all(32 <= ord(c) < 127 for c in text):
            return text
    return None


def _browser_profiles() -> Iterable[tuple[str, Path]]:
    roots = [
        ("google-chrome", Path.home() / ".config/google-chrome"),
        ("chromium", Path.home() / ".config/chromium"),
        ("microsoft-edge", Path.home() / ".config/microsoft-edge"),
        ("brave", Path.home() / ".config/BraveSoftware/Brave-Browser"),
        ("vivaldi", Path.home() / ".config/vivaldi"),
    ]
    for label, root in roots:
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name != "Default" and not entry.name.startswith("Profile "):
                continue
            if (entry / "Cookies").is_file():
                yield f"{label}/{entry.name}", entry / "Cookies"


def extract_cookies_from_browser() -> tuple[dict[str, str], str]:
    """返回 ({host: value}, 来源描述)。只取百度域下需要的几个键。"""
    wanted = {"BDUSS": ".baidu.com", "STOKEN": ".pan.baidu.com", "PANPSC": ".pan.baidu.com"}
    for label, db in _browser_profiles():
        tmp = Path(tempfile.mkdtemp(prefix="bdck-")) / "Cookies"
        try:
            shutil.copy2(db, tmp)  # 运行中的浏览器会锁库，拷贝一份再读
        except OSError:
            continue
        try:
            con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
            rows = con.execute(
                "select host_key, name, encrypted_value, value from cookies "
                "where name in ('BDUSS','STOKEN','PANPSC') and host_key like '%baidu.com'"
            ).fetchall()
            con.close()
        except sqlite3.Error:
            continue
        finally:
            shutil.rmtree(tmp.parent, ignore_errors=True)

        found: dict[str, str] = {}
        for host, name, encrypted, plain in rows:
            value = plain or ""
            if not value and encrypted:
                value = _decode_cookie(encrypted, host) or ""
            if value and name not in found:
                found[name] = value
        if found.get("BDUSS") and found.get("STOKEN"):
            return found, label
    raise Fail(
        "浏览器里找不到百度登录态。请先在 Chrome 打开 pan.baidu.com 登录，"
        "或设置 BAIDU_BDUSS / BAIDU_STOKEN 环境变量、用 --cookie-file 指定。",
        "no-login",
    )


def load_credentials(cookie_file: str | None, refresh: bool = False) -> tuple[dict[str, str], str]:
    if cookie_file:
        return _read_cookie_file(cookie_file), f"file:{cookie_file}"
    env_bduss, env_stoken = os.environ.get("BAIDU_BDUSS"), os.environ.get("BAIDU_STOKEN")
    if env_bduss and env_stoken:
        return {"BDUSS": env_bduss, "STOKEN": env_stoken}, "env"

    cache = Path(CACHE_DIR) / "cookies.json"
    if cache.is_file() and not refresh:
        try:
            data = json.loads(cache.read_text())
            if time.time() - data.get("at", 0) < 6 * 3600 and data.get("cookies", {}).get("BDUSS"):
                return data["cookies"], f"cache:{data.get('source', '?')}"
        except (OSError, json.JSONDecodeError):
            pass

    cookies, source = extract_cookies_from_browser()
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"at": time.time(), "source": source, "cookies": cookies}))
        os.chmod(cache, 0o600)
    except OSError:
        pass  # 缓存写不了不影响主流程
    return cookies, source


def _read_cookie_file(path: str) -> dict[str, str]:
    text = Path(path).expanduser().read_text(errors="replace")
    if text.lstrip().startswith("{"):
        data = json.loads(text)
        if isinstance(data.get("cookies"), dict):
            return data["cookies"]
        if "BDUSS" in data:  # 扁平 {BDUSS, STOKEN}
            return {k: data[k] for k in ("BDUSS", "STOKEN", "PANPSC") if k in data}
        flat = {k: v for host, kv in data.items() if isinstance(kv, dict) for k, v in kv.items()}
        return {k: flat[k] for k in ("BDUSS", "STOKEN", "PANPSC") if k in flat}
    pairs: dict[str, str] = {}
    for chunk in re.split(r"[;\n]", text):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            pairs[k.strip()] = v.strip()
    if not pairs.get("BDUSS"):
        raise Fail(f"{path} 里没有 BDUSS", "bad-cookie-file", EXIT_USAGE)
    return pairs


# ---------------------------------------------------------------- 会话


class Pan:
    def __init__(self, cookies: dict[str, str], source: str):
        self.cookies = cookies
        self.source = source
        self.s = requests.Session()
        self.s.headers.update(
            {
                "User-Agent": UA_BROWSER,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer": "https://pan.baidu.com/",
            }
        )
        for host in (".baidu.com", ".pan.baidu.com", ".pcs.baidu.com"):
            self.s.cookies.set("BDUSS", cookies["BDUSS"], domain=host)
            self.s.cookies.set("STOKEN", cookies["STOKEN"], domain=host)
        if cookies.get("PANPSC"):
            self.s.cookies.set("PANPSC", cookies["PANPSC"], domain=".pan.baidu.com")
        self._uinfo: dict[str, Any] | None = None

    # -- 基础 ---------------------------------------------------------

    def get(self, path: str, **params: Any) -> dict[str, Any]:
        params.setdefault("clienttype", "0")
        params.setdefault("app_id", APP_ID)
        params.setdefault("web", "1")
        resp = self.s.get(API + path, params=params, timeout=30)
        try:
            return resp.json()
        except ValueError:
            raise Fail(f"{path} 返回了非 JSON（HTTP {resp.status_code}）", "bad-response")

    def post(self, path: str, data: dict[str, Any], **params: Any) -> dict[str, Any]:
        params.setdefault("clienttype", "0")
        params.setdefault("app_id", APP_ID)
        params.setdefault("web", "1")
        resp = self.s.post(API + path, params=params, data=data, timeout=30)
        try:
            return resp.json()
        except ValueError:
            raise Fail(f"{path} 返回了非 JSON（HTTP {resp.status_code}）", "bad-response")

    # -- 账号 ---------------------------------------------------------

    @property
    def info(self) -> dict[str, Any]:
        if self._uinfo is None:
            d = self.get("/rest/2.0/xpan/nas", method="uinfo")
            if d.get("errno") not in (0, None):
                raise Fail(
                    f"登录态无效（errno={d.get('errno')}）。请在浏览器重新登录 pan.baidu.com。",
                    "not-logged-in",
                )
            self._uinfo = d
        return self._uinfo

    @property
    def uk(self) -> str:
        return str(self.info.get("uk", ""))

    @property
    def bdstoken(self) -> str:
        d = self.get(
            "/api/gettemplatevariable",
            fields='["bdstoken","token","uk","isdocuser","servertime"]',
        )
        token = (d.get("result") or {}).get("bdstoken")
        if not token:
            raise Fail("拿不到 bdstoken，登录态可能已失效", "not-logged-in")
        return token

    def quota(self) -> dict[str, Any]:
        d = self.get("/api/quota", checkfree="1", checkexpire="1")
        return {"total": d.get("total"), "used": d.get("used"), "free": d.get("free")}

    def vip(self) -> dict[str, Any]:
        d = self.s.get(
            API + "/rest/2.0/membership/user", params={"method": "query", "clienttype": "0"}, timeout=30
        ).json()
        product = (d.get("current_product") or {}).get("detail_cluster", "")
        return {"vip_type": self.info.get("vip_type"), "cluster": product, "level": (d.get("level_info") or {}).get("current_level")}

    # -- 分享 ---------------------------------------------------------

    def resolve_share(self, link: str) -> dict[str, Any]:
        """分享链接 -> {surl, shareid, owner_uk, title, is_mine}"""
        text = link.strip()
        m = re.search(r"(?:pan\.baidu\.com/s/|baidu\.com/s/)([A-Za-z0-9_\-]+)", text)
        if not m:
            m = re.search(r"^\s*1[A-Za-z0-9_\-]{8,}", text)
            if not m:
                raise Fail(f"认不出分享链接：{link[:60]}", "bad-link", EXIT_USAGE)
        surl = m.group(1) if m.re.groups else m.group(0).strip()
        pwd = None
        q = re.search(r"[?&]pwd=([A-Za-z0-9]{4})", text)
        if q:
            pwd = q.group(1)
        else:
            q = re.search(r"(?:提取码|密码|pwd)[:：\s]*([A-Za-z0-9]{4})", text)
            if q:
                pwd = q.group(1)

        url = f"{API}/s/{surl}"
        html = self.s.get(url, params={"pwd": pwd} if pwd else None, timeout=30).text
        if "请输入提取码" in html or "share/init" in html:
            if not pwd:
                raise Fail("该分享需要提取码，请在链接里带上 ?pwd=xxxx", "need-password")
            self.post("/share/verify", {"pwd": pwd}, surl=surl, v="", logid=str(int(time.time() * 1000)))
            html = self.s.get(url, timeout=30).text

        shareid = re.search(r'"shareid":(\d+)', html)
        owner = re.search(r'"share_uk":"?(\d+)', html) or re.search(r'"uk":"?(\d+)', html)
        if not shareid or not owner:
            if "分享的文件已经被取消" in html or "不存在" in html:
                raise Fail("分享已失效或被取消", "share-gone")
            raise Fail("解析分享页失败（可能需要提取码或登录）", "share-unparsable")
        return {
            "surl": surl,
            "shareid": shareid.group(1),
            "owner_uk": owner.group(1),
            "is_mine": owner.group(1) == self.uk,
        }

    def share_list(self, shareid: str, uk: str, path: str, root: bool = False) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        while page <= 50:
            params = {
                "shareid": shareid,
                "uk": uk,
                "order": "name",
                "desc": "0",
                "showempty": "0",
                "page": str(page),
                "num": "100",
                "dir": path,
                "t": str(int(time.time() * 1000)),
                "channel": "chunlei",
                "logid": str(int(time.time() * 1000)),
            }
            if root:
                params["root"] = "1"
            d = self.get("/share/list", **params)
            errno = d.get("errno")
            if errno == 2:
                raise Fail(f"分享里没有这个路径：{path}", "path-not-found")
            if errno != 0:
                raise Fail(f"列举分享失败 errno={errno}", "share-list-failed")
            batch = d.get("list") or []
            items.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        return items

    def share_tree(self, ctx: dict[str, Any], path: str, root: bool = False, depth: int = 0) -> list[dict[str, Any]]:
        if depth > 8:
            return []
        out: list[dict[str, Any]] = []
        for it in self.share_list(ctx["shareid"], ctx["owner_uk"], path, root=root):
            node = _norm_item(it)
            out.append(node)
            if node["isdir"]:
                out.extend(self.share_tree(ctx, node["path"], root=False, depth=depth + 1))
        return out

    # -- 自己网盘 -----------------------------------------------------

    def list_dir(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        start = 0
        while start < 5000:
            d = self.get("/api/list", dir=path, order="name", desc="0", start=str(start), limit="1000", showempty="0")
            if d.get("errno") == -9:
                raise Fail(f"网盘里没有这个目录：{path}", "path-not-found")
            if d.get("errno") != 0:
                raise Fail(f"列举网盘目录失败 errno={d.get('errno')}", "list-failed")
            batch = d.get("list") or []
            items.extend(batch)
            if len(batch) < 1000:
                break
            start += 1000
        return items

    def walk(self, path: str, depth: int = 0) -> list[dict[str, Any]]:
        if depth > 8:
            return []
        out: list[dict[str, Any]] = []
        for it in self.list_dir(path):
            node = _norm_item(it)
            out.append(node)
            if node["isdir"]:
                out.extend(self.walk(node["path"], depth + 1))
        return out

    def mkdir(self, path: str) -> None:
        d = self.post(
            "/api/create",
            {"path": path, "isdir": "1", "block_list": "[]"},
            a="commit",
            bdstoken=self.bdstoken,
        )
        if d.get("errno") not in (0, -8):  # -8 = 已存在
            raise Fail(f"创建网盘目录失败 errno={d.get('errno')}", "mkdir-failed")

    def transfer(self, ctx: dict[str, Any], fsids: list[str], dest: str) -> dict[str, Any]:
        sekey = urllib.parse.unquote(self.s.cookies.get("BDCLND") or "")
        if not sekey:
            raise Fail("转存需要 BDCLND Cookie，请先在浏览器打开一次该分享链接", "no-sekey")
        d = self.post(
            "/share/transfer",
            {
                "fsidlist": json.dumps([int(x) for x in fsids]),
                "path": dest,
            },
            shareid=ctx["shareid"],
            **{
                "from": ctx["owner_uk"],
                "sekey": sekey,
                "ondup": "newcopy",
                "async": "1",
                "channel": "chunlei",
                "bdstoken": self.bdstoken,
            },
        )
        if d.get("errno") != 0:
            errno = d.get("errno")
            hint = TRANSFER_ERRNO.get(errno, "分享可能已取消、对方关闭了转存，或目标路径非法")
            raise Fail(
                f"转存失败 errno={errno}（{d.get('show_msg') or d.get('errmsg') or hint}）",
                "transfer-failed",
            )
        return d

    def wait_for(self, dest: str, names: list[str], timeout: float = 30.0) -> dict[str, dict[str, Any]]:
        """转存是异步的（async=1），文件要过一两秒才出现在目录里。"""
        deadline = time.time() + timeout
        landed: dict[str, dict[str, Any]] = {}
        while True:
            landed = {i["name"]: i for i in self.list_dir(dest)}
            if all(n in landed for n in names) or time.time() >= deadline:
                return landed
            time.sleep(1.5)

    def dlinks(self, paths: list[str]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for i in range(0, len(paths), 20):
            batch = paths[i : i + 20]
            d = self.get(
                "/api/filemetas",
                target=json.dumps(batch, ensure_ascii=False),
                dlink="1",
                fields="dlink,size,server_filename,fs_id",
            )
            if d.get("errno") != 0:
                raise Fail(f"取直链失败 errno={d.get('errno')}", "dlink-failed")
            for info in d.get("info") or []:
                path = info.get("path") or info.get("server_filename")
                if path:
                    out[str(info.get("server_filename"))] = info
                    out.setdefault(str(path), info)
        return out


def _norm_item(it: dict[str, Any]) -> dict[str, Any]:
    name = it.get("server_filename") or ""
    isdir = str(it.get("isdir")) == "1"
    return {
        "name": name,
        "path": it.get("path"),
        "size": int(it.get("size") or 0),
        "isdir": isdir,
        # 目录的 category 也是 6，所以必须先排除目录，否则文件夹会被算成视频
        "is_video": (not isdir)
        and (_is_video(name) or str(it.get("category")) == VIDEO_CATEGORY),
        "fs_id": str(it.get("fs_id") or ""),
        "mtime": int(it.get("server_mtime") or 0),
    }


def _is_video(name: str) -> bool:
    return name.rsplit(".", 1)[-1].lower() in VIDEO_EXT if "." in name else False


# ---------------------------------------------------------------- 下载


def fetch_range(url: str, cookie: str, start: int, end: int, tries: int = 4) -> bytes:
    last = ""
    for attempt in range(tries):
        try:
            resp = requests.get(
                url,
                headers={"User-Agent": UA_PCS, "Cookie": cookie, "Range": f"bytes={start}-{end}"},
                stream=True,
                timeout=120,
            )
            if resp.status_code == 206:
                return resp.content
            if resp.status_code == 200 and start == 0:
                return resp.content[: end + 1]
            last = f"HTTP {resp.status_code} {resp.text[:120]}"
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
        time.sleep(1.2 * (attempt + 1))
    raise Fail(f"分片 {start}-{end} 失败：{last}", "range-failed", EXIT_DOWNLOAD)


def download_file(
    pan: Pan,
    name: str,
    info: dict[str, Any],
    out_dir: Path,
    jobs: int = 8,
    force: bool = False,
) -> dict[str, Any]:
    size = int(info.get("size") or 0)
    url = info.get("dlink")
    if not url:
        raise Fail(f"{name} 没有直链", "no-dlink", EXIT_DOWNLOAD)
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / name
    if dest.exists() and dest.stat().st_size == size and not force:
        log(f"[skip] 已存在且大小一致：{name}")
        return {"name": name, "path": str(dest), "bytes": size, "skipped": True, "verified": True}

    part = dest.with_suffix(dest.suffix + ".part")
    cookie = f"BDUSS={pan.cookies['BDUSS']}; STOKEN={pan.cookies['STOKEN']}"
    parts = max(1, min(jobs, size // (4 * 1024 * 1024) or 1))
    span = size // parts
    ranges = [
        (i * span, size - 1 if i == parts - 1 else (i + 1) * span - 1) for i in range(parts)
    ]
    with open(part, "wb") as fh:
        fh.truncate(size)
    log(f"[start] {name}  {size / 1048576:.1f} MB  ({parts} 线程)")

    done = [0] * parts
    errors: list[str] = []

    def worker(idx: int, lo: int, hi: int) -> None:
        off = lo
        try:
            while off <= hi:
                upper = min(off + CHUNK - 1, hi)
                data = fetch_range(url, cookie, off, upper)
                if not data:
                    raise Fail("空分片", "empty-chunk", EXIT_DOWNLOAD)
                with open(part, "r+b") as fh:
                    fh.seek(off)
                    fh.write(data)
                done[idx] += len(data)
                off += len(data)
        except Exception as exc:  # noqa: BLE001 - 汇总后统一报
            errors.append(str(exc))

    started = time.time()
    with ThreadPoolExecutor(max_workers=parts) as pool:
        futures = [pool.submit(worker, i, lo, hi) for i, (lo, hi) in enumerate(ranges)]
        last = 0
        while any(not f.done() for f in futures):
            time.sleep(2)
            total = sum(done)
            if total > last:
                speed = (total - last) / 2 / 1048576
                log(f"        {total / size * 100:5.1f}%  {total / 1048576:7.1f}/{size / 1048576:.1f} MB  {speed:5.1f} MB/s")
                last = total
        for f in futures:
            f.result()
    if errors:
        raise Fail(f"{name} 下载失败：{errors[0]}", "download-failed", EXIT_DOWNLOAD)

    got = part.stat().st_size
    if got != size:
        raise Fail(f"{name} 大小不符：{got} != {size}", "size-mismatch", EXIT_VERIFY)
    os.replace(part, dest)
    elapsed = max(time.time() - started, 0.001)
    log(f"[done] {name}  {size / 1048576:.1f} MB  {elapsed:.0f}s  ({size / 1048576 / elapsed:.1f} MB/s)")
    return {"name": name, "path": str(dest), "bytes": size, "skipped": False, "elapsed": round(elapsed, 1)}


def probe(path: Path) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return {"ok": False, "error": "没有 ffprobe，只检查了文件大小"}
    proc = subprocess.run(
        [
            ffprobe, "-v", "error", "-print_format", "json",
            "-show_entries", "format=duration,size,format_name",
            "-show_entries", "stream=codec_type,codec_name,width,height",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or "ffprobe 无法解析").strip()[:200]}
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") or {}
    return {
        "ok": bool(video),
        "durationSeconds": round(float(fmt.get("duration") or 0), 3),
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "videoCodec": video.get("codec_name") if video else None,
        "audioCodec": audio.get("codec_name") if audio else None,
        "container": fmt.get("format_name"),
    }


# ---------------------------------------------------------------- 目标解析


def resolve_target(pan: Pan, target: str) -> dict[str, Any]:
    """把「分享链接」或「网盘路径」统一成 {kind, title, items}"""
    if re.search(r"(pan\.baidu\.com/s/|baidu\.com/s/)", target):
        ctx = pan.resolve_share(target)
        log(f"[share] shareid={ctx['shareid']} owner={ctx['owner_uk']} mine={ctx['is_mine']}")
        items = pan.share_tree(ctx, "/", root=True)
        title = next((i["name"] for i in items if i["isdir"]), None) or (
            items[0]["name"] if items else "分享"
        )
        return {"kind": "share", "title": title, "items": items, "share": ctx}

    path = target if target.startswith("/") else "/" + target
    items = pan.walk(path)
    return {
        "kind": "own",
        "title": path.rstrip("/").rsplit("/", 1)[-1] or "网盘",
        "items": items,
        "root": path,
    }


def flatten_files(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for i in items if not i["isdir"]]


def select_files(files: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    picked = files
    if getattr(args, "videos", False):
        picked = [f for f in picked if f["is_video"]]
    if getattr(args, "match", None):
        picked = [f for f in picked if args.match in f["name"]]
    if getattr(args, "index", None):
        wanted = {int(x) for x in str(args.index).split(",") if x.strip().isdigit()}
        picked = [f for i, f in enumerate(files, start=1) if i in wanted]
    if getattr(args, "pick", None):
        picked = picked[: args.pick]
    return picked


# ---------------------------------------------------------------- 命令


def cmd_whoami(pan: Pan) -> dict[str, Any]:
    info = pan.info
    v = pan.vip()
    return {
        "ok": True,
        "uk": pan.uk,
        "name": info.get("baidu_name"),
        "is_svip": info.get("vip_type") == 2,
        **v,
        "quota": pan.quota(),
        "cookieSource": pan.source,
    }


def cmd_list(pan: Pan, args: argparse.Namespace) -> dict[str, Any]:
    target = resolve_target(pan, args.target)
    files = flatten_files(target["items"])
    items = target["items"] if args.recursive or target["kind"] == "share" else target["items"]
    if args.videos:
        items = [i for i in items if i["isdir"] or i["is_video"]]
    if args.limit:
        items = items[: args.limit]
    return {
        "ok": True,
        "kind": target["kind"],
        "title": target["title"],
        "isMine": target.get("share", {}).get("is_mine"),
        "fileCount": len(files),
        "totalBytes": sum(f["size"] for f in files),
        "videoCount": sum(1 for f in files if f["is_video"]),
        "items": items,
    }


def cmd_download(pan: Pan, args: argparse.Namespace) -> dict[str, Any]:
    target = resolve_target(pan, args.target)
    files = flatten_files(target["items"])
    if not files:
        raise Fail("目标里没有文件", "empty")
    picked = select_files(files, args)
    if not picked:
        raise Fail("筛选后没有匹配的文件（检查 --videos / --match / --index）", "no-match", EXIT_USAGE)
    log(f"[pick] {len(picked)} 个文件，合计 {sum(f['size'] for f in picked) / 1073741824:.2f} GB")

    transferred = None
    if target["kind"] == "share" and not target["share"]["is_mine"]:
        dest = args.pan_dir or f"/来自分享/{target['title']}"
        pan.mkdir(dest)
        log(f"[transfer] 转存到 {dest}")
        pan.transfer(target["share"], [f["fs_id"] for f in picked], dest)
        landed = pan.wait_for(dest, [f["name"] for f in picked])
        refreshed = []
        for f in picked:
            node = landed.get(f["name"])
            if not node:
                raise Fail(f"转存后找不到 {f['name']}", "transfer-missing")
            refreshed.append(_norm_item(node))
        picked = refreshed
        transferred = dest

    if args.dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "files": [{"name": f["name"], "bytes": f["size"], "path": f["path"]} for f in picked],
            "transferredTo": transferred,
        }

    metas = pan.dlinks([f["path"] for f in picked])
    out_dir = Path(os.path.expanduser(args.out)).resolve()
    results, failures = [], []
    for f in picked:
        info = metas.get(f["path"]) or metas.get(f["name"])
        if not info:
            failures.append({"name": f["name"], "error": "拿不到直链"})
            continue
        info.setdefault("size", f["size"])
        try:
            res = download_file(pan, f["name"], info, out_dir, jobs=args.jobs, force=args.force)
            probe_result = probe(Path(res["path"])) if not args.no_probe else {}
            if probe_result and not probe_result.get("ok") and _is_video(f["name"]):
                raise Fail(f"{f['name']} 视频流校验失败：{probe_result.get('error')}", "verify-failed", EXIT_VERIFY)
            res.update({k: v for k, v in probe_result.items() if k != "ok"})
            res["verified"] = bool(probe_result.get("ok", True))
            if args.sha256:
                res["sha256"] = hashlib.sha256(Path(res["path"]).read_bytes()).hexdigest()
            results.append(res)
        except Fail as exc:
            log(f"[fail] {f['name']}: {exc}")
            failures.append({"name": f["name"], "error": str(exc), "code": exc.code})

    payload = {
        "ok": not failures,
        "outDir": str(out_dir),
        "downloaded": results,
        "failed": failures,
        "bytes": sum(r["bytes"] for r in results),
    }
    if transferred:
        payload["transferredTo"] = transferred
    if failures and not results:
        raise FailPayload(payload)
    return payload


class FailPayload(Exception):
    """下载全部失败：把已结构化的 payload 交给 main 输出。"""

    def __init__(self, payload: dict[str, Any]):
        super().__init__("download failed")
        self.payload = payload


def cmd_selfcheck(pan_factory) -> dict[str, Any]:
    checks: dict[str, Any] = {"ok": True}
    checks["python"] = sys.version.split()[0]
    checks["requests"] = requests.__version__
    try:
        import cryptography  # noqa: F401

        checks["crypto"] = "cryptography"
    except ImportError:
        checks["crypto"] = "openssl" if shutil.which("openssl") else "missing"
        if checks["crypto"] == "missing":
            checks["ok"] = False
    checks["ffprobe"] = shutil.which("ffprobe")
    try:
        cookies, source = load_credentials(None)
        checks["browser"] = source
        checks["cookieKeys"] = sorted(cookies)
        pan = Pan(cookies, source)
        info = pan.info
        checks["login"] = True
        checks["uk"] = pan.uk
        checks["name"] = info.get("baidu_name")
        checks["isSvip"] = info.get("vip_type") == 2
    except Fail as exc:
        checks["ok"] = False
        checks["login"] = False
        checks["error"] = str(exc)
    return checks


# ---------------------------------------------------------------- 入口


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="百度网盘免客户端下载器")
    parser.add_argument("--json", action="store_true", help="stdout 只输出一个 JSON 对象")
    parser.add_argument("--cookie-file", default=None, help="手工指定 BDUSS/STOKEN 文件")
    parser.add_argument("--refresh-cookies", action="store_true", help="忽略缓存，重新从浏览器取")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def common(sp):
        """子命令里也允许写 --json / --cookie-file，方便命令行和 MCP 包装追加参数。"""
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        sp.add_argument("--cookie-file", default=argparse.SUPPRESS)
        sp.add_argument("--refresh-cookies", action="store_true", default=argparse.SUPPRESS)
        return sp

    common(sub.add_parser("selfcheck", help="环境与登录态自检"))
    common(sub.add_parser("whoami", help="账号信息"))

    p_list = common(sub.add_parser("list", help="列目录 / 列分享"))
    p_list.add_argument("target", help="分享链接或网盘路径（/开头）")
    p_list.add_argument("--recursive", action="store_true", help="递归（网盘路径默认递归）")
    p_list.add_argument("--videos", action="store_true", help="只看视频")
    p_list.add_argument("--limit", type=int, default=0, help="最多返回多少条")

    p_dl = common(sub.add_parser("download", help="下载"))
    p_dl.add_argument("target", help="分享链接或网盘路径")
    p_dl.add_argument("--out", default=DEFAULT_OUT, help=f"本地目录（默认 {DEFAULT_OUT}）")
    p_dl.add_argument("--pick", type=int, default=0, help="只下前 N 个")
    p_dl.add_argument("--index", default="", help="按 1 起算的序号，逗号分隔，如 1,3,5")
    p_dl.add_argument("--match", default="", help="文件名包含该子串才下")
    p_dl.add_argument("--videos", action="store_true", help="只要视频")
    p_dl.add_argument("--jobs", type=int, default=8, help="分片线程数（默认 8）")
    p_dl.add_argument("--force", action="store_true", help="覆盖已存在文件")
    p_dl.add_argument("--sha256", action="store_true", help="额外计算 SHA-256")
    p_dl.add_argument("--no-probe", action="store_true", help="跳过 ffprobe 校验")
    p_dl.add_argument("--dry-run", action="store_true", help="只列出将要下载的文件")
    p_dl.add_argument("--pan-dir", default=None, help="转存目标目录（别人的分享用）")

    p_probe = common(sub.add_parser("probe", help="本地文件信息"))
    p_probe.add_argument("path")

    args = parser.parse_args(argv)

    try:
        if args.cmd == "selfcheck":
            payload = cmd_selfcheck(None)
        else:
            if args.cmd == "probe":
                path = Path(os.path.expanduser(args.path))
                if not path.is_file():
                    raise Fail(f"没有这个文件：{path}", "not-found", EXIT_USAGE)
                payload = {"ok": path.stat().st_size > 0, "path": str(path), "bytes": path.stat().st_size, **probe(path)}
            else:
                cookies, source = load_credentials(args.cookie_file, refresh=args.refresh_cookies)
                pan = Pan(cookies, source)
                if args.cmd == "whoami":
                    payload = cmd_whoami(pan)
                elif args.cmd == "list":
                    payload = cmd_list(pan, args)
                elif args.cmd == "download":
                    payload = cmd_download(pan, args)
                else:  # pragma: no cover
                    raise Fail(f"未知命令 {args.cmd}", "bad-cmd", EXIT_USAGE)
    except FailPayload as exc:
        _emit(args.json, exc.payload)
        return EXIT_DOWNLOAD
    except Fail as exc:
        _emit(args.json, {"ok": False, "error": str(exc), "code": exc.code})
        return exc.exit_code
    except requests.RequestException as exc:
        _emit(args.json, {"ok": False, "error": f"网络错误：{exc}", "code": "network"})
        return EXIT_DOWNLOAD

    _emit(args.json, payload)
    return EXIT_OK if payload.get("ok", False) else EXIT_VERIFY


def _emit(as_json: bool, payload: dict[str, Any]) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    if not payload.get("ok", False) and payload.get("error"):
        print(f"失败：{payload['error']}")
        return
    for key in ("items",):
        if key in payload:
            for item in payload[key]:
                size = "-" if item["isdir"] else f"{item['size'] / 1048576:.1f} MB"
                kind = "DIR " if item["isdir"] else ("VID " if item["is_video"] else "FILE")
                print(f"{kind} {item['name']}  {size}")
            return
    if "downloaded" in payload:
        for f in payload["downloaded"]:
            print(f"{f['name']}  {f['bytes'] / 1048576:.1f} MB  ->  {f['path']}")
        for f in payload.get("failed", []):
            print(f"失败 {f['name']}: {f['error']}")
        return
    print(json.dumps(payload, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    raise SystemExit(main())
