"""图片聚类：CSD 风格特征 / 颜色直方图 + MiniBatchKMeans（含融合、增量聚类）"""

import os
import shutil
import numpy as np
from PIL import Image

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_MODEL_PATH = os.path.join(_BACKEND_DIR, "models", "csd_clip_model.onnx")


# ==================== 颜色直方图特征 ====================

def extract_color_one(file_path):
    """提取单张图片的 HSV 颜色直方图特征（64维，L2 归一化）"""
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


# ==================== CSD 风格特征（ONNX 轻量推理） ====================

_csd_session = None


def cleanup_cache():
    """释放缓存的 CSD CLIP 模型"""
    global _csd_session
    _csd_session = None


_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32).reshape(3, 1, 1)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32).reshape(3, 1, 1)


def _preprocess_image(img):
    """CLIP ViT-L/14 预处理（纯 PIL + numpy，无 torch 依赖）"""
    # Resize：短边缩放到 224，保持长宽比，BICUBIC 插值
    w, h = img.size
    if w <= h:
        new_w, new_h = 224, int(h * 224 / w)
    else:
        new_w, new_h = int(w * 224 / h), 224
    img = img.resize((new_w, new_h), Image.BICUBIC)

    # CenterCrop 224×224
    w, h = img.size
    left = (w - 224) // 2
    top = (h - 224) // 2
    img = img.crop((left, top, left + 224, top + 224))

    # HWC uint8 → CHW float32 [0,1] → CLIP 标准化
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)  # HWC → CHW
    arr = (arr - _CLIP_MEAN) / _CLIP_STD
    return arr


def _load_csd(model_path=None):
    """加载 CSD ONNX 模型（本地文件优先，HuggingFace 兜底）"""
    global _csd_session
    if _csd_session is not None:
        return _csd_session

    import onnxruntime as ort

    onnx_path = model_path or _DEFAULT_MODEL_PATH
    if not os.path.isfile(onnx_path):
        raise RuntimeError(
            f"找不到 CSD ONNX 模型：{onnx_path}\n"
            "请将 csd_clip_model.onnx 放入 python_backend/models/ 目录"
        )

    available = ort.get_available_providers()
    providers = []
    if "CUDAExecutionProvider" in available:
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")

    _csd_session = ort.InferenceSession(onnx_path, providers=providers)
    return _csd_session


def extract_style_batch(files, model_path=None, batch_size=16, progress_cb=None):
    """批量提取 CSD 风格特征（ONNX 推理，无 torch 依赖）"""
    session = _load_csd(model_path)
    input_name = session.get_inputs()[0].name
    total = len(files)
    results = [None] * total
    done = 0

    for i in range(0, total, batch_size):
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
            batch = np.stack(arrays).astype(np.float16)
            outputs = session.run(None, {input_name: batch})
            # CSD 输出: [feature, content_output, style_output]
            style_feats = outputs[2]
            for k, idx in enumerate(indices):
                results[idx] = {
                    "file": files[idx], "ok": True,
                    "feature": style_feats[k].tolist(),
                }

        done += len(batch_files)
        if progress_cb:
            progress_cb(done, total)

    # 补全未处理的项
    for i in range(len(results)):
        if results[i] is None:
            results[i] = {"file": files[i], "ok": False, "error": "unknown error"}

    return results


def extract_semantic_batch(files, model_path=None, batch_size=16, progress_cb=None):
    """批量提取 CLIP 语义特征（完整 CLIP 嵌入，L2 归一化，无 torch 依赖）"""
    session = _load_csd(model_path)
    input_name = session.get_inputs()[0].name
    total = len(files)
    results = [None] * total
    done = 0

    for i in range(0, total, batch_size):
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
            batch = np.stack(arrays).astype(np.float16)
            outputs = session.run(None, {input_name: batch})
            # CSD 输出: [feature, content_output, style_output]
            # 使用 outputs[0]（完整 CLIP 嵌入）而非 outputs[1]（分离后的 content），语义表征更强
            clip_feats = outputs[0].astype(np.float32)
            # L2 归一化
            norms = np.linalg.norm(clip_feats, axis=1, keepdims=True)
            norms[norms == 0] = 1
            clip_feats = clip_feats / norms
            for k, idx in enumerate(indices):
                results[idx] = {
                    "file": files[idx], "ok": True,
                    "feature": clip_feats[k].tolist(),
                }

        done += len(batch_files)
        if progress_cb:
            progress_cb(done, total)

    for i in range(len(results)):
        if results[i] is None:
            results[i] = {"file": files[i], "ok": False, "error": "unknown error"}

    return results


def extract_fusion_batch(files, model_path=None, batch_size=16, progress_cb=None,
                         weight_style=0.0, weight_semantic=0.0, weight_color=0.0):
    """特征融合提取：按权重拼接 style/semantic/color 特征"""
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
        style_results = extract_style_batch(files, model_path, batch_size, sub_progress)
        steps_done += total
    if weight_semantic > 0:
        semantic_results = extract_semantic_batch(files, model_path, batch_size, sub_progress)
        steps_done += total
    if weight_color > 0:
        from server import run_parallel
        color_results = run_parallel(extract_color_one, [(f,) for f in files], sub_progress)
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


# ==================== 聚类算法 ====================

def _build_result(feature_results, valid, labels):
    """将聚类标签映射回完整结果列表"""
    label_map = {}
    for (orig_i, _), label in zip(valid, labels):
        label_map[orig_i] = int(label)
    return [{"file": r["file"], "group": label_map.get(i)} for i, r in enumerate(feature_results)]


def cluster_features(feature_results, algorithm="kmeans", k=5):
    """对特征向量执行聚类，返回 [{file, group}, ...]
    algorithm: 'kmeans' 或 'hdbscan'
    k: KMeans 的分组数；HDBSCAN 时用于推算 min_cluster_size
    """
    valid = [(i, r) for i, r in enumerate(feature_results) if r.get("ok")]
    if len(valid) == 0:
        return [{"file": r["file"], "group": None} for r in feature_results]

    features = np.array([r["feature"] for _, r in valid])

    if algorithm == "hdbscan":
        from sklearn.cluster import HDBSCAN
        from sklearn.decomposition import PCA

        # 高维特征（如 768 维 CLIP/CSD）会导致维度灾难，HDBSCAN 密度估计失效，
        # 需先用 PCA 降维到合理范围
        n_samples, n_dims = features.shape
        pca_target = min(50, n_samples - 1, n_dims)
        if pca_target >= 2 and n_dims > pca_target:
            features = PCA(n_components=pca_target, random_state=42).fit_transform(features)

        # 根据用户期望的分组数推算 min_cluster_size
        min_cs = max(2, n_samples // max(k, 2))
        hdb = HDBSCAN(min_cluster_size=min_cs, min_samples=1)
        raw_labels = hdb.fit_predict(features)

        # 如果 HDBSCAN 全标为噪声，回退到 KMeans 保证结果可用
        if all(lb == -1 for lb in raw_labels):
            from sklearn.cluster import MiniBatchKMeans
            actual_k = min(k, n_samples)
            if actual_k < 2:
                actual_k = min(2, n_samples)
            mbk = MiniBatchKMeans(
                n_clusters=actual_k, n_init=10, random_state=42,
                batch_size=min(1024, n_samples)
            )
            labels = mbk.fit_predict(features)
            return _build_result(feature_results, valid, labels)

        # HDBSCAN 噪声点标签为 -1，映射为 None；int() 避免 numpy.int64 序列化问题
        labels = [int(lb) if lb >= 0 else None for lb in raw_labels]
        label_map = {}
        for (orig_i, _), label in zip(valid, labels):
            label_map[orig_i] = label
        return [{"file": r["file"], "group": label_map.get(i)} for i, r in enumerate(feature_results)]
    else:
        from sklearn.cluster import MiniBatchKMeans

        actual_k = min(k, len(valid))
        if actual_k < 2:
            actual_k = min(2, len(valid))

        n_samples = len(valid)
        mbk = MiniBatchKMeans(
            n_clusters=actual_k, n_init=10, random_state=42,
            batch_size=min(1024, n_samples)
        )
        labels = mbk.fit_predict(features)
        return _build_result(feature_results, valid, labels)


# ==================== 文件按组复制 ====================

def copy_files_to_groups(files_by_group, output_dir):
    """将文件按聚类组复制到子文件夹 group_1/, group_2/...（保留原文件）"""
    copied = 0
    errors = []

    for group_str, files in files_by_group.items():
        group_dir = os.path.join(output_dir, f"group_{int(group_str) + 1}")
        os.makedirs(group_dir, exist_ok=True)
        for f in files:
            try:
                dst = os.path.join(group_dir, os.path.basename(f))
                shutil.copy2(f, dst)
                copied += 1
            except Exception as e:
                errors.append({"file": f, "error": str(e)})

    return {"success": True, "copied": copied, "errors": errors}
