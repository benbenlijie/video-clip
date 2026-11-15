#!/usr/bin/env python3
"""wx_video_dl.py — 视频号素材下载器（video-clip 项目技能）

把 `https://weixin.qq.com/sph/<id>` 这类视频号分享链接解析成签名直链，
下载到本地，并用 ffprobe + SHA-256 验证文件真实可用。

为什么需要解析器：视频号网页端（channels.weixin.qq.com/finder-preview）只返回
封面和"扫码前往微信观看"的二维码，`get_feed_info` 里没有媒体字段；官方直链必须
带微信登录态。本脚本因此把"链接 -> 直链"这一步交给可配置的解析器，由解析器
（自建或第三方）持有一个已登录会话。

子命令：
  resolve   分享链接 -> 元数据 + 直链（不落盘）
  download  分享链接或直链 -> 落盘 + 校验
  probe     本地文件 -> 时长/分辨率/编码/SHA-256
  selfcheck 环境自检（python、ffprobe、解析器配置）

约定：人类可读日志走 stderr，`--json` 时 stdout 只有一个 JSON 对象，便于 MCP 包装。

退出码：0 成功 / 2 解析失败 / 3 下载失败 / 4 校验失败 / 5 参数或环境错误
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_RESOLVER = "https://video.zacao.top/api/parse"
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_REFERER = "https://channels.weixin.qq.com/"
CHUNK = 256 * 1024
MEDIA_HOST_HINTS = ("finder.video.qq.com", "wxapp.tc.qq.com", "res.wx.qq.com", "video.qq.com")
SHARE_HOST_HINTS = ("weixin.qq.com/sph", "channels.weixin.qq.com")

EXIT_OK = 0
EXIT_RESOLVE = 2
EXIT_DOWNLOAD = 3
EXIT_VERIFY = 4
EXIT_USAGE = 5


class CliError(Exception):
    """带退出码和机器可读 code 的失败。"""

    def __init__(self, message: str, code: int, kind: str):
        super().__init__(message)
        self.message = message
        self.code = code
        self.kind = kind


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    for key, value in payload.items():
        if value is None or value == "" or value == []:
            continue
        if key in {"ok", "code", "kind"}:
            continue
        print(f"{key}: {value}")


def human_size(num: float | int | None) -> str:
    if not num:
        return "0 B"
    value = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} GB"


def extract_url(text: str) -> str:
    """从分享口令里取出第一个 http(s) 链接。"""
    if not text:
        raise CliError("链接为空", EXIT_USAGE, "empty-link")
    match = re.search(r"https?://[^\s\u3000\"'<>（）()]+", text)
    if not match:
        raise CliError(f"没有在输入里找到 http(s) 链接：{text[:60]}", EXIT_USAGE, "no-url")
    return match.group(0).rstrip(".,;，。；）)")


def is_media_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if path.endswith((".mp4", ".m4v", ".mov", ".mkv", ".webm")):
        return True
    return any(hint in host for hint in MEDIA_HOST_HINTS) and "stodownload" in path + parsed.query


def sanitize_filename(name: str, fallback: str = "weixin-video", max_length: int = 90) -> str:
    """保留中文，去掉文件系统与 SMB 共享上的非法字符。"""
    text = unicodedata.normalize("NFC", name or "")  # 保留中文全角标点，不做兼容分解
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    text = re.sub(r'[/\\:*?"<>|\r\n\t]', " ", text)
    text = re.sub(r"\s+", " ", text).strip().strip(".")
    text = re.sub(r"\.(mp4|m4v|mov|mkv|webm)$", "", text, flags=re.IGNORECASE)
    if len(text) > max_length:
        text = text[:max_length].rstrip(" .-")
    return text or fallback


def strip_trailing_tags(text: str) -> str:
    """文件名用：去掉描述结尾的 #话题 串，保留正文。"""
    trimmed = re.sub(r"(\s*#[^\s#]+)+\s*$", "", text).strip()
    return trimmed or text


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ffprobe_json(path: Path) -> dict[str, Any] | None:
    binary = os.environ.get("WX_VIDEO_FFPROBE") or shutil.which("ffprobe")
    if not binary:
        return None
    try:
        result = subprocess.run(
            [binary, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def probe_video(path: Path) -> dict[str, Any]:
    stat = path.stat()
    info: dict[str, Any] = {"path": str(path), "bytes": stat.st_size, "sha256": sha256_file(path)}
    data = ffprobe_json(path)
    if data is None:
        with path.open("rb") as handle:
            head = handle.read(16)
        if head[4:8] not in {b"ftyp", b"moov", b"mdat"} and not path.suffix.lower() in {".mp4", ".mov", ".m4v"}:
            raise CliError(f"{path} 不是可识别的视频容器（ffprobe 不可用且缺少 MP4 box）", EXIT_VERIFY, "not-video")
        info["verified"] = False
        info["note"] = "ffprobe 不可用，仅做了容器头检查"
        return info

    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise CliError(f"{path} 没有视频流，可能是错误页或音频文件", EXIT_VERIFY, "no-video-stream")

    duration = data.get("format", {}).get("duration")
    info.update(
        verified=True,
        duration_seconds=round(float(duration), 3) if duration else None,
        width=int(video.get("width") or 0) or None,
        height=int(video.get("height") or 0) or None,
        video_codec=video.get("codec_name"),
        audio_codec=(audio or {}).get("codec_name"),
    )
    return info


# --------------------------------------------------------------------------- #
# 解析器
# --------------------------------------------------------------------------- #
def resolver_endpoint(cli_value: str | None) -> str:
    if cli_value:
        return cli_value
    env = os.environ.get("WX_VIDEO_RESOLVER")
    if env:
        return env
    allow_public = os.environ.get("WX_VIDEO_ALLOW_PUBLIC_RESOLVER", "1").strip().lower()
    if allow_public in {"0", "false", "no", "off"}:
        raise CliError(
            "没有配置解析器，且已禁用内置公共解析器（WX_VIDEO_ALLOW_PUBLIC_RESOLVER=0）。"
            "请设置 WX_VIDEO_RESOLVER，或加 --resolver 参数。",
            EXIT_USAGE,
            "resolver-not-configured",
        )
    return DEFAULT_RESOLVER


def extract_short_id(url: str) -> str | None:
    """从 weixin.qq.com/sph/<id> 或 finder-preview/pages/sph?id=<id> 里取短 id。"""
    parsed = urllib.parse.urlparse(url)
    match = re.search(r"/sph/([A-Za-z0-9_-]{4,64})", parsed.path)
    if match:
        return match.group(1)
    query = urllib.parse.parse_qs(parsed.query)
    value = (query.get("id") or [""])[0]
    return value if re.fullmatch(r"[A-Za-z0-9_-]{4,64}", value or "") else None


def preview_metadata(short_id: str, timeout: float) -> dict[str, Any]:
    """官方 finder-preview 接口：封面、作者、发布时间、互动数据。

    这个接口匿名可用，但只返回元数据，没有媒体地址；失败时静默降级。
    """
    rid = f"{uuid_hex()}-{uuid_hex()[:8]}"
    endpoint = (
        "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info"
        f"?_rid={rid}&_pageUrl=https:%2F%2Fchannels.weixin.qq.com%2Ffinder-preview%2Fpages%2Fsph"
    )
    body = {"baseReq": {"generalToken": ""}, "shortUri": short_id}
    headers = {
        "content-type": "application/json",
        "accept": "application/json",
        "origin": "https://channels.weixin.qq.com",
        "referer": f"https://channels.weixin.qq.com/finder-preview/pages/sph?id={short_id}",
        "user-agent": DEFAULT_UA,
    }
    request = urllib.request.Request(
        endpoint, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    data = payload.get("data") or {}
    feed = data.get("feedInfo") or {}
    author = data.get("authorInfo") or {}
    created = feed.get("createtime")
    return {
        "title": feed.get("description"),
        "author": author.get("nickname"),
        "coverUrl": feed.get("coverUrl"),
        "publishedAt": (
            datetime.fromtimestamp(int(created), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
            if isinstance(created, (int, float)) and created
            else None
        ),
        "stats": {
            "like": feed.get("likeCountFmt"),
            "share": feed.get("forwardCountFmt"),
            "comment": feed.get("commentCountFmt"),
            "fav": feed.get("favCountFmt"),
        },
    }


def uuid_hex() -> str:
    return os.urandom(4).hex()


def post_json(url: str, body: dict[str, Any], timeout: float, token: str | None) -> dict[str, Any]:
    headers = {
        "content-type": "application/json",
        "accept": "application/json",
        "user-agent": DEFAULT_UA,
    }
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise CliError(f"解析器返回 HTTP {exc.code}：{detail}", EXIT_RESOLVE, "resolver-http") from exc
    except urllib.error.URLError as exc:
        raise CliError(f"解析器不可达：{exc.reason}", EXIT_RESOLVE, "resolver-unreachable") from exc
    except TimeoutError as exc:
        raise CliError("解析器超时", EXIT_RESOLVE, "resolver-timeout") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CliError(f"解析器返回非 JSON：{raw[:200]}", EXIT_RESOLVE, "resolver-not-json") from exc


def pick_media_url(payload: dict[str, Any]) -> str:
    """兼容多种解析器返回结构。"""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    for key in ("url", "source_video_url", "video_url", "play_url", "mp4_url"):
        value = data.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
    backups = data.get("video_backup") or data.get("backup") or []
    if isinstance(backups, list):
        for item in backups:
            if isinstance(item, dict):
                value = item.get("url") or item.get("source_video_url")
                if isinstance(value, str) and value.startswith("http"):
                    return value
    return ""


def resolve_media(link: str, resolver: str, token: str | None, timeout: float) -> dict[str, Any]:
    url = extract_url(link)
    if is_media_url(url):
        return {
            "ok": True,
            "kind": "media",
            "videoUrl": url,
            "title": None,
            "author": None,
            "videoId": None,
            "resolver": "direct",
            "coverUrl": None,
            "qualities": [],
            "requestUrl": url,
        }

    payload: dict[str, Any] | None = None
    last_error: CliError | None = None
    # 不同解析器对字段名要求不同：先 text（保留整段口令），再 url。
    for body in ({"text": url}, {"url": url}):
        try:
            payload = post_json(resolver, body, timeout, token)
            break
        except CliError as exc:
            last_error = exc
            if exc.kind != "resolver-http":
                raise
    if payload is None:
        assert last_error is not None
        raise last_error

    status = payload.get("code", payload.get("status"))
    success = payload.get("succ") if isinstance(payload.get("succ"), bool) else None
    if success is False or (status not in (None, 0, 200, "200")):
        message = payload.get("msg") or payload.get("message") or payload.get("error") or "未知错误"
        raise CliError(f"解析失败：{message}", EXIT_RESOLVE, "resolve-failed")

    media = pick_media_url(payload)
    if not media:
        raise CliError(
            "解析成功但没有拿到视频直链（该链接可能是直播回放、图文或需要登录的内容）",
            EXIT_RESOLVE,
            "no-media-url",
        )

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    author = data.get("author") if isinstance(data.get("author"), dict) else {}
    qualities = []
    for item in data.get("video_backup") or []:
        if isinstance(item, dict) and item.get("url"):
            qualities.append(
                {
                    "label": item.get("label") or item.get("gear_name") or item.get("quality"),
                    "codec": item.get("codec"),
                    "url": item.get("url"),
                }
            )
    result: dict[str, Any] = {
        "ok": True,
        "kind": "share",
        "videoUrl": media,
        "title": data.get("title") or data.get("desc"),
        "desc": data.get("desc"),
        "author": author.get("nickname") or author.get("name") or data.get("author_name"),
        "authorId": author.get("id") or data.get("author_id"),
        "videoId": data.get("video_id") or data.get("id"),
        "coverUrl": data.get("cover_url") or data.get("cover"),
        "qualities": qualities,
        "resolver": resolver,
        "requestUrl": url,
        "expiresHint": "直链带签名，解析后应立即下载",
    }

    # 解析器经常不返回作者/发布时间；用官方预览接口补全，失败不影响下载。
    short_id = extract_short_id(url) or result.get("videoId")
    if short_id:
        try:
            extra = preview_metadata(short_id, min(timeout, 12.0))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            extra = {}
        if extra:
            result["title"] = result.get("title") or extra.get("title")
            result["author"] = result.get("author") or extra.get("author")
            result["coverUrl"] = result.get("coverUrl") or extra.get("coverUrl")
            result["publishedAt"] = extra.get("publishedAt")
            result["stats"] = extra.get("stats")
            result["enriched"] = True
    return result


# --------------------------------------------------------------------------- #
# 下载
# --------------------------------------------------------------------------- #
def unique_target(directory: Path, stem: str, suffix: str = ".mp4") -> Path:
    candidate = directory / f"{stem}{suffix}"
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem} ({index}){suffix}"
        index += 1
    return candidate


def fetch_to_file(
    url: str,
    target: Path,
    *,
    timeout: float,
    retries: int,
    resume: bool,
    referer: str,
) -> dict[str, Any]:
    part = target.with_suffix(target.suffix + ".part")
    attempt = 0
    last_error: str = ""
    while attempt <= retries:
        attempt += 1
        offset = 0
        if resume and part.exists() and part.stat().st_size > 0:
            offset = part.stat().st_size
        headers = {
            "user-agent": DEFAULT_UA,
            "referer": referer,
            "accept": "*/*",
            "accept-encoding": "identity",
        }
        if offset:
            headers["range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content_type = (response.headers.get("content-type") or "").lower()
                if "text/html" in content_type or "application/json" in content_type:
                    snippet = response.read(400).decode("utf-8", errors="replace")
                    raise CliError(
                        f"直链返回的是 {content_type} 而不是视频，链接可能已过期：{snippet[:160]}",
                        EXIT_DOWNLOAD,
                        "expired-url",
                    )
                if offset and response.status != 206:
                    offset = 0
                    part.unlink(missing_ok=True)
                total = response.headers.get("content-length")
                total_bytes = int(total) + offset if total and total.isdigit() else None
                mode = "ab" if offset else "wb"
                written = offset
                started = time.time()
                last_report = 0.0
                with part.open(mode) as handle:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        handle.write(block)
                        written += len(block)
                        now = time.time()
                        if sys.stderr.isatty() and now - last_report > 0.5:
                            speed = written / max(now - started, 0.001) / 1024 / 1024
                            if total_bytes:
                                log(f"  下载中 {human_size(written)} / {human_size(total_bytes)} ({written * 100 // total_bytes}%) {speed:.1f} MB/s")
                            else:
                                log(f"  下载中 {human_size(written)} {speed:.1f} MB/s")
                            last_report = now
            if part.stat().st_size == 0:
                raise CliError("直链返回空文件", EXIT_DOWNLOAD, "empty-body")
            part.replace(target)
            return {"bytes": target.stat().st_size, "contentType": content_type or "unknown"}
        except CliError:
            raise
        except urllib.error.HTTPError as exc:
            if exc.code == 416 and offset:
                part.unlink(missing_ok=True)
                last_error = "断点续传位置失效，已重新开始"
                continue
            last_error = f"HTTP {exc.code}"
            if exc.code in {401, 403, 404, 410, 451}:
                raise CliError(
                    f"下载被拒绝（{last_error}）。签名直链通常 5-30 分钟过期，请重新解析。",
                    EXIT_DOWNLOAD,
                    "download-denied",
                ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = str(getattr(exc, "reason", exc))
        if attempt <= retries:
            wait = min(2 ** (attempt - 1), 8)
            log(f"  第 {attempt} 次失败（{last_error}），{wait}s 后重试")
            time.sleep(wait)
    raise CliError(f"下载失败：{last_error}", EXIT_DOWNLOAD, "download-failed")


def download(
    *,
    link: str,
    out_dir: Path,
    name: str | None,
    force: bool,
    resume: bool,
    resolver: str,
    token: str | None,
    timeout: float,
    retries: int,
    referer: str,
    want_meta: Path | None,
    keep_source_url: bool,
) -> dict[str, Any]:
    meta = resolve_media(link, resolver, token, timeout)
    directory = out_dir.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)

    if name:
        stem = sanitize_filename(name)
    else:
        title = meta.get("title") or meta.get("videoId") or "weixin-video"
        stem = sanitize_filename(strip_trailing_tags(title))
        author = meta.get("author")
        if author and author not in stem:
            stem = sanitize_filename(f"{stem}-{author}", max_length=110)
    target = directory / f"{stem}.mp4"
    if target.exists():
        if not force:
            target = unique_target(directory, stem)
        else:
            target.unlink()

    log(f"解析来源：{meta.get('resolver')}")
    if meta.get("title"):
        log(f"标题：{meta['title']}")
    if meta.get("author"):
        log(f"作者：{meta['author']}")
    log(f"写入：{target}")

    transfer = fetch_to_file(
        meta["videoUrl"],
        target,
        timeout=timeout,
        retries=retries,
        resume=resume,
        referer=referer,
    )
    probe = probe_video(target)

    result: dict[str, Any] = {
        "ok": True,
        "path": str(target),
        "bytes": probe["bytes"],
        "sha256": probe["sha256"],
        "durationSeconds": probe.get("duration_seconds"),
        "width": probe.get("width"),
        "height": probe.get("height"),
        "videoCodec": probe.get("video_codec"),
        "audioCodec": probe.get("audio_codec"),
        "verified": probe.get("verified", False),
        "title": meta.get("title"),
        "author": meta.get("author"),
        "publishedAt": meta.get("publishedAt"),
        "videoId": meta.get("videoId"),
        "coverUrl": meta.get("coverUrl"),
        "resolver": meta.get("resolver"),
        "downloadedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "contentType": transfer.get("contentType"),
        "sourceLink": meta.get("requestUrl"),
    }
    if keep_source_url:
        result["mediaUrl"] = meta.get("videoUrl")
    if probe.get("note"):
        result["note"] = probe["note"]
    if meta.get("qualities"):
        result["alternateQualities"] = [q for q in meta["qualities"] if q.get("url") != meta.get("videoUrl")]

    if want_meta:
        want_meta.parent.mkdir(parents=True, exist_ok=True)
        want_meta.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result["metaPath"] = str(want_meta)
    return result


# --------------------------------------------------------------------------- #
# 环境自检
# --------------------------------------------------------------------------- #
def selfcheck() -> dict[str, Any]:
    ffprobe = os.environ.get("WX_VIDEO_FFPROBE") or shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    try:
        resolver = resolver_endpoint(None)
    except CliError as exc:
        resolver = f"<未配置：{exc.message}>"
    return {
        "ok": bool(ffprobe),
        "python": sys.version.split()[0],
        "ffprobe": ffprobe or "缺失（降到容器头检查）",
        "ffmpeg": ffmpeg or "缺失",
        "resolver": resolver,
        "resolverToken": "已配置" if os.environ.get("WX_VIDEO_RESOLVER_TOKEN") else "未配置",
        "publicResolverAllowed": os.environ.get("WX_VIDEO_ALLOW_PUBLIC_RESOLVER", "1"),
        "defaultOutDir": str(default_out_dir()),
    }


def default_out_dir() -> Path:
    env = os.environ.get("WX_VIDEO_OUT_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / "Downloads" / "videos"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wx_video_dl.py",
        description="视频号分享链接 -> 本地 MP4（解析器可配置，下载后 ffprobe + SHA-256 校验）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--json", action="store_true", help="stdout 只输出一个 JSON 对象")
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    # SUPPRESS 让子命令前的 --json 不被子解析器的默认值覆盖。
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="stdout 只输出一个 JSON 对象")
    common.add_argument("--resolver", help="解析器地址（默认读 WX_VIDEO_RESOLVER，否则内置公共解析器）")
    common.add_argument("--timeout", type=float, default=45.0, help="网络超时秒数（默认 45）")

    p_resolve = sub.add_parser("resolve", parents=[common], help="只解析，不下载")
    p_resolve.add_argument("link", help="分享链接或整段分享口令")
    p_resolve.add_argument("--show-url", action="store_true", help="输出完整直链（默认已含）")

    p_dl = sub.add_parser("download", parents=[common], help="解析并下载")
    p_dl.add_argument("link", help="分享链接、分享口令或已经拿到的直链")
    p_dl.add_argument("--out", type=Path, default=None, help=f"输出目录（默认 {default_out_dir()}）")
    p_dl.add_argument("--name", help="文件名（不含扩展名），默认用标题")
    p_dl.add_argument("--force", action="store_true", help="同名文件直接覆盖")
    p_dl.add_argument("--no-resume", action="store_true", help="禁用断点续传")
    p_dl.add_argument("--retries", type=int, default=2, help="下载重试次数（默认 2）")
    p_dl.add_argument("--referer", default=DEFAULT_REFERER, help="下载时携带的 Referer")
    p_dl.add_argument("--meta", type=Path, help="额外写一份 JSON 元数据")
    p_dl.add_argument("--with-media-url", action="store_true", help="在结果里保留带签名的直链")

    p_probe = sub.add_parser("probe", parents=[common], help="检查本地视频")
    p_probe.add_argument("file", type=Path)

    sub.add_parser("selfcheck", parents=[common], help="环境自检")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    token = os.environ.get("WX_VIDEO_RESOLVER_TOKEN")
    try:
        if args.command == "selfcheck":
            payload = selfcheck()
            emit(payload, args.json)
            return EXIT_OK if payload["ok"] else EXIT_USAGE

        if args.command == "probe":
            payload = probe_video(args.file.expanduser().resolve())
            emit({"ok": True, **payload}, args.json)
            return EXIT_OK

        resolver = resolver_endpoint(args.resolver)
        if args.command == "resolve":
            payload = resolve_media(args.link, resolver, token, args.timeout)
            emit(payload, args.json)
            return EXIT_OK

        if args.command == "download":
            out_dir = args.out or default_out_dir()
            payload = download(
                link=args.link,
                out_dir=out_dir,
                name=args.name,
                force=args.force,
                resume=not args.no_resume,
                resolver=resolver,
                token=token,
                timeout=args.timeout,
                retries=max(0, args.retries),
                referer=args.referer,
                want_meta=args.meta,
                keep_source_url=args.with_media_url,
            )
            if not args.json:
                log("")
                log(f"完成：{payload['path']}")
                log(
                    f"  {human_size(payload['bytes'])} · {payload.get('width')}x{payload.get('height')} · "
                    f"{payload.get('durationSeconds')}s · {payload.get('videoCodec')}"
                )
                log(f"  sha256 {payload['sha256']}")
            emit(payload, args.json)
            return EXIT_OK

        raise CliError(f"未知子命令：{args.command}", EXIT_USAGE, "unknown-command")
    except CliError as exc:
        emit({"ok": False, "error": exc.message, "code": exc.kind}, args.json)
        log(f"错误：{exc.message}")
        return exc.code
    except KeyboardInterrupt:
        emit({"ok": False, "error": "用户中断", "code": "interrupted"}, args.json)
        return 130


if __name__ == "__main__":
    sys.exit(main())
