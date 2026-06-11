"""图片去重：多区域网格 dHash/pHash + ORB 局部特征，星形分组"""

import numpy as np
from PIL import Image

from tasks.gpu_config import is_gpu_enabled, gpu_status as get_gpu_status

Image.MAX_IMAGE_PIXELS = None

QUALITY_REVIEW_GAP = 6.0


def _load_image(filepath, max_size=2048, return_meta=False):
    """安全加载图片（支持大图 & 中文路径 & WebP），返回 BGR numpy 数组。
    用 Pillow 解码，绕过 OpenCV 对超大 PNG chunk 的限制。"""
    import os

    with Image.open(filepath) as img:
        meta = {
            "width": img.width,
            "height": img.height,
            "format": (img.format or "").lower(),
            "mode": img.mode,
            "has_alpha": img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info,
            "file_size": os.path.getsize(filepath) if os.path.exists(filepath) else 0,
        }
        if max(img.size) > max_size:
            img.thumbnail((max_size, max_size), Image.LANCZOS)
        # 含透明通道时在白底上合成，避免透明区变黑污染哈希特征
        if img.mode in ('RGBA', 'LA', 'PA'):
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        arr = np.array(img)
    arr = arr[:, :, ::-1].copy()
    if return_meta:
        return arr, meta
    return arr


def _clamp01(value):
    return max(0.0, min(1.0, float(value)))


def _compute_quality_features(filepath, gray, meta):
    """给去重组内排序使用的轻量质量特征。
    分数只用于同一重复组内比较，偏向保留高分辨率、清晰、低压缩损失的版本。"""
    import cv2

    width = int(meta.get("width") or 0)
    height = int(meta.get("height") or 0)
    area = max(width * height, 1)
    file_size = int(meta.get("file_size") or 0)
    bytes_per_pixel = file_size / area

    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    contrast = float(gray.std())
    fmt = (meta.get("format") or "").lower()
    format_score = {
        "png": 1.0,
        "webp": 0.94,
        "tiff": 0.9,
        "tif": 0.9,
        "jpeg": 0.84,
        "jpg": 0.84,
        "bmp": 0.8,
    }.get(fmt, 0.76)

    area_part = _clamp01(np.log1p(area) / np.log1p(4096 * 4096)) * 38
    sharpness_part = _clamp01(np.log1p(sharpness) / np.log1p(1200)) * 30
    contrast_part = _clamp01(contrast / 80) * 12
    compression_part = _clamp01(bytes_per_pixel / 0.8) * 10
    format_part = format_score * 8
    alpha_part = 2 if meta.get("has_alpha") else 0
    score = area_part + sharpness_part + contrast_part + compression_part + format_part + alpha_part

    return {
        "score": round(float(score), 1),
        "width": width,
        "height": height,
        "area": area,
        "sharpness": round(sharpness, 1),
        "contrast": round(contrast, 1),
        "bytes_per_pixel": round(bytes_per_pixel, 3),
        "format": fmt,
        "has_alpha": bool(meta.get("has_alpha")),
        "file_size": file_size,
    }


def _quality_sort_key(feature_result):
    q = feature_result.get("quality") or {}
    return (
        q.get("score") or 0,
        q.get("area") or 0,
        q.get("sharpness") or 0,
        q.get("bytes_per_pixel") or 0,
        q.get("file_size") or 0,
    )


def _quality_reason(current, best):
    if not current or not best:
        return "质量信息不足"
    if (best.get("area") or 0) > (current.get("area") or 0) * 1.08:
        return "分辨率较低"
    if (best.get("sharpness") or 0) > (current.get("sharpness") or 0) * 1.18:
        return "清晰度较低"
    if (best.get("bytes_per_pixel") or 0) > (current.get("bytes_per_pixel") or 0) * 1.25:
        return "压缩质量较低"
    if best.get("has_alpha") and not current.get("has_alpha"):
        return "缺少透明信息"
    if (best.get("format") or "") != (current.get("format") or ""):
        return "格式优先级较低"
    return "综合质量较低"


def _crop_to_content(img_bgr):
    """裁剪图片四周的大面积纯色/留白区域，只保留有效内容区域。
    避免画册跨页等排版留白污染哈希特征，导致不同图片因共享相似的空白区域
    而被错误匹配。对没有大面积留白的普通图片不做任何裁剪。"""
    import cv2
    h, w = img_bgr.shape[:2]
    if h < 64 or w < 64:
        return img_bgr

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # Laplacian 检测边缘/纹理活跃度（纯色区域≈0，内容丰富区域>>0）
    lap = np.abs(cv2.Laplacian(gray, cv2.CV_16S, ksize=3)).astype(np.float32)

    # 将图片沿水平/垂直方向划分为条带（宽度=5%），
    # 用条带级平均活跃度代替逐列扫描，抵抗文字等小面积噪声干扰
    strip_w = max(w // 20, 4)
    strip_h = max(h // 20, 4)
    n_col = w // strip_w
    n_row = h // strip_h
    if n_col < 3 or n_row < 3:
        return img_bgr

    col_act = np.array([lap[:, i * strip_w:(i + 1) * strip_w].mean() for i in range(n_col)])
    row_act = np.array([lap[i * strip_h:(i + 1) * strip_h, :].mean() for i in range(n_row)])

    # 动态阈值：全图平均活跃度的 25%
    thresh = max(float(lap.mean()) * 0.25, 1.0)

    # 从四边向内扫描，找到第一个内容条带
    left_s = 0
    for i in range(n_col):
        if col_act[i] > thresh:
            left_s = i
            break
    right_s = n_col
    for i in range(n_col - 1, -1, -1):
        if col_act[i] > thresh:
            right_s = i + 1
            break
    top_s = 0
    for i in range(n_row):
        if row_act[i] > thresh:
            top_s = i
            break
    bottom_s = n_row
    for i in range(n_row - 1, -1, -1):
        if row_act[i] > thresh:
            bottom_s = i + 1
            break

    left = left_s * strip_w
    right = min(right_s * strip_w, w)
    top = top_s * strip_h
    bottom = min(bottom_s * strip_h, h)

    crop_area = (bottom - top) * (right - left)
    orig_area = h * w
    # 裁剪不足 10%：无明显留白，保持原图
    if crop_area > orig_area * 0.9:
        return img_bgr
    # 裁剪过度（剩余不足 25%）：可能误判，保持原图
    if crop_area < orig_area * 0.25 or bottom - top < 32 or right - left < 32:
        return img_bgr

    return img_bgr[top:bottom, left:right]


# ==================== 感知哈希 + ORB 局部特征方式 ====================

def _compute_dhash(gray, hash_size=8, grid=(2, 2)):
    """计算 dHash（差异哈希），支持多区域网格提升区分度。
    将图片划分为 grid_h × grid_w 个子区域，各自独立计算 dHash 后拼接。
    输入 cv2 灰度图，返回 bool 数组（grid_h * grid_w * hash_size^2 位）"""
    import cv2
    h, w = gray.shape[:2]
    gh, gw = grid
    parts = []
    for r in range(gh):
        for c in range(gw):
            y1, y2 = r * h // gh, (r + 1) * h // gh
            x1, x2 = c * w // gw, (c + 1) * w // gw
            region = gray[y1:y2, x1:x2]
            resized = cv2.resize(region, (hash_size + 1, hash_size), interpolation=cv2.INTER_AREA)
            parts.append((resized[:, 1:] > resized[:, :-1]).flatten())
    return np.concatenate(parts)


def _compute_phash(gray, hash_size=8, dct_size=32, grid=(2, 2)):
    """计算 pHash（DCT 感知哈希），支持多区域网格提升区分度。
    将图片划分为 grid_h × grid_w 个子区域，各自独立计算 pHash 后拼接。
    与 dHash 互补的频域特征"""
    import cv2
    h, w = gray.shape[:2]
    gh, gw = grid
    parts = []
    for r in range(gh):
        for c in range(gw):
            y1, y2 = r * h // gh, (r + 1) * h // gh
            x1, x2 = c * w // gw, (c + 1) * w // gw
            region = gray[y1:y2, x1:x2]
            resized = cv2.resize(region, (dct_size, dct_size), interpolation=cv2.INTER_AREA).astype(np.float32)
            dct = cv2.dct(resized)
            low_freq = dct[:hash_size, :hash_size]
            median = np.median(low_freq)
            parts.append((low_freq > median).flatten())
    return np.concatenate(parts)


def _compute_color_hist(img_bgr, bins=32):
    """计算 HSV 色调直方图，用于颜色分布验证。返回归一化直方图。"""
    import cv2
    small = cv2.resize(img_bgr, (64, 64), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0], None, [bins], [0, 180])
    cv2.normalize(hist, hist)
    return hist


def extract_perceptual_batch(files, max_kp=1000, progress_cb=None):
    """提取 dHash + pHash + 颜色直方图 + ORB 特征（纯 OpenCV，无深度学习依赖）"""
    import cv2

    total = len(files)
    results = [None] * total

    for i, f in enumerate(files):
        try:
            img, quality_meta = _load_image(f, return_meta=True)
            if img is None:
                raise ValueError("无法读取图片")
            # 裁剪大面积留白，避免画册跨页等排版留白污染哈希
            img = _crop_to_content(img)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            quality = _compute_quality_features(f, gray, quality_meta)

            # dHash + pHash
            dhash = _compute_dhash(gray)
            phash = _compute_phash(gray)

            # 颜色直方图（用原始彩色图）
            color_hist = _compute_color_hist(img)

            # ORB — 限制图片尺寸以加速
            h, w = gray.shape
            if max(h, w) > 1024:
                scale = 1024.0 / max(h, w)
                gray = cv2.resize(gray, None, fx=scale, fy=scale)
            orb = cv2.ORB_create(nfeatures=max_kp)
            kp, des = orb.detectAndCompute(gray, None)

            # 存储关键点坐标，供 RANSAC 几何验证使用
            kp_pts = np.array([p.pt for p in kp], dtype=np.float32) if kp else None

            results[i] = {
                "file": f, "ok": True,
                "dhash": dhash,
                "phash": phash,
                "color_hist": color_hist,
                "orb_des": des,
                "orb_kp": kp_pts,
                "orb_hw": gray.shape[:2],  # ORB 处理时的图像尺寸 (h, w)
                "quality": quality,
            }
        except Exception as e:
            results[i] = {"file": f, "ok": False, "error": str(e)}

        if progress_cb:
            progress_cb(i + 1, total)

    return results


def _is_valid_homography(H, src_hw):
    """验证单应性矩阵是否代表合理的几何变换（裁剪/缩放/轻微透视）。
    将源图四角通过 H 映射，检查结果是否为凸四边形且面积比合理。
    退化或随机噪声拟合出的 H 通常会把矩形扭成非凸、极端缩放或翻转的形状。"""
    import cv2 as _cv2
    if H is None:
        return False
    h, w = src_hw
    corners = np.float64([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    try:
        dst = _cv2.perspectiveTransform(corners, H).reshape(-1, 2)
    except Exception:
        return False

    # 凸性检查：连续边叉积须同号（全正 = 逆时针，全负 = 顺时针）
    for k in range(4):
        e1 = dst[(k + 1) % 4] - dst[k]
        e2 = dst[(k + 2) % 4] - dst[(k + 1) % 4]
        if e1[0] * e2[1] - e1[1] * e2[0] <= 0:
            return False

    # 面积比合理性（Shoelace 公式）
    area = 0.0
    for k in range(4):
        j = (k + 1) % 4
        area += dst[k][0] * dst[j][1]
        area -= dst[j][0] * dst[k][1]
    area = abs(area) / 2.0
    ratio = area / (w * h)
    if ratio < 0.1 or ratio > 10:
        return False

    return True


def find_duplicates_perceptual(feature_results, hash_thresh=10, orb_min_inliers=20,
                               orb_inlier_ratio=0.3, phash_thresh=10,
                               color_thresh=0.5, progress_cb=None, return_debug=False):
    """
    两层去重策略 + 二次验证 + 星形分组（防链式传递）：
    第一层 dHash：汉明距离 <= hash_thresh 作为候选，再经 pHash + 颜色直方图二次验证
        - pHash 汉明距离 <= phash_thresh（频域特征交叉验证，与 dHash 互补）
        - HSV 色调直方图相关性 >= color_thresh（过滤色调不同但结构相似的误判）
    第二层 ORB + RANSAC：局部特征匹配 + 单应性几何验证（捕捉裁剪 / 加字 / 局部变换）
        - BFMatcher + Lowe ratio test 筛选初始匹配
        - cv2.findHomography + RANSAC 过滤几何不一致的匹配
        - 需同时满足：内点数 >= orb_min_inliers 且 内点/good匹配 >= orb_inlier_ratio
    分组策略：
        使用邻接表记录直接相似对，再用星形分组替代 Union-Find。
        每个组成员必须与组的中心节点直接相似，从而避免 A≈B, B≈C 链式传递
        将不相似的 A 和 C 错误归入同一组。

    返回与 find_duplicates 相同格式：[{file, group, similarity}, ...]
    """
    import cv2
    from collections import defaultdict

    valid = [r for r in feature_results if r.get("ok")]
    n = len(valid)
    if n == 0:
        return []

    # 邻接表：记录直接相似的图片对，替代 Union-Find 避免链式传递
    adj = defaultdict(set)
    max_sim = np.zeros(n)

    # ---- 第一层：dHash + pHash + 颜色直方图（全向量化） ----
    hashes = np.array([r["dhash"] for r in valid], dtype=np.uint8)
    hash_bits = hashes.shape[1]  # 256 (2x2 网格 × 64 位/区域)

    phashes = np.array([r["phash"] for r in valid], dtype=np.uint8)

    # 多区域网格哈希：阈值按区域数量等比缩放，保持每个区域的容差与原始单区域一致
    n_regions = hash_bits // 64  # 区域数（默认 4）
    scaled_hash_thresh = hash_thresh * n_regions
    scaled_phash_thresh = phash_thresh * n_regions

    # 预计算归一化中心化颜色直方图矩阵，实现 Pearson 相关性的向量化计算
    color_hists_raw = [r.get("color_hist") for r in valid]
    hist_bins = color_hists_raw[0].size if color_hists_raw[0] is not None else 32
    hist_matrix = np.zeros((n, hist_bins), dtype=np.float32)
    hist_valid = np.zeros(n, dtype=bool)
    for i in range(n):
        h = color_hists_raw[i]
        if h is not None:
            hist_matrix[i] = h.flatten()
            hist_valid[i] = True
    hist_centered = hist_matrix - hist_matrix.mean(axis=1, keepdims=True)
    hist_norms = np.linalg.norm(hist_centered, axis=1, keepdims=True)
    hist_norms[hist_norms == 0] = 1
    hist_normed = hist_centered / hist_norms

    gpu_state = {}
    try:
        gpu_state = get_gpu_status()
    except Exception:
        gpu_state = {}

    gpu_switch_enabled = bool(gpu_state.get("enabled", False))
    cuda_available = bool(gpu_state.get("cuda_available", False))

    use_gpu = False
    torch = None
    backend_reason = "gpu_switch_off"
    if not gpu_switch_enabled:
        backend_reason = "gpu_switch_off"
    elif not cuda_available:
        backend_reason = "cuda_unavailable"
    elif is_gpu_enabled():
        try:
            import torch as _torch
            if _torch.cuda.is_available():
                torch = _torch
                use_gpu = True
                backend_reason = "cuda_hash_match"
            else:
                backend_reason = "torch_cuda_unavailable"
        except Exception as e:
            backend_reason = f"torch_import_failed:{e.__class__.__name__}"

    debug_info = {
        "hash_backend": "cuda" if use_gpu else "cpu",
        "orb_backend": "cpu",
        "gpu_switch_enabled": gpu_switch_enabled,
        "cuda_available": cuda_available,
        "reason": backend_reason,
    }

    # GPU 下减小分块，避免 XOR 矩阵过大导致显存压力
    CHUNK = 768 if use_gpu else 2000
    total_chunks = (n + CHUNK - 1) // CHUNK
    chunk_done = 0
    total_chunk_pairs = total_chunks * (total_chunks + 1) // 2

    for ci in range(0, n, CHUNK):
        ci_end = min(ci + CHUNK, n)
        for cj in range(ci, n, CHUNK):
            cj_end = min(cj + CHUNK, n)
            if use_gpu:
                hashes_i = torch.as_tensor(hashes[ci:ci_end], device="cuda", dtype=torch.bool)
                hashes_j = torch.as_tensor(hashes[cj:cj_end], device="cuda", dtype=torch.bool)
                phashes_i = torch.as_tensor(phashes[ci:ci_end], device="cuda", dtype=torch.bool)
                phashes_j = torch.as_tensor(phashes[cj:cj_end], device="cuda", dtype=torch.bool)
                hist_i = torch.as_tensor(hist_normed[ci:ci_end], device="cuda", dtype=torch.float32)
                hist_j = torch.as_tensor(hist_normed[cj:cj_end], device="cuda", dtype=torch.float32)
                valid_i = torch.as_tensor(hist_valid[ci:ci_end], device="cuda", dtype=torch.bool)
                valid_j = torch.as_tensor(hist_valid[cj:cj_end], device="cuda", dtype=torch.bool)

                hamming_d = torch.count_nonzero(
                    torch.logical_xor(hashes_i[:, None, :], hashes_j[None, :, :]),
                    dim=2
                )
                hamming_p = torch.count_nonzero(
                    torch.logical_xor(phashes_i[:, None, :], phashes_j[None, :, :]),
                    dim=2
                )
                corr_block = hist_i @ hist_j.transpose(0, 1)
                both_valid = valid_i[:, None] & valid_j[None, :]
                corr_block = torch.where(both_valid, corr_block, torch.ones_like(corr_block))

                cand_mask = (
                    (hamming_d <= scaled_hash_thresh)
                    & (hamming_p <= scaled_phash_thresh)
                    & (corr_block >= color_thresh)
                )
                if ci == cj:
                    cand_mask &= torch.triu(
                        torch.ones_like(cand_mask, dtype=torch.bool),
                        diagonal=1
                    )

                rows_t, cols_t = torch.where(cand_mask)
                if rows_t.numel() > 0:
                    rows = rows_t.cpu().numpy()
                    cols = cols_t.cpu().numpy()
                    gi = ci + rows
                    gj = cj + cols
                    sims = 1.0 - hamming_d[rows_t, cols_t].to(dtype=torch.float32).cpu().numpy() / hash_bits
                    np.maximum.at(max_sim, gi, sims)
                    np.maximum.at(max_sim, gj, sims)
                    for k in range(len(rows)):
                        a, b = int(gi[k]), int(gj[k])
                        adj[a].add(b)
                        adj[b].add(a)

                chunk_done += 1
                if progress_cb:
                    progress_cb(chunk_done, total_chunk_pairs + n, "hash")
                continue

            # 三项指标批量矩阵计算
            hamming_d = (hashes[ci:ci_end, None, :] != hashes[None, cj:cj_end, :]).sum(axis=2)
            hamming_p = (phashes[ci:ci_end, None, :] != phashes[None, cj:cj_end, :]).sum(axis=2)
            corr_block = hist_normed[ci:ci_end] @ hist_normed[cj:cj_end].T
            # 无有效直方图的图片对默认通过颜色检查
            both_valid = hist_valid[ci:ci_end, None] & hist_valid[None, cj:cj_end]
            corr_block = np.where(both_valid, corr_block, 1.0)

            # 三项阈值联合筛选（使用按区域数缩放后的阈值）
            cand_mask = (hamming_d <= scaled_hash_thresh) & (hamming_p <= scaled_phash_thresh) & (corr_block >= color_thresh)
            if ci == cj:
                cand_mask &= np.triu(np.ones(cand_mask.shape, dtype=bool), k=1)

            rows, cols = np.where(cand_mask)

            if len(rows) > 0:
                gi = ci + rows
                gj = cj + cols
                # 相似度仍用原始 dHash 汉明距离换算
                sims = 1.0 - hamming_d[rows, cols].astype(np.float64) / hash_bits
                # 向量化更新 max_sim
                np.maximum.at(max_sim, gi, sims)
                np.maximum.at(max_sim, gj, sims)
                # 记录直接相似对到邻接表
                for k in range(len(rows)):
                    a, b = int(gi[k]), int(gj[k])
                    adj[a].add(b)
                    adj[b].add(a)

            chunk_done += 1
            if progress_cb:
                progress_cb(chunk_done, total_chunk_pairs + n, "hash")

    # ---- 第二层：ORB 局部特征 + RANSAC 几何验证 ----
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    # 预筛选有有效描述子的图片索引，避免内层循环反复判空
    orb_indices = [i for i in range(n)
                   if valid[i].get("orb_des") is not None and len(valid[i]["orb_des"]) >= 2]
    orb_count = len(orb_indices)

    # 收集需要 ORB 匹配的候选对（排除已被第一层匹配的对）
    orb_pairs = []
    for oi, i in enumerate(orb_indices):
        for j in orb_indices[oi + 1:]:
            if j in adj[i]:
                continue
            orb_pairs.append((i, j))

    orb_total = len(orb_pairs)

    def _match_one_pair(pair):
        """单对 ORB 匹配 + RANSAC 几何验证（线程安全）"""
        i, j = pair
        des_i = valid[i]["orb_des"]
        kp_i = valid[i]["orb_kp"]
        des_j = valid[j]["orb_des"]
        kp_j = valid[j]["orb_kp"]

        matches = bf.knnMatch(des_i, des_j, k=2)
        good = [(m[0].queryIdx, m[0].trainIdx)
                for m in matches if len(m) == 2
                and m[0].distance < 0.75 * m[1].distance]

        if len(good) < 4:
            return None

        src_pts = kp_i[[qi for qi, _ in good]]
        dst_pts = kp_j[[ti for _, ti in good]]

        H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 3.0)
        inliers = int(mask.sum()) if mask is not None else 0

        if (inliers >= orb_min_inliers
                and inliers / len(good) >= orb_inlier_ratio
                and _is_valid_homography(H, valid[i].get("orb_hw", (512, 512)))):
            return (i, j, inliers / len(good))
        return None

    # 多线程并行 ORB 匹配（OpenCV 释放 GIL，线程并行有效）
    from concurrent.futures import ThreadPoolExecutor
    import os
    n_workers = min(os.cpu_count() or 4, 8)
    orb_done = 0

    with ThreadPoolExecutor(max_workers=n_workers) as executor:
        for result in executor.map(_match_one_pair, orb_pairs):
            orb_done += 1
            if result is not None:
                i, j, score = result
                if score > max_sim[i]:
                    max_sim[i] = score
                if score > max_sim[j]:
                    max_sim[j] = score
                adj[i].add(j)
                adj[j].add(i)

            if progress_cb and orb_done % 50 == 0:
                progress_cb(orb_done, orb_total, "orb")

    if progress_cb:
        progress_cb(orb_total, orb_total, "orb")

    # ---- 星形分组（防止 Union-Find 链式传递） ----
    # 先用 BFS 找连通分量
    visited = [False] * n
    components = []
    for start in range(n):
        if visited[start] or start not in adj:
            continue
        comp = []
        queue = [start]
        visited[start] = True
        while queue:
            node = queue.pop(0)
            comp.append(node)
            for nb in adj[node]:
                if not visited[nb]:
                    visited[nb] = True
                    queue.append(nb)
        if len(comp) > 1:
            components.append(comp)

    # 对每个连通分量做星形拆分：选度最高节点为中心，只保留其直接邻居
    # 递归处理剩余节点，直到无法再形成有效组
    group_id = 0
    index_to_group = {}

    for comp in components:
        remaining = list(comp)
        while len(remaining) > 1:
            rem_set = set(remaining)
            # 在剩余节点中找「组内度」最高的节点作为中心
            center = max(remaining, key=lambda x: len(adj[x] & rem_set))
            neighbors_in_rem = adj[center] & rem_set
            if not neighbors_in_rem:
                break  # 剩余节点间无直接边，全部为孤立节点
            sub = [center] + sorted(neighbors_in_rem)
            for idx in sub:
                index_to_group[idx] = group_id
            group_id += 1
            remaining = [m for m in remaining if m not in set(sub)]

    quality_actions = {}
    groups = defaultdict(list)
    for idx, gid in index_to_group.items():
        if gid is not None:
            groups[gid].append(idx)

    for members in groups.values():
        if not members:
            continue
        ranked = sorted(members, key=lambda idx: _quality_sort_key(valid[idx]), reverse=True)
        best_idx = ranked[0]
        best_quality = valid[best_idx].get("quality") or {}
        best_score = float(best_quality.get("score") or 0)
        for idx in members:
            current_quality = valid[idx].get("quality") or {}
            current_score = float(current_quality.get("score") or 0)
            if idx == best_idx:
                action = "keep"
                reason = "组内质量最高"
            elif best_score - current_score >= QUALITY_REVIEW_GAP:
                action = "remove"
                reason = _quality_reason(current_quality, best_quality)
            else:
                action = "review"
                reason = "质量差距较小，建议人工确认"
            quality_actions[idx] = {
                "action": action,
                "reason": reason,
                "score": round(current_score, 1),
            }

    # ---- 构建分组结果 ----
    result = []
    for i, r in enumerate(valid):
        gid = index_to_group.get(i)
        similarity = round(float(max_sim[i]) * 100, 1) if gid is not None else None
        quality = r.get("quality") or {}
        quality_action = quality_actions.get(i, {})
        result.append({
            "file": r["file"],
            "group": gid,
            "similarity": similarity,
            "quality_score": quality_action.get("score", quality.get("score")),
            "quality_action": quality_action.get("action"),
            "quality_reason": quality_action.get("reason"),
        })

    if return_debug:
        return result, debug_info
    return result
