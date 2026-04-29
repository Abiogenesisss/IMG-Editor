import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote, urljoin, urlparse

import requests


USER_AGENT = "IMG_Editor/1.0 image grabber"
PIXIV_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
PIXIV_BASE = "https://www.pixiv.net"
IMAGE_TIMEOUT = 30
API_TIMEOUT = 20
MAX_WORKERS = 8
PIXIV_DETAIL_WORKERS = 1
PIXIV_REQUEST_DELAY = 0.7
PIXIV_RETRY_DELAYS = (2.0, 5.0, 10.0)
TWITTER_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
TWITTER_VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm"}


BOORU_SITES = {
    "danbooru": {
        "label": "Danbooru",
        "kind": "danbooru",
        "base": "https://danbooru.donmai.us",
        "max_per_page": 200,
    },
    "gelbooru": {
        "label": "Gelbooru",
        "kind": "dapi",
        "base": "https://gelbooru.com",
        "max_per_page": 100,
    },
    "safebooru": {
        "label": "Safebooru",
        "kind": "dapi",
        "base": "https://safebooru.org",
        "max_per_page": 100,
    },
    "yande": {
        "label": "Yande.re",
        "kind": "moebooru",
        "base": "https://yande.re",
        "max_per_page": 100,
    },
    "konachan": {
        "label": "Konachan",
        "kind": "moebooru",
        "base": "https://konachan.com",
        "max_per_page": 100,
    },
    "sakugabooru": {
        "label": "Sakugabooru",
        "kind": "moebooru",
        "base": "https://www.sakugabooru.com",
        "max_per_page": 100,
    },
}


def run_grab_download(body, progress_cb=None, cancel_event=None):
    site = str(body.get("site") or "").strip().lower()
    if site == "pixiv":
        return run_pixiv_download(body, progress_cb=progress_cb, cancel_event=cancel_event)
    if site in {"twitter", "x"}:
        return run_twitter_download(body, progress_cb=progress_cb, cancel_event=cancel_event)
    return run_booru_download(body, progress_cb=progress_cb, cancel_event=cancel_event)


def _is_cancelled(cancel_event):
    return bool(cancel_event and cancel_event.is_set())


def _progress(progress_cb, **payload):
    if progress_cb:
        progress_cb(payload)


def _clamp_int(value, default, min_value, max_value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = default
    return max(min_value, min(max_value, value))


def _sanitize_name(value, fallback="unknown", limit=120):
    text = str(value or "").strip() or fallback
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text)
    text = re.sub(r"\s+", "_", text)
    text = text.strip("._ ")
    return (text or fallback)[:limit]


def _safe_tag_dir(tags):
    return _sanitize_name(str(tags or "all").replace(" ", "_"), fallback="all", limit=160)


def _ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def _load_resume(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return set(str(item) for item in data)
    except Exception:
        return set()


def _save_resume(path, data):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(sorted(data), f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def _normalize_url(url, base=""):
    if not url:
        return ""
    url = str(url)
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return urljoin(base, url)
    return url


def _url_ext(url, fallback=".jpg"):
    path = urlparse(url).path
    _, ext = os.path.splitext(path)
    if ext:
        return ext[:12]
    return fallback


def _unique_path(path):
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    idx = 2
    while True:
        candidate = f"{root}_{idx}{ext}"
        if not os.path.exists(candidate):
            return candidate
        idx += 1


def _tags_to_txt(tags):
    if isinstance(tags, dict):
        flat = []
        for group in tags.values():
            if isinstance(group, list):
                flat.extend(group)
        tags = " ".join(str(tag) for tag in flat)
    elif isinstance(tags, list):
        tags = " ".join(str(tag) for tag in tags)
    return ",".join(tag.replace("_", " ") for tag in str(tags or "").split())


def _rating_allowed(rating, mode):
    mode = str(mode or "all").lower()
    if mode == "all":
        return True
    normalized = str(rating or "").lower()
    is_safe = normalized in {"s", "safe", "general", "g"}
    if mode == "safe":
        return is_safe
    if mode == "nsfw":
        return not is_safe
    return True


def _score_value(post):
    score = post.get("score", 0)
    if isinstance(score, dict):
        score = score.get("total", 0)
    try:
        return int(score)
    except (TypeError, ValueError):
        return 0


def _request_json(session, url, *, params=None, headers=None, timeout=API_TIMEOUT):
    response = session.get(url, params=params, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.json()


def _download_binary(task, cancel_event=None):
    if _is_cancelled(cancel_event):
        return {"ok": False, "cancelled": True, **task}

    tmp_path = task["path"] + ".part"
    try:
        with requests.get(task["url"], headers=task.get("headers") or {}, stream=True, timeout=IMAGE_TIMEOUT) as resp:
            resp.raise_for_status()
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 256):
                    if _is_cancelled(cancel_event):
                        raise RuntimeError("task cancelled")
                    if chunk:
                        f.write(chunk)
        os.replace(tmp_path, task["path"])
        if task.get("txt_path"):
            with open(task["txt_path"], "w", encoding="utf-8") as f:
                f.write(task.get("tags_txt") or "")
        return {"ok": True, **task}
    except Exception as exc:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return {"ok": False, "error": str(exc), **task}


def _download_tasks(tasks, done_start, total, progress_cb=None, cancel_event=None, resume_path="", resume_ids=None):
    saved = 0
    failed = 0
    results = []
    resume_ids = resume_ids if resume_ids is not None else set()

    if not tasks:
        return saved, failed, results

    workers = min(MAX_WORKERS, max(1, len(tasks)))
    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_download_binary, task, cancel_event) for task in tasks]
        for fut in as_completed(futures):
            completed += 1
            result = fut.result()
            results.append(result)
            if result.get("ok"):
                saved += 1
                if result.get("resume_key"):
                    resume_ids.add(str(result["resume_key"]))
                    if resume_path:
                        _save_resume(resume_path, resume_ids)
            elif result.get("cancelled"):
                failed += 1
            else:
                failed += 1

            _progress(
                progress_cb,
                scope="grab-site",
                stage="download",
                done=min(total, done_start + completed),
                total=total,
                current=result.get("filename") or result.get("url") or "",
                saved=saved,
                failed=failed,
            )
            if _is_cancelled(cancel_event):
                break

    return saved, failed, results


def _fetch_booru_page(session, cfg, tags, page, per_page):
    kind = cfg["kind"]
    base = cfg["base"]
    headers = {"User-Agent": USER_AGENT}

    if kind == "danbooru":
        return _request_json(
            session,
            base + "/posts.json",
            params={
                "tags": tags,
                "page": page,
                "limit": per_page,
                "only": "id,file_url,large_file_url,tag_string,tag_string_artist,score,rating,artist_name",
            },
            headers=headers,
        )

    if kind == "dapi":
        data = _request_json(
            session,
            base + "/index.php",
            params={
                "page": "dapi",
                "s": "post",
                "q": "index",
                "json": "1",
                "tags": tags,
                "pid": max(0, page - 1),
                "limit": per_page,
            },
            headers=headers,
        )
        if isinstance(data, list):
            return data
        posts = data.get("post") or data.get("posts") or []
        if isinstance(posts, dict):
            return [posts]
        return posts

    if kind == "moebooru":
        return _request_json(
            session,
            base + "/post.json",
            params={"tags": tags, "page": page, "limit": per_page},
            headers=headers,
        )

    return []


def _normalize_booru_post(cfg, post, only_original):
    kind = cfg["kind"]
    base = cfg["base"]
    post_id = str(post.get("id") or "")
    score = _score_value(post)
    rating = post.get("rating", "")

    if kind == "danbooru":
        tags = post.get("tag_string", "")
        tags_txt = _tags_to_txt(tags)
        artist = post.get("artist_name") or str(post.get("tag_string_artist") or "").split(" ")[0] or "unknown"
        file_url = post.get("file_url")
        large_url = post.get("large_file_url") or file_url
    else:
        tags = post.get("tags", "")
        tags_txt = _tags_to_txt(tags)
        artist = post.get("artist") or post.get("author") or post.get("owner") or "unknown"
        file_url = post.get("file_url")
        large_url = post.get("jpeg_url") or post.get("sample_url") or post.get("preview_url") or file_url

    url = file_url if only_original else (large_url or file_url)
    url = _normalize_url(url, base)
    return {
        "id": post_id,
        "url": url,
        "artist": _sanitize_name(artist),
        "tags_txt": tags_txt,
        "score": score,
        "rating": rating,
        "raw_tags": tags_txt.replace(",", " "),
    }


def run_booru_download(body, progress_cb=None, cancel_event=None):
    site = str(body.get("site") or "danbooru").lower()
    if site not in BOORU_SITES:
        return {"success": False, "error": f"unsupported booru site: {site}"}

    cfg = BOORU_SITES[site]
    tags = str(body.get("tags") or "").strip() or "all"
    output_root = str(body.get("output_dir") or "").strip()
    if not output_root:
        return {"success": False, "error": "no output directory specified"}

    limit = _clamp_int(body.get("limit"), 100, 1, 10000)
    per_page = _clamp_int(body.get("per_page"), 100, 1, cfg.get("max_per_page", 100))
    min_score = _clamp_int(body.get("min_score"), 0, -999999, 999999)
    rating = str(body.get("rating") or "all").lower()
    filter_ai = bool(body.get("filter_ai", True))
    only_original = bool(body.get("only_original", True))
    write_txt = bool(body.get("write_txt", body.get("write_tags_txt", True)))
    enable_resume = bool(body.get("enable_resume", True))

    site_dir = os.path.join(output_root, site, _safe_tag_dir(tags))
    _ensure_dir(site_dir)
    resume_path = os.path.join(site_dir, "_downloaded.json")
    resume_ids = _load_resume(resume_path) if enable_resume else set()
    initial_done = len(resume_ids) if enable_resume else 0
    if initial_done >= limit:
        return {
            "success": True,
            "output_dir": site_dir,
            "downloaded": 0,
            "skipped": initial_done,
            "failed": 0,
            "errors": [],
        }

    session = requests.Session()
    tasks = []
    errors = []
    artist_counters = {}
    accepted_total = initial_done
    page = 1

    while accepted_total < limit and not _is_cancelled(cancel_event):
        try:
            posts = _fetch_booru_page(session, cfg, tags, page, per_page)
        except Exception as exc:
            errors.append(f"page {page}: {exc}")
            time.sleep(1)
            page += 1
            continue

        if not posts:
            break

        for post in posts:
            if accepted_total >= limit or _is_cancelled(cancel_event):
                break

            item = _normalize_booru_post(cfg, post, only_original)
            if not item["id"] or item["id"] in resume_ids:
                continue
            if not _rating_allowed(item["rating"], rating):
                continue
            if filter_ai and "ai generated" in item["tags_txt"].lower():
                continue
            if item["score"] < min_score:
                continue
            if not item["url"]:
                continue

            artist = item["artist"]
            artist_counters[artist] = artist_counters.get(artist, 0) + 1
            num = f"{artist_counters[artist]:04d}"
            ext = _url_ext(item["url"])
            filename = _sanitize_name(f"{artist}{num}", fallback="image") + ext
            path = _unique_path(os.path.join(site_dir, filename))
            txt_path = os.path.splitext(path)[0] + ".txt" if write_txt else ""
            tasks.append({
                "url": item["url"],
                "path": path,
                "filename": os.path.basename(path),
                "txt_path": txt_path,
                "tags_txt": item["tags_txt"] if write_txt else "",
                "resume_key": item["id"],
                "headers": {"User-Agent": USER_AGENT, "Referer": cfg["base"]},
            })
            accepted_total += 1
            _progress(
                progress_cb,
                scope="grab-site",
                stage="collect",
                done=accepted_total,
                total=limit,
                current=f"{cfg['label']} #{item['id']}",
            )

        page += 1

    saved, failed, results = _download_tasks(
        tasks,
        initial_done,
        limit,
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        resume_path=resume_path if enable_resume else "",
        resume_ids=resume_ids,
    )

    return {
        "success": not _is_cancelled(cancel_event),
        "output_dir": site_dir,
        "downloaded": saved,
        "skipped": max(0, initial_done),
        "failed": failed,
        "errors": errors + [r.get("error", "") for r in results if r.get("error")],
        "aborted": _is_cancelled(cancel_event),
    }


def _pixiv_headers(cookie="", referer=""):
    cookie = _normalize_pixiv_cookie(cookie)
    headers = {
        "User-Agent": PIXIV_USER_AGENT,
        "Referer": referer or PIXIV_BASE,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    if cookie:
        headers["Cookie"] = cookie
    return headers


def _normalize_pixiv_cookie(cookie):
    text = str(cookie or "").strip()
    if not text:
        return ""
    if "=" not in text and not text.startswith(("{", "[")):
        return f"PHPSESSID={text}"
    parsed = _parse_cookie_header(text)
    if parsed:
        return "; ".join(f"{name}={value}" for name, value in parsed.items())
    return text


def _pixiv_get_json(session, path, cookie, params=None, referer=""):
    url = path if path.startswith("http") else PIXIV_BASE + path
    response = None
    for attempt, delay in enumerate((0.0, *PIXIV_RETRY_DELAYS)):
        if delay:
            time.sleep(delay)
        response = session.get(url, params=params, headers=_pixiv_headers(cookie, referer=referer), timeout=API_TIMEOUT)
        if response.status_code == 429 and attempt < len(PIXIV_RETRY_DELAYS):
            continue
        break
    if response is None:
        raise RuntimeError("Pixiv request failed")
    if response.status_code == 403:
        raise RuntimeError(
            "Pixiv 403：请求被拒绝。通常是 Cookie 过期/权限不足，或 Pixiv 拒绝了当前登录态；"
            "建议从浏览器复制完整 Cookie，而不是只复制 PHPSESSID。"
        )
    if response.status_code == 429:
        raise RuntimeError("Pixiv 429：请求过快，被 Pixiv 临时限流。稍等一会儿再试，或降低数量/页数。")
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise RuntimeError(data.get("message") or "Pixiv API error")
    return data.get("body")


def _extract_first_id(value, pattern=None):
    text = str(value or "")
    if pattern:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    match = re.search(r"\d+", text)
    return match.group(0) if match else ""


def _normalize_pixiv_search_word(query):
    word = str(query or "").strip()
    while word.startswith(("#", "＃")):
        word = word[1:].strip()
    return word


def _extract_twitter_username(value):
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    match = re.search(r"(?:x|twitter)\.com/(?:i/user/\d+/)?@?([^/?#]+)", text, re.IGNORECASE)
    if match:
        text = match.group(1)
    text = text.strip().lstrip("@")
    if text.lower() in {"home", "explore", "search", "notifications", "messages", "settings"}:
        return ""
    return text if re.fullmatch(r"[A-Za-z0-9_]{1,15}", text) else ""


def _parse_cookie_header(cookie):
    text = str(cookie or "").strip()
    if not text:
        return {}

    def add_cookie(target, name, value):
        name = str(name or "").strip()
        if name and value is not None:
            target[name] = str(value)

    def parse_json_cookie(data):
        parsed = {}
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    add_cookie(parsed, item.get("name") or item.get("key"), item.get("value"))
        elif isinstance(data, dict):
            cookie_items = data.get("cookies")
            if isinstance(cookie_items, list):
                parsed.update(parse_json_cookie(cookie_items))
            for name, value in data.items():
                if name == "cookies":
                    continue
                if isinstance(value, dict):
                    add_cookie(parsed, value.get("name") or name, value.get("value"))
                elif isinstance(value, (str, int, float, bool)):
                    add_cookie(parsed, name, value)
        return parsed

    try:
        parsed = parse_json_cookie(json.loads(text))
        if parsed:
            return parsed
    except Exception:
        pass

    text = re.sub(r"(?i)^cookie:\s*", "", text)
    text = text.replace("\r", ";").replace("\n", ";")
    parsed = {}
    for part in text.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        if name:
            parsed[name] = value.strip()
    return parsed


def _twitter_media_files(directory, include_video=False):
    allowed = set(TWITTER_IMAGE_EXTS)
    if include_video:
        allowed.update(TWITTER_VIDEO_EXTS)
    files = set()
    if not os.path.isdir(directory):
        return files
    for root, _, filenames in os.walk(directory):
        for filename in filenames:
            if os.path.splitext(filename)[1].lower() in allowed:
                files.add(os.path.join(root, filename))
    return files


def _write_gallery_dl_config(path, cookies, include_video):
    config = {
        "extractor": {
            "twitter": {
                "cookies": cookies,
                "include": "media",
                "retweets": True,
                "replies": False,
                "quoted": False,
                "videos": bool(include_video),
                "text-tweets": False,
                "timeline": {
                    "strategy": "media"
                }
            }
        }
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def _drain_queue(line_queue):
    lines = []
    while True:
        try:
            lines.append(line_queue.get_nowait())
        except queue.Empty:
            return lines


def run_twitter_download(body, progress_cb=None, cancel_event=None):
    output_root = str(body.get("output_dir") or "").strip()
    cookie = str(body.get("cookie") or "").strip()
    query = str(body.get("query") or "").strip()
    if not output_root:
        return {"success": False, "error": "no output directory specified"}
    if not cookie:
        return {"success": False, "error": "Twitter/X cookie is required"}
    username = _extract_twitter_username(query)
    if not username:
        return {"success": False, "error": "Twitter/X user is required"}

    cookies = _parse_cookie_header(cookie)
    if not cookies:
        return {"success": False, "error": "Twitter/X cookie is invalid"}

    limit = _clamp_int(body.get("limit"), 100, 1, 5000)
    include_video = bool(body.get("include_video", False))
    enable_resume = bool(body.get("enable_resume", True))

    user_dir = os.path.join(output_root, "twitter", _sanitize_name(username, fallback="twitter_user"))
    _ensure_dir(user_dir)
    before_files = _twitter_media_files(user_dir, include_video=include_video)
    archive_path = os.path.join(user_dir, "_downloaded.sqlite3")
    errors = []
    skipped = 0
    cfg_path = ""

    _progress(
        progress_cb,
        scope="grab-site",
        stage="collect",
        done=0,
        total=limit,
        current=f"Twitter/X @{username} media",
    )

    try:
        fd, cfg_path = tempfile.mkstemp(prefix="img_editor_twitter_", suffix=".json")
        os.close(fd)
        _write_gallery_dl_config(cfg_path, cookies, include_video)

        command = [
            sys.executable,
            "-m",
            "gallery_dl",
            "--config-ignore",
            "--config-json",
            cfg_path,
            "--no-input",
            "--no-colors",
            "--windows-filenames",
            "--directory",
            user_dir,
            "--range",
            f"1-{limit}",
            "--Print",
            "after:{_path}",
        ]
        if enable_resume:
            command.extend(["--download-archive", archive_path])
        if not include_video:
            command.extend(["--filter", "extension in ('jpg', 'jpeg', 'png', 'webp')"])
        command.append(f"https://x.com/{username}/media")

        startupinfo = None
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=user_dir,
            startupinfo=startupinfo,
        )

        line_queue = queue.Queue()

        def read_output():
            try:
                for line in proc.stdout:
                    line_queue.put(line.rstrip())
            except Exception:
                pass

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        downloaded = 0
        last_current = ""
        while proc.poll() is None:
            for line in _drain_queue(line_queue):
                if not line:
                    continue
                last_current = line
                lowered = line.lower()
                if "skip" in lowered or "already" in lowered:
                    skipped += 1
                if "[error]" in lowered or " error:" in lowered:
                    errors.append(line)

            current_files = _twitter_media_files(user_dir, include_video=include_video)
            current_downloaded = len(current_files - before_files)
            if current_downloaded != downloaded:
                downloaded = current_downloaded
                _progress(
                    progress_cb,
                    scope="grab-site",
                    stage="download",
                    done=min(limit, downloaded + skipped),
                    total=limit,
                    current=os.path.basename(last_current) if last_current else f"@{username}",
                    saved=downloaded,
                    failed=0,
                )

            if _is_cancelled(cancel_event):
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                break
            time.sleep(0.25)

        reader.join(timeout=1)
        for line in _drain_queue(line_queue):
            if not line:
                continue
            last_current = line
            lowered = line.lower()
            if "skip" in lowered or "already" in lowered:
                skipped += 1
            if "[error]" in lowered or " error:" in lowered:
                errors.append(line)

        after_files = _twitter_media_files(user_dir, include_video=include_video)
        downloaded = len(after_files - before_files)
        aborted = _is_cancelled(cancel_event)
        return_code = proc.returncode if proc.returncode is not None else 1

        if return_code != 0 and not aborted:
            output = "\n".join(errors[-5:])
            if not output:
                output = last_current or f"gallery-dl exited with code {return_code}"
            if "No module named gallery_dl" in output:
                output = "gallery-dl is not installed. Install Python dependencies before using Twitter/X grab."
            errors.append(output)

        _progress(
            progress_cb,
            scope="grab-site",
            stage="download",
            done=min(limit, downloaded + skipped),
            total=limit,
            current=os.path.basename(last_current) if last_current else f"@{username}",
            saved=downloaded,
            failed=1 if return_code != 0 and not aborted else 0,
        )

        return {
            "success": return_code == 0 and not aborted,
            "output_dir": user_dir,
            "downloaded": downloaded,
            "skipped": skipped,
            "failed": 1 if return_code != 0 and not aborted else 0,
            "errors": errors[-10:],
            "aborted": aborted,
        }
    except FileNotFoundError:
        return {
            "success": False,
            "output_dir": user_dir,
            "downloaded": 0,
            "skipped": skipped,
            "failed": 1,
            "errors": ["Python executable not found"],
        }
    except Exception as exc:
        return {
            "success": False,
            "output_dir": user_dir,
            "downloaded": 0,
            "skipped": skipped,
            "failed": 1,
            "errors": [str(exc)],
        }
    finally:
        if cfg_path:
            try:
                os.remove(cfg_path)
            except Exception:
                pass


def _pixiv_entry_ids(session, mode, query, cookie, start_page, end_page, limit):
    mode = str(mode or "user")
    if mode == "user":
        user_id = _extract_first_id(query, r"users/(\d+)")
        if not user_id:
            return []
        profile = _pixiv_get_json(session, f"/ajax/user/{user_id}/profile/all", cookie)
        ids = []
        if isinstance(profile.get("illusts"), dict):
            ids.extend(profile["illusts"].keys())
        if isinstance(profile.get("manga"), dict):
            ids.extend(profile["manga"].keys())
        ids = sorted(set(ids), key=lambda val: int(val), reverse=True)
        start = max(0, (start_page - 1) * 48)
        end = end_page * 48 if end_page else len(ids)
        return ids[start:end][:limit]

    if mode == "search":
        word = _normalize_pixiv_search_word(query)
        if not word:
            return []
        ids = []
        for page in range(start_page, end_page + 1):
            encoded_word = quote(word, safe="")
            body = _pixiv_get_json(
                session,
                f"/ajax/search/artworks/{encoded_word}",
                cookie,
                params={
                    "word": word,
                    "order": "date_d",
                    "mode": "all",
                    "p": page,
                    "s_mode": "s_tag",
                    "type": "all",
                    "lang": "ja",
                },
                referer=f"{PIXIV_BASE}/tags/{encoded_word}/artworks",
            )
            blocks = [
                body.get("illustManga", {}) if isinstance(body, dict) else {},
                body.get("illust", {}) if isinstance(body, dict) else {},
                body.get("manga", {}) if isinstance(body, dict) else {},
            ]
            page_ids = []
            for block in blocks:
                for item in block.get("data") or []:
                    item_id = str(item.get("id") or "")
                    if item_id:
                        page_ids.append(item_id)
            ids.extend(page_ids)
            if len(ids) >= limit or not page_ids:
                break
        return list(dict.fromkeys(ids))[:limit]

    raise RuntimeError(f"unsupported Pixiv mode: {mode}")


def _pixiv_tags(detail):
    tags = detail.get("tags", {}).get("tags", [])
    return [str(item.get("tag") or "") for item in tags if item.get("tag")]


def _pixiv_bookmark_count(detail):
    for key in ("bookmarkCount", "bookmark_count", "totalBookmarks", "total_bookmarks", "bookmarks"):
        value = detail.get(key)
        if isinstance(value, dict):
            value = value.get("total") or value.get("count")
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _skip_reason_counts(items):
    counts = {}
    for item in items:
        reason = str(item.get("reason") or "other")
        counts[reason] = counts.get(reason, 0) + 1
    return counts


def _pixiv_original_urls(session, detail, cookie):
    urls = detail.get("urls") or {}
    original = urls.get("original")
    if original:
        page_count = max(1, int(detail.get("pageCount") or 1))
        return [original.replace("_p0", f"_p{page}") for page in range(page_count)]

    art_id = str(detail.get("id") or "")
    if not art_id:
        return []

    pages = _pixiv_get_json(session, f"/ajax/illust/{art_id}/pages", cookie)
    result = []
    for item in pages or []:
        page_urls = item.get("urls") or {}
        page_original = page_urls.get("original")
        if page_original:
            result.append(page_original)
    return result


def _pixiv_detail_to_tasks(session, detail, cookie, output_dir, ugoira, resume_ids):
    art_id = str(detail.get("id") or "")
    artist = _sanitize_name(detail.get("userName") or detail.get("userId") or "unknown")
    title = _sanitize_name(detail.get("illustTitle") or art_id, fallback=art_id)
    illust_type = int(detail.get("illustType") or 0)
    artist_dir = os.path.join(output_dir, "pixiv", artist)
    _ensure_dir(artist_dir)

    if illust_type == 2:
        if ugoira == "skip":
            return [], [{"id": art_id, "reason": "ugoira skipped"}]
        meta = _pixiv_get_json(session, f"/ajax/illust/{art_id}/ugoira_meta", cookie)
        zip_url = meta.get("originalSrc") or meta.get("src")
        if not zip_url:
            return [], [{"id": art_id, "reason": "ugoira zip url missing"}]
        key = f"{art_id}_ugoira"
        if key in resume_ids:
            return [], [{"id": art_id, "reason": "resume"}]
        filename = _sanitize_name(f"{artist}_{title}_{art_id}_ugoira", fallback=art_id) + ".zip"
        path = _unique_path(os.path.join(artist_dir, filename))
        return [{
            "url": zip_url,
            "path": path,
            "filename": os.path.basename(path),
            "resume_key": key,
            "headers": _pixiv_headers(cookie),
        }], []

    original_urls = _pixiv_original_urls(session, detail, cookie)
    if not original_urls:
        return [], [{"id": art_id, "reason": "original url missing"}]

    tasks = []
    skipped = []
    for page, url in enumerate(original_urls):
        key = f"{art_id}_p{page}"
        if key in resume_ids:
            skipped.append({"id": key, "reason": "resume"})
            continue
        ext = _url_ext(url)
        filename = _sanitize_name(f"{artist}_{title}_{art_id}_p{page}", fallback=art_id) + ext
        path = _unique_path(os.path.join(artist_dir, filename))
        tasks.append({
            "url": url,
            "path": path,
            "filename": os.path.basename(path),
            "resume_key": key,
            "headers": _pixiv_headers(cookie),
        })
    return tasks, skipped


def _pixiv_id_to_tasks(art_id, cookie, output_root, ugoira, resume_ids, min_bookmarks=0):
    session = requests.Session()
    detail = _pixiv_get_json(session, f"/ajax/illust/{art_id}", cookie, params={"lang": "ja"})
    bookmark_count = _pixiv_bookmark_count(detail)
    if min_bookmarks > 0 and bookmark_count is not None and bookmark_count < min_bookmarks:
        return art_id, [], [{
            "id": art_id,
            "reason": "bookmarks",
            "bookmarks": bookmark_count,
            "min_bookmarks": min_bookmarks,
        }]
    item_tasks, item_skipped = _pixiv_detail_to_tasks(
        session, detail, cookie, output_root, ugoira, resume_ids
    )
    return art_id, item_tasks, item_skipped


def run_pixiv_download(body, progress_cb=None, cancel_event=None):
    output_root = str(body.get("output_dir") or "").strip()
    cookie = str(body.get("cookie") or "").strip()
    query = str(body.get("query") or "").strip()
    mode = str(body.get("mode") or "user").strip()
    if not output_root:
        return {"success": False, "error": "no output directory specified"}
    if not cookie:
        return {"success": False, "error": "Pixiv cookie is required"}
    if not query:
        return {"success": False, "error": "Pixiv query is required"}
    if mode not in {"user", "search"}:
        return {"success": False, "error": f"unsupported Pixiv mode: {mode}", "output_dir": output_root}

    limit = _clamp_int(body.get("limit"), 48, 1, 5000)
    min_bookmarks = _clamp_int(body.get("min_bookmarks"), 0, 0, 999999999)
    start_page = _clamp_int(body.get("start_page"), 1, 1, 500)
    end_page = _clamp_int(body.get("end_page"), start_page, start_page, 500)
    ugoira = str(body.get("ugoira") or "skip").lower()
    if ugoira not in {"skip", "zip"}:
        ugoira = "skip"
    enable_resume = bool(body.get("enable_resume", True))

    pixiv_root = os.path.join(output_root, "pixiv")
    _ensure_dir(pixiv_root)
    resume_path = os.path.join(pixiv_root, "_downloaded.json")
    resume_ids = _load_resume(resume_path) if enable_resume else set()

    session = requests.Session()
    errors = []
    skipped = []
    tasks = []

    _progress(
        progress_cb,
        scope="grab-site",
        stage="collect",
        done=0,
        total=limit,
        current="Pixiv 读取入口",
    )

    try:
        ids = _pixiv_entry_ids(session, mode, query, cookie, start_page, end_page, limit)
    except Exception as exc:
        return {"success": False, "error": str(exc), "output_dir": pixiv_root}

    total = max(1, len(ids))
    if ids:
        for done_count, art_id in enumerate(ids, start=1):
            if _is_cancelled(cancel_event):
                break
            try:
                _, item_tasks, item_skipped = _pixiv_id_to_tasks(
                    art_id, cookie, output_root, ugoira, resume_ids, min_bookmarks
                )
                tasks.extend(item_tasks)
                skipped.extend(item_skipped)
            except Exception as exc:
                errors.append(f"{art_id}: {exc}")
            _progress(
                progress_cb,
                scope="grab-site",
                stage="collect",
                done=done_count,
                total=total,
                current=f"Pixiv {art_id}",
            )
            if done_count < total:
                time.sleep(PIXIV_REQUEST_DELAY)

    saved, failed, results = _download_tasks(
        tasks,
        0,
        max(1, len(tasks)),
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        resume_path=resume_path if enable_resume else "",
        resume_ids=resume_ids,
    )

    return {
        "success": not _is_cancelled(cancel_event),
        "output_dir": pixiv_root,
        "downloaded": saved,
        "skipped": len(skipped),
        "skip_reasons": _skip_reason_counts(skipped),
        "failed": failed + len(errors),
        "errors": errors + [r.get("error", "") for r in results if r.get("error")],
        "aborted": _is_cancelled(cancel_event),
    }
