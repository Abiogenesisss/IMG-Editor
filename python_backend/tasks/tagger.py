"""
WD Tagger — 基于 WaifuDiffusion 模型的图像自动打标
支持从 HuggingFace 下载模型，ONNX 推理，批量打标
"""

import os
import csv
import urllib.request
import ssl
import numpy as np
from PIL import Image

# 可用模型列表
MODELS = {
    # ---- v3 系列 ----
    "wd-eva02-large-v3": {
        "repo": "SmilingWolf/wd-eva02-large-tagger-v3",
        "name": "wd-eva02-large-tagger-v3",
    },
    "wd-vit-large-v3": {
        "repo": "SmilingWolf/wd-vit-large-tagger-v3",
        "name": "wd-vit-large-tagger-v3",
    },
    "wd-swinv2-v3": {
        "repo": "SmilingWolf/wd-swinv2-tagger-v3",
        "name": "wd-swinv2-tagger-v3",
    },
    "wd-convnext-v3": {
        "repo": "SmilingWolf/wd-convnext-tagger-v3",
        "name": "wd-convnext-tagger-v3",
    },
    "wd-vit-v3": {
        "repo": "SmilingWolf/wd-vit-tagger-v3",
        "name": "wd-vit-tagger-v3",
    },
    # ---- v2 系列 ----
    "wd-v1-4-swinv2-v2": {
        "repo": "SmilingWolf/wd-v1-4-swinv2-tagger-v2",
        "name": "wd-v1-4-swinv2-tagger-v2",
    },
    "wd-v1-4-moat-v2": {
        "repo": "SmilingWolf/wd-v1-4-moat-tagger-v2",
        "name": "wd-v1-4-moat-tagger-v2",
    },
    "wd-v1-4-convnext-v2": {
        "repo": "SmilingWolf/wd-v1-4-convnext-tagger-v2",
        "name": "wd-v1-4-convnext-tagger-v2",
    },
    "wd-v1-4-convnextv2-v2": {
        "repo": "SmilingWolf/wd-v1-4-convnextv2-tagger-v2",
        "name": "wd-v1-4-convnextv2-tagger-v2",
    },
    "wd-v1-4-vit-v2": {
        "repo": "SmilingWolf/wd-v1-4-vit-tagger-v2",
        "name": "wd-v1-4-vit-tagger-v2",
    },
}

# 模型存储目录
MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "tagger")

# 已加载的模型缓存（避免重复加载）
_loaded_session = None
_loaded_model_key = None
_loaded_tags = None


def cleanup_cache():
    """释放缓存的 Tagger 模型"""
    global _loaded_session, _loaded_model_key, _loaded_tags
    _loaded_session = None
    _loaded_model_key = None
    _loaded_tags = None


def _get_model_dir(model_key):
    return os.path.join(MODEL_DIR, model_key)


def list_models():
    """列出所有可用模型及其下载状态"""
    result = []
    for key, info in MODELS.items():
        d = _get_model_dir(key)
        model_exists = os.path.exists(os.path.join(d, "model.onnx"))
        tags_exists = os.path.exists(os.path.join(d, "selected_tags.csv"))
        result.append({
            "key": key,
            "name": info["name"],
            "repo": info["repo"],
            "downloaded": model_exists and tags_exists,
        })
    return result


def _download_file(url, target_path, progress_cb=None):
    """下载单个文件，支持进度回调 progress_cb(downloaded_bytes, total_bytes)"""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "IMG_Editor/1.0"})
    resp = urllib.request.urlopen(req, context=ctx)
    total = int(resp.headers.get("Content-Length", 0))

    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    downloaded = 0
    chunk_size = 1024 * 1024  # 1MB

    with open(target_path + ".tmp", "wb") as f:
        while True:
            chunk = resp.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            if progress_cb and total > 0:
                progress_cb(downloaded, total)

    # 下载完成后重命名
    if os.path.exists(target_path):
        os.remove(target_path)
    os.rename(target_path + ".tmp", target_path)


def download_model(model_key, progress_cb=None):
    """
    从 HuggingFace 下载模型文件
    progress_cb(step, total_steps, file_name, downloaded_bytes, total_bytes)
    """
    if model_key not in MODELS:
        return {"ok": False, "error": f"未知模型: {model_key}"}

    info = MODELS[model_key]
    repo_id = info["repo"]
    target_dir = _get_model_dir(model_key)
    os.makedirs(target_dir, exist_ok=True)

    files_to_download = ["model.onnx", "selected_tags.csv"]
    total_steps = len(files_to_download)

    for step, filename in enumerate(files_to_download):
        target_path = os.path.join(target_dir, filename)
        if os.path.exists(target_path):
            if progress_cb:
                progress_cb(step + 1, total_steps, filename, 1, 1)
            continue

        url = f"https://hf-mirror.com/{repo_id}/resolve/main/{filename}"

        def file_progress(downloaded, total, _fn=filename, _step=step):
            if progress_cb:
                progress_cb(_step + 1, total_steps, _fn, downloaded, total)

        _download_file(url, target_path, progress_cb=file_progress)

    return {"ok": True}


def _load_model(model_key):
    """加载 ONNX 模型和标签列表（带缓存）"""
    global _loaded_session, _loaded_model_key, _loaded_tags

    if _loaded_model_key == model_key and _loaded_session is not None:
        return _loaded_session, _loaded_tags

    import onnxruntime as ort

    model_dir = _get_model_dir(model_key)
    model_path = os.path.join(model_dir, "model.onnx")
    tags_path = os.path.join(model_dir, "selected_tags.csv")

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"模型文件不存在: {model_path}")
    if not os.path.exists(tags_path):
        raise FileNotFoundError(f"标签文件不存在: {tags_path}")

    # 加载 ONNX 模型
    providers = []
    if "CUDAExecutionProvider" in ort.get_available_providers():
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    session = ort.InferenceSession(model_path, providers=providers)

    # 加载标签
    tags = []
    with open(tags_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tags.append({
                "name": row["name"],
                "category": int(row["category"]),
            })

    _loaded_session = session
    _loaded_model_key = model_key
    _loaded_tags = tags

    return session, tags


def _preprocess(image_path, target_size):
    """预处理图片为模型输入格式"""
    img = Image.open(image_path).convert("RGBA")
    # 合成白色背景
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.paste(img, mask=img)
    img = bg.convert("RGB")

    # 填充为正方形
    w, h = img.size
    max_dim = max(w, h, target_size)
    canvas = Image.new("RGB", (max_dim, max_dim), (255, 255, 255))
    canvas.paste(img, ((max_dim - w) // 2, (max_dim - h) // 2))

    # 缩放到目标尺寸
    if max_dim != target_size:
        canvas = canvas.resize((target_size, target_size), Image.LANCZOS)

    # 转 numpy, RGB → BGR, float32
    arr = np.array(canvas, dtype=np.float32)
    arr = arr[:, :, ::-1]  # RGB → BGR
    arr = np.expand_dims(arr, 0)
    return arr


def _tag_one(session, tags, input_name, target_size, image_path,
             general_threshold, character_threshold):
    """对单张图片执行推理并返回标签"""
    try:
        img_arr = _preprocess(image_path, target_size)
        outputs = session.run(None, {input_name: img_arr})
        probs = outputs[0][0]

        general_tags = []
        character_tags = []
        rating_tags = []

        for i, tag_info in enumerate(tags):
            if i >= len(probs):
                break
            prob = float(probs[i])
            name = tag_info["name"]
            category = tag_info["category"]

            if category == 9:  # rating
                rating_tags.append({"name": name, "confidence": round(prob, 4)})
            elif category == 4:  # character
                if prob >= character_threshold:
                    character_tags.append({"name": name, "confidence": round(prob, 4)})
            else:  # general (category 0)
                if prob >= general_threshold:
                    general_tags.append({"name": name, "confidence": round(prob, 4)})

        general_tags.sort(key=lambda x: x["confidence"], reverse=True)
        character_tags.sort(key=lambda x: x["confidence"], reverse=True)
        rating_tags.sort(key=lambda x: x["confidence"], reverse=True)

        # 组合标签字符串：角色标签在前，通用标签在后
        all_names = [t["name"] for t in character_tags] + [t["name"] for t in general_tags]
        tag_string = ", ".join(all_names)

        return {
            "file": image_path,
            "ok": True,
            "general": general_tags,
            "character": character_tags,
            "rating": rating_tags,
            "tag_string": tag_string,
        }
    except Exception as e:
        return {"file": image_path, "ok": False, "error": str(e)}


def tag_batch(files, model_key, general_threshold=0.35, character_threshold=0.85,
              progress_cb=None):
    """
    批量打标（主进程内顺序执行，避免多进程重复加载模型）
    progress_cb(done, total)
    """
    session, tags = _load_model(model_key)

    input_shape = session.get_inputs()[0].shape
    target_size = input_shape[2] if isinstance(input_shape[2], int) else 448
    input_name = session.get_inputs()[0].name

    total = len(files)
    results = []

    for i, fpath in enumerate(files):
        result = _tag_one(session, tags, input_name, target_size, fpath,
                          general_threshold, character_threshold)
        results.append(result)
        if progress_cb:
            progress_cb(i + 1, total)

    return results
