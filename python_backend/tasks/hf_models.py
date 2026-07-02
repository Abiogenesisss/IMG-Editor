import os
import ssl
import urllib.error
import urllib.request


HF_MIRROR = "https://hf-mirror.com"
USER_AGENT = "IMG_Editor/1.0"


def model_dir(model_root, model_key):
    return os.path.join(model_root, model_key)


def list_model_status(models, model_root, files_for_model, extra_fields=()):
    result = []
    for key, info in models.items():
        target_dir = model_dir(model_root, key)
        files = files_for_model(info)
        item = {
            "key": key,
            "name": info["name"],
            "repo": info["repo"],
            "downloaded": all(os.path.exists(os.path.join(target_dir, local)) for _, local in files),
        }
        for field in extra_fields:
            if field in info:
                item[field] = info[field]
        result.append(item)
    return result


def hf_endpoint(info):
    if info.get("requires_auth"):
        return "https://huggingface.co"
    return os.environ.get("HF_ENDPOINT", HF_MIRROR).rstrip("/")


def download_file(url, target_path, progress_cb=None, token=""):
    ctx = ssl.create_default_context()
    headers = {"User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    tmp_path = target_path + ".tmp"

    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    downloaded = 0
    chunk_size = 1024 * 1024

    with urllib.request.urlopen(req, context=ctx) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        with open(tmp_path, "wb") as f:
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if progress_cb and total > 0:
                    progress_cb(downloaded, total)

    os.replace(tmp_path, target_path)


def download_model_files(
    model_key,
    models,
    model_root,
    files_for_model,
    remote_path_for_file=None,
    progress_cb=None,
    auth_token="",
):
    if model_key not in models:
        return {"ok": False, "error": f"unknown model: {model_key}"}

    info = models[model_key]
    token = str(auth_token or "").strip()
    if info.get("requires_auth") and not token:
        return {
            "ok": False,
            "error": (
                "此模型需要 Hugging Face 授权。请先在网页同意模型条款，"
                "然后输入 token 重试下载。"
            ),
            "auth_required": True,
        }

    target_dir = model_dir(model_root, model_key)
    os.makedirs(target_dir, exist_ok=True)

    files = files_for_model(info)
    total_steps = len(files)

    for step, (remote_name, local_name) in enumerate(files):
        target_path = os.path.join(target_dir, local_name)
        if os.path.exists(target_path):
            if progress_cb:
                progress_cb(step + 1, total_steps, local_name, 1, 1)
            continue

        remote_path = (
            remote_path_for_file(info, remote_name) if remote_path_for_file else remote_name
        )
        url = f"{hf_endpoint(info)}/{info['repo']}/resolve/main/{remote_path}"

        def file_progress(downloaded, total, _name=local_name, _step=step):
            if progress_cb:
                progress_cb(_step + 1, total_steps, _name, downloaded, total)

        try:
            download_file(url, target_path, progress_cb=file_progress, token=token)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                return {
                    "ok": False,
                    "error": (
                        f"模型下载未授权({exc.code})：请确认已在 Hugging Face 同意模型条款，"
                        "并输入有效 token。"
                    ),
                    "auth_required": True,
                }
            raise

    return {"ok": True}
