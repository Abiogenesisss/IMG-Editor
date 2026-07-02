"""DeepGHS anime classifiers and aesthetic scorer."""

import json
import os

import numpy as np
from PIL import Image

from tasks.gpu_config import get_onnx_providers
from tasks.hf_models import download_model_files, list_model_status, model_dir


DEFAULT_FILES = [
    ("model.onnx", "model.onnx"),
    ("meta.json", "meta.json"),
]

AESTHETIC_WEIGHTS = {
    "masterpiece": 10.0,
    "best": 8.6,
    "great": 7.4,
    "good": 6.1,
    "normal": 4.6,
    "low": 2.4,
    "worst": 0.0,
}

MODELS = {
    "anime-classification-mobilenetv3-v1.5": {
        "kind": "classifier",
        "repo": "deepghs/anime_classification",
        "subdir": "mobilenetv3_v1.5_dist",
        "name": "anime_classification / mobilenetv3 v1.5",
        "labels": ["3d", "bangumi", "comic", "illustration", "not_painting"],
    },
    "anime-aesthetic-caformer-s36-v0": {
        "kind": "aesthetic",
        "repo": "deepghs/anime_aesthetic",
        "subdir": "caformer_s36_v0_ls0.2",
        "name": "anime_aesthetic / caformer s36 v0",
        "labels": ["masterpiece", "best", "great", "good", "normal", "low", "worst"],
    },
}

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "deepghs")

_loaded = {}


def cleanup_cache():
    _loaded.clear()


def _get_model_dir(model_key):
    return model_dir(MODEL_DIR, model_key)


def _model_files(_info):
    return DEFAULT_FILES


def list_models():
    return list_model_status(
        MODELS,
        MODEL_DIR,
        _model_files,
        extra_fields=("kind", "subdir", "labels"),
    )


def download_model(model_key, progress_cb=None):
    return download_model_files(
        model_key,
        MODELS,
        MODEL_DIR,
        _model_files,
        remote_path_for_file=lambda info, name: f"{info['subdir']}/{name}",
        progress_cb=progress_cb,
    )


def _load_meta(model_key, info):
    meta_path = os.path.join(_get_model_dir(model_key), "meta.json")
    if not os.path.exists(meta_path):
        return {"labels": info["labels"]}
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    if not meta.get("labels"):
        meta["labels"] = info["labels"]
    return meta


def _load_model(model_key):
    if model_key in _loaded:
        return _loaded[model_key]
    if model_key not in MODELS:
        raise ValueError(f"unknown model: {model_key}")

    import onnxruntime as ort

    info = MODELS[model_key]
    model_path = os.path.join(_get_model_dir(model_key), "model.onnx")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"model file not found: {model_path}")

    session = ort.InferenceSession(model_path, providers=get_onnx_providers())
    meta = _load_meta(model_key, info)
    labels = list(meta.get("labels") or info["labels"])

    bundle = {"session": session, "labels": labels, "info": info}
    _loaded[model_key] = bundle
    return bundle


def _target_size(session):
    shape = session.get_inputs()[0].shape
    if len(shape) == 4 and shape[1] == 3:
        height, width = shape[2], shape[3]
        if isinstance(height, int) and isinstance(width, int):
            return width, height
    return 384, 384


def _resize_for_model(img, size, letterbox=False):
    if not letterbox:
        return img.resize(size, Image.BILINEAR)

    target_w, target_h = size
    width, height = img.size
    if width <= 0 or height <= 0:
        return img.resize(size, Image.BILINEAR)

    scale = min(target_w / width, target_h / height)
    new_w = max(1, int(round(width * scale)))
    new_h = max(1, int(round(height * scale)))
    resized = img.resize((new_w, new_h), Image.BILINEAR)
    canvas = Image.new("RGB", size, (255, 255, 255))
    canvas.paste(resized, ((target_w - new_w) // 2, (target_h - new_h) // 2))
    return canvas


def _preprocess(image_path, size, letterbox=False):
    with Image.open(image_path) as source:
        img = source.convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.paste(img, mask=img)
    img = _resize_for_model(bg.convert("RGB"), size, letterbox=letterbox)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = np.transpose(arr, (2, 0, 1))
    arr = (arr - 0.5) / 0.5
    return np.expand_dims(arr.astype(np.float32), 0)


def _predict_scores(model_key, image_path, letterbox=False):
    bundle = _load_model(model_key)
    session = bundle["session"]
    labels = bundle["labels"]
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    data = _preprocess(image_path, _target_size(session), letterbox=letterbox)
    output = session.run([output_name], {input_name: data})[0][0]

    scores = {}
    for i, label in enumerate(labels):
        if i >= len(output):
            break
        scores[label] = float(output[i])
    return scores


def _top_label(scores):
    if not scores:
        return "", 0.0
    label = max(scores, key=scores.get)
    return label, float(scores[label])


def _best_allowed_label(scores, allowed):
    if not allowed:
        return "", 0.0
    return _top_label({label: score for label, score in scores.items() if label in allowed})


def _aesthetic_score(scores):
    total = 0.0
    weight_sum = 0.0
    for label, probability in scores.items():
        weight = AESTHETIC_WEIGHTS.get(label)
        if weight is None:
            continue
        total += float(probability) * weight
        weight_sum += float(probability)
    if weight_sum <= 0:
        return 0.0
    return round(total / weight_sum, 3)


def _aesthetic_allows_class_fallback(label, score):
    if score is None:
        return False
    if label in {"low", "worst"}:
        return False
    return float(score) >= 4.3


def _round_scores(scores):
    return {label: round(float(score), 6) for label, score in scores.items()}


def _as_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    return bool(value)


def _as_float(value, default):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(default)
    if not np.isfinite(number):
        return float(default)
    return number


def _normalize_allowed_classes(value):
    if isinstance(value, str):
        value = value.split(",")
    return {str(item).strip() for item in (value or []) if str(item).strip()}


def analyze_batch(files, classifier_model_key, aesthetic_model_key,
                  allowed_classes=None, class_threshold=0.0,
                  min_score=5.0, score_only_passed=True,
                  letterbox_preprocess=False,
                  relaxed_class_match=True, class_margin=0.18,
                  progress_cb=None, cancel_event=None):
    allowed = _normalize_allowed_classes(allowed_classes)
    threshold = max(0.0, _as_float(class_threshold, 0.0))
    min_score_value = max(0.0, min(10.0, _as_float(min_score, 5.0)))
    margin = max(0.0, _as_float(class_margin, 0.18))
    score_only_passed = _as_bool(score_only_passed, True)
    letterbox_preprocess = _as_bool(letterbox_preprocess, False)
    relaxed_class_match = _as_bool(relaxed_class_match, True)
    total = len(files)
    results = []

    for index, file_path in enumerate(files):
        if cancel_event is not None and cancel_event.is_set():
            break

        try:
            class_scores = _predict_scores(
                classifier_model_key, file_path, letterbox=letterbox_preprocess
            )
            raw_class_label, raw_class_confidence = _top_label(class_scores)
            class_label = raw_class_label
            class_confidence = raw_class_confidence
            class_passed = not allowed or (
                raw_class_label in allowed and raw_class_confidence >= threshold
            )

            if allowed and not class_passed and relaxed_class_match:
                allowed_label, allowed_confidence = _best_allowed_label(class_scores, allowed)
                close_enough = (raw_class_confidence - allowed_confidence) <= margin
                strong_enough = allowed_confidence >= max(threshold, 0.08)
                if allowed_label and close_enough and strong_enough:
                    class_label = allowed_label
                    class_confidence = allowed_confidence
                    class_passed = True
                    class_fallback = "margin"
                else:
                    class_fallback = ""
            else:
                allowed_label = ""
                allowed_confidence = 0.0
                class_fallback = ""

            aesthetic_scores = {}
            aesthetic_label = ""
            aesthetic_confidence = 0.0
            score = None
            low_score = False

            should_score = (
                class_passed
                or not score_only_passed
                or (allowed and not class_passed and relaxed_class_match)
            )
            if should_score:
                aesthetic_scores = _predict_scores(
                    aesthetic_model_key, file_path, letterbox=letterbox_preprocess
                )
                aesthetic_label, aesthetic_confidence = _top_label(aesthetic_scores)
                score = _aesthetic_score(aesthetic_scores)
                low_score = score < min_score_value

                if allowed and not class_passed and relaxed_class_match:
                    if not allowed_label:
                        allowed_label, allowed_confidence = _best_allowed_label(class_scores, allowed)
                    allowed_strong_enough = allowed_confidence >= max(threshold, 0.05)
                    if (
                        allowed_label
                        and allowed_strong_enough
                        and _aesthetic_allows_class_fallback(aesthetic_label, score)
                    ):
                        class_label = allowed_label
                        class_confidence = allowed_confidence
                        class_passed = True
                        class_fallback = "aesthetic"

                if not class_passed and score_only_passed:
                    aesthetic_scores = {}
                    aesthetic_label = ""
                    aesthetic_confidence = 0.0
                    score = None
                    low_score = False

            results.append({
                "file": file_path,
                "ok": True,
                "class_label": class_label,
                "class_confidence": round(class_confidence, 6),
                "raw_class_label": raw_class_label,
                "raw_class_confidence": round(raw_class_confidence, 6),
                "class_fallback": class_fallback,
                "class_scores": _round_scores(class_scores),
                "class_passed": class_passed,
                "aesthetic_label": aesthetic_label,
                "aesthetic_confidence": round(aesthetic_confidence, 6),
                "aesthetic_scores": _round_scores(aesthetic_scores),
                "aesthetic_score": score,
                "low_score": low_score,
            })
        except Exception as exc:
            results.append({"file": file_path, "ok": False, "error": str(exc)})

        if progress_cb:
            progress_cb(index + 1, total)

    return results
