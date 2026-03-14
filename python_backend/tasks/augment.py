"""数据增强：Cutout / 透视变换 / 高斯模糊+噪声 / 增强预览"""

import os
import io
import base64
import random
import numpy as np
from PIL import Image, ImageFilter


def _save(img, fpath, output_dir, suffix):
    """保存增强后的图片"""
    name, ext = os.path.splitext(os.path.basename(fpath))
    out_name = f"{name}_{suffix}{ext}"
    out_path = os.path.join(output_dir, out_name)
    img.save(out_path, quality=95)
    return out_path


def cutout_one(fpath, output_dir, count=1, size_ratio=0.15):
    """Cutout: 在图片上随机挖去矩形区域，填黑"""
    try:
        img = Image.open(fpath).convert("RGB")
        img = _apply_cutout(img, count, size_ratio)
        out_path = _save(img, fpath, output_dir, "cutout")
        return {"file": fpath, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": fpath, "ok": False, "error": str(e)}


def perspective_one(fpath, output_dir, intensity=0.1):
    """透视变换：模拟不同视角拍摄"""
    try:
        img = Image.open(fpath).convert("RGB")
        img = _apply_perspective(img, intensity)
        out_path = _save(img, fpath, output_dir, "persp")
        return {"file": fpath, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": fpath, "ok": False, "error": str(e)}


def gaussian_blur_noise_one(fpath, output_dir, blur_radius=2.0, noise_sigma=15.0):
    """高斯模糊 + 高斯噪声"""
    try:
        img = Image.open(fpath).convert("RGB")
        img = _apply_blur_noise(img, blur_radius, noise_sigma)
        out_path = _save(img, fpath, output_dir, "blurnoise")
        return {"file": fpath, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": fpath, "ok": False, "error": str(e)}


# ---- 增强核心逻辑（批处理和预览共用） ----

def _apply_cutout(img, count, size_ratio):
    arr = np.array(img)
    h, w, _ = arr.shape
    side = int(min(h, w) * size_ratio)
    for _ in range(count):
        y = random.randint(0, h - 1)
        x = random.randint(0, w - 1)
        y1, y2 = max(0, y - side // 2), min(h, y + side // 2)
        x1, x2 = max(0, x - side // 2), min(w, x + side // 2)
        arr[y1:y2, x1:x2] = 0
    return Image.fromarray(arr)


def _apply_perspective(img, intensity):
    w, h = img.size
    max_dx, max_dy = int(w * intensity), int(h * intensity)
    tl = (random.randint(0, max_dx), random.randint(0, max_dy))
    tr = (w - random.randint(0, max_dx), random.randint(0, max_dy))
    br = (w - random.randint(0, max_dx), h - random.randint(0, max_dy))
    bl = (random.randint(0, max_dx), h - random.randint(0, max_dy))
    coeffs = _find_perspective_coeffs(
        [(0, 0), (w, 0), (w, h), (0, h)], [tl, tr, br, bl]
    )
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def _apply_blur_noise(img, blur_radius, noise_sigma):
    if blur_radius > 0:
        img = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    if noise_sigma > 0:
        arr = np.array(img, dtype=np.float32)
        noise = np.random.normal(0, noise_sigma, arr.shape).astype(np.float32)
        arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr)
    return img


def _find_perspective_coeffs(target, source):
    """根据四对点计算 PIL 透视变换的 8 个系数"""
    matrix = []
    for s, t in zip(source, target):
        matrix.append([t[0], t[1], 1, 0, 0, 0, -s[0]*t[0], -s[0]*t[1]])
        matrix.append([0, 0, 0, t[0], t[1], 1, -s[1]*t[0], -s[1]*t[1]])
    A = np.matrix(matrix, dtype=float)
    B = np.array([s for pair in source for s in pair], dtype=float)
    res = np.linalg.solve(A, B)
    return tuple(np.array(res).flatten())


# ---- 增强预览（不写盘，返回 base64） ----

_AUGMENT_APPLY = {
    "cutout": lambda img, p: _apply_cutout(img, p.get("count", 1), p.get("size_ratio", 0.15)),
    "perspective": lambda img, p: _apply_perspective(img, p.get("intensity", 0.1)),
    "blurnoise": lambda img, p: _apply_blur_noise(img, p.get("blur_radius", 2.0), p.get("noise_sigma", 15.0)),
    "flip": lambda img, p: img.transpose(Image.FLIP_LEFT_RIGHT),
}


def preview_augment(fpath, aug_type, params, max_side=800):
    """对单张图片应用增强，返回 base64 编码的 JPEG"""
    try:
        img = Image.open(fpath).convert("RGB")
        w, h = img.size
        if max(w, h) > max_side:
            ratio = max_side / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        apply_fn = _AUGMENT_APPLY.get(aug_type)
        if not apply_fn:
            return {"ok": False, "error": f"unknown augment type: {aug_type}"}
        img = apply_fn(img, params or {})
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"ok": True, "data": f"data:image/jpeg;base64,{b64}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
