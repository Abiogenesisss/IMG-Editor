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


def _preprocess(image_path, size):
    img = Image.open(image_path).convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.paste(img, mask=img)
    img = bg.convert("RGB").resize(size, Image.BILINEAR)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = np.transpose(arr, (2, 0, 1))
    arr = (arr - 0.5) / 0.5
    return np.expand_dims(arr.astype(np.float32), 0)


def _predict_scores(model_key, image_path):
    bundle = _load_model(model_key)
    session = bundle["session"]
    labels = bundle["labels"]
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    data = _preprocess(image_path, _target_size(session))
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


def _round_scores(scores):
    return {label: round(float(score), 6) for label, score in scores.items()}


def analyze_batch(files, classifier_model_key, aesthetic_model_key,
                  allowed_classes=None, class_threshold=0.0,
                  min_score=5.0, score_only_passed=True,
                  progress_cb=None, cancel_event=None):
    allowed = set(allowed_classes or [])
    total = len(files)
    results = []

    for index, file_path in enumerate(files):
        if cancel_event is not None and cancel_event.is_set():
            break

        try:
            class_scores = _predict_scores(classifier_model_key, file_path)
            class_label, class_confidence = _top_label(class_scores)
            class_passed = (
                (not allowed or class_label in allowed)
                and class_confidence >= float(class_threshold or 0)
            )

            aesthetic_scores = {}
            aesthetic_label = ""
            aesthetic_confidence = 0.0
            score = None
            low_score = False

            if class_passed or not score_only_passed:
                aesthetic_scores = _predict_scores(aesthetic_model_key, file_path)
                aesthetic_label, aesthetic_confidence = _top_label(aesthetic_scores)
                score = _aesthetic_score(aesthetic_scores)
                low_score = score < float(min_score)

            results.append({
                "file": file_path,
                "ok": True,
                "class_label": class_label,
                "class_confidence": round(class_confidence, 6),
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
