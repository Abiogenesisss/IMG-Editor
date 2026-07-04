"""Image clustering helpers for style, semantic, and fusion features."""

import os
import shutil
import numpy as np
from PIL import Image

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_MODEL_PATH = os.path.join(_BACKEND_DIR, "models", "csd_clip_model.onnx")


# ==================== Color histogram features ====================

def extract_color_one(file_path):
    """Extract HSV color histogram features from one image."""
    try:
        img = Image.open(file_path).convert("RGB")
        img = img.resize((128, 128))
        hsv = np.array(img.convert("HSV"))
        h_hist, _ = np.histogram(hsv[:, :, 0], bins=32, range=(0, 256))
        s_hist, _ = np.histogram(hsv[:, :, 1], bins=16, range=(0, 256))
        v_hist, _ = np.histogram(hsv[:, :, 2], bins=16, range=(0, 256))
        feat = np.concatenate([h_hist, s_hist, v_hist]).astype(np.float32)
        norm = np.linalg.norm(feat)
        if norm > 0:
            feat = feat / norm
        return {"file": file_path, "ok": True, "feature": feat.tolist()}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}


# ==================== CSD style / semantic features ====================

_csd_session = None


def cleanup_cache():
    """Release cached CSD models."""
    global _csd_session
    _csd_session = None


_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32).reshape(3, 1, 1)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32).reshape(3, 1, 1)


def _get_session_input_dtype(session):
    """Choose numpy dtype based on the ONNX model input declaration."""
    input_type = session.get_inputs()[0].type
    if input_type == "tensor(float16)":
        return np.float16
    if input_type == "tensor(float)":
        return np.float32
    raise RuntimeError(f"unsupported CSD input type: {input_type}")


def _l2_normalize_rows(features):
    """L2-normalize row-wise to reduce provider / precision drift."""
    features = np.asarray(features, dtype=np.float32)
    if features.ndim == 1:
        features = features.reshape(1, -1)
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return features / norms


def _preprocess_image(img):
    """CLIP ViT-L/14 preprocessing with PIL + numpy only."""
    w, h = img.size
    if w <= h:
        new_w, new_h = 224, int(h * 224 / w)
    else:
        new_w, new_h = int(w * 224 / h), 224
    img = img.resize((new_w, new_h), Image.BICUBIC)

    w, h = img.size
    left = (w - 224) // 2
    top = (h - 224) // 2
    img = img.crop((left, top, left + 224, top + 224))

    arr = np.array(img, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)
    arr = (arr - _CLIP_MEAN) / _CLIP_STD
    return arr


def _load_csd(model_path=None):
    """Load the ONNX CSD model."""
    global _csd_session
    if _csd_session is not None:
        return _csd_session

    import onnxruntime as ort

    onnx_path = model_path or _DEFAULT_MODEL_PATH
    if model_path and not model_path.lower().endswith(".onnx"):
        raise RuntimeError(f"unsupported cluster model format: {model_path}")
    if not os.path.isfile(onnx_path):
        raise RuntimeError(
            f"cannot find CSD ONNX model: {onnx_path}\n"
            "please place csd_clip_model.onnx in python_backend/models/"
        )

    # Clustering stays on CPU to avoid fp16 CUDA drift changing group assignments.
    _csd_session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    return _csd_session


def _extract_clip_feats(outputs):
    clip_feats = outputs[0].astype(np.float32)
    norms = np.linalg.norm(clip_feats, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return clip_feats / norms


def _extract_csd_batch(
    files,
    model_path=None,
    batch_size=16,
    progress_cb=None,
    feature_fn=None,
    cancel_event=None,
):
    session = _load_csd(model_path)
    input_name = session.get_inputs()[0].name
    input_dtype = _get_session_input_dtype(session)
    total = len(files)
    results = [None] * total
    done = 0

    for i in range(0, total, batch_size):
        if cancel_event is not None and cancel_event.is_set():
            from tasks.parallel import CancelledError

            raise CancelledError("task cancelled")
        batch_files = files[i:i + batch_size]
        arrays = []
        indices = []

        for j, f in enumerate(batch_files):
            try:
                img = Image.open(f).convert("RGB")
                arrays.append(_preprocess_image(img))
                indices.append(i + j)
            except Exception as e:
                results[i + j] = {"file": f, "ok": False, "error": str(e)}

        if arrays:
            batch = np.stack(arrays).astype(input_dtype, copy=False)
            outputs = session.run(None, {input_name: batch})
            features = feature_fn(outputs)
            for k, idx in enumerate(indices):
                results[idx] = {
                    "file": files[idx],
                    "ok": True,
                    "feature": features[k].tolist(),
                }

        done += len(batch_files)
        if progress_cb:
            progress_cb(done, total)

    for i in range(len(results)):
        if results[i] is None:
            results[i] = {"file": files[i], "ok": False, "error": "unknown error"}

    return results


def extract_style_batch(
    files, model_path=None, batch_size=16, progress_cb=None, cancel_event=None
):
    """Batch-extract CSD style features."""
    return _extract_csd_batch(
        files,
        model_path=model_path,
        batch_size=batch_size,
        progress_cb=progress_cb,
        feature_fn=lambda outputs: _l2_normalize_rows(outputs[2]),
        cancel_event=cancel_event,
    )


def extract_semantic_batch(
    files, model_path=None, batch_size=16, progress_cb=None, cancel_event=None
):
    """Batch-extract CLIP semantic features."""
    return _extract_csd_batch(
        files,
        model_path=model_path,
        batch_size=batch_size,
        progress_cb=progress_cb,
        feature_fn=_extract_clip_feats,
        cancel_event=cancel_event,
    )


def extract_fusion_batch(
    files,
    model_path=None,
    batch_size=16,
    progress_cb=None,
    weight_style=0.0,
    weight_semantic=0.0,
    weight_color=0.0,
    cancel_event=None,
):
    """Extract fused features by concatenating style/semantic/color vectors."""
    total = len(files)

    style_results = None
    semantic_results = None
    color_results = None

    methods_needed = []
    if weight_style > 0:
        methods_needed.append("style")
    if weight_semantic > 0:
        methods_needed.append("semantic")
    if weight_color > 0:
        methods_needed.append("color")

    steps_done = 0
    total_steps = len(methods_needed) * total

    def sub_progress(d, t):
        nonlocal steps_done
        if progress_cb:
            progress_cb(steps_done + d, total_steps)

    if weight_style > 0:
        style_results = extract_style_batch(
            files, model_path, batch_size, sub_progress, cancel_event
        )
        steps_done += total
    if weight_semantic > 0:
        semantic_results = extract_semantic_batch(
            files, model_path, batch_size, sub_progress, cancel_event
        )
        steps_done += total
    if weight_color > 0:
        from tasks.parallel import run_parallel

        color_results = run_parallel(
            extract_color_one,
            [(f,) for f in files],
            sub_progress,
            cancel_event=cancel_event,
        )
        steps_done += total

    results = []
    for i in range(total):
        parts = []
        ok = True
        file_path = files[i]

        if style_results and style_results[i].get("ok"):
            parts.append(np.array(style_results[i]["feature"]) * weight_style)
        elif style_results:
            ok = False

        if semantic_results and semantic_results[i].get("ok"):
            parts.append(np.array(semantic_results[i]["feature"]) * weight_semantic)
        elif semantic_results:
            ok = False

        if color_results and color_results[i].get("ok"):
            parts.append(np.array(color_results[i]["feature"]) * weight_color)
        elif color_results:
            ok = False

        if ok and parts:
            fused = np.concatenate(parts).astype(np.float32)
            norm = np.linalg.norm(fused)
            if norm > 0:
                fused = fused / norm
            results.append({"file": file_path, "ok": True, "feature": fused.tolist()})
        else:
            results.append({"file": file_path, "ok": False, "error": "fusion failed"})

    return results


# ==================== Clustering algorithms ====================

def _build_result(feature_results, valid, labels):
    """Map cluster labels back to the full result list."""
    label_map = {}
    for (orig_i, _), label in zip(valid, labels):
        label_map[orig_i] = int(label)
    return [{"file": r["file"], "group": label_map.get(i)} for i, r in enumerate(feature_results)]


def cluster_features(feature_results, algorithm="kmeans", k=5):
    """Cluster feature vectors and return [{file, group}, ...]."""
    valid = [(i, r) for i, r in enumerate(feature_results) if r.get("ok")]
    if len(valid) == 0:
        return [{"file": r["file"], "group": None} for r in feature_results]

    if len(valid) == 1:
        return _build_result(feature_results, valid, [0])

    features = _l2_normalize_rows([r["feature"] for _, r in valid])

    if algorithm == "hdbscan":
        from sklearn.cluster import HDBSCAN
        from sklearn.decomposition import PCA

        n_samples, n_dims = features.shape
        pca_target = min(50, n_samples - 1, n_dims)
        if pca_target >= 2 and n_dims > pca_target:
            features = PCA(n_components=pca_target, random_state=42).fit_transform(features)

        min_cs = max(2, n_samples // max(k, 2))
        hdb = HDBSCAN(min_cluster_size=min_cs, min_samples=1)
        raw_labels = hdb.fit_predict(features)

        if all(lb == -1 for lb in raw_labels):
            from sklearn.cluster import MiniBatchKMeans

            actual_k = max(2, min(k, n_samples))
            mbk = MiniBatchKMeans(
                n_clusters=actual_k,
                n_init=10,
                random_state=42,
                batch_size=min(1024, n_samples),
            )
            labels = mbk.fit_predict(features)
            return _build_result(feature_results, valid, labels)

        labels = [int(lb) if lb >= 0 else None for lb in raw_labels]
        label_map = {}
        for (orig_i, _), label in zip(valid, labels):
            label_map[orig_i] = label
        return [{"file": r["file"], "group": label_map.get(i)} for i, r in enumerate(feature_results)]

    from sklearn.cluster import MiniBatchKMeans

    actual_k = max(2, min(k, len(valid)))
    n_samples = len(valid)
    mbk = MiniBatchKMeans(
        n_clusters=actual_k,
        n_init=10,
        random_state=42,
        batch_size=min(1024, n_samples),
    )
    labels = mbk.fit_predict(features)
    return _build_result(feature_results, valid, labels)


# ==================== Copy clustered files ====================

def copy_files_to_groups(files_by_group, output_dir):
    """Copy files into group_1/, group_2/, ... folders."""
    copied = 0
    errors = []

    for group_str, files in files_by_group.items():
        group_dir = os.path.join(output_dir, f"group_{int(group_str) + 1}")
        os.makedirs(group_dir, exist_ok=True)
        seen_names = set()
        for f in files:
            try:
                base = os.path.basename(f)
                name, ext = os.path.splitext(base)
                dst_name = base
                counter = 1
                while dst_name in seen_names:
                    dst_name = f"{name}_{counter}{ext}"
                    counter += 1
                seen_names.add(dst_name)
                dst = os.path.join(group_dir, dst_name)
                shutil.copy2(f, dst)
                copied += 1
            except Exception as e:
                errors.append({"file": f, "error": str(e)})

    return {"success": True, "copied": copied, "errors": errors}
