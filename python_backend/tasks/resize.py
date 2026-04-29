"""批量缩放（Cover 模式 + RetinaFace 人脸检测智能裁剪）"""

import os
import numpy as np
from PIL import Image

from tasks.gpu_config import get_onnx_providers

# 每个 worker 进程缓存检测器，只加载一次
_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        from insightface.app import FaceAnalysis
        providers = get_onnx_providers()
        _detector = FaceAnalysis(
            providers=providers,
            allowed_modules=['detection']
        )
        _detector.prepare(ctx_id=0, det_size=(640, 640))
    return _detector


def cleanup_cache():
    """释放缓存的人脸检测器"""
    global _detector
    _detector = None


def resize_one(file_path, output_dir, width, height,
               allow_upscale=False, face_threshold=0.5):
    """
    Cover 模式缩放：
    1. 按短边等比缩放使图片覆盖目标尺寸
    2. RetinaFace 检测人脸，以人脸中心为锚点裁剪
    3. 未检测到人脸则居中裁剪
    """
    try:
        base = os.path.basename(file_path)
        name, ext = os.path.splitext(base)

        with Image.open(file_path) as img:
            img = img.convert("RGB")
            orig_w, orig_h = img.size

            # 跳过逻辑：原图小于目标尺寸且不允许放大
            if not allow_upscale and orig_w <= width and orig_h <= height:
                return {"file": file_path, "ok": True, "skipped": True}

            # Cover 模式：取较大缩放比，确保图片覆盖目标区域
            scale = max(width / orig_w, height / orig_h)
            new_w = round(orig_w * scale)
            new_h = round(orig_h * scale)

            # 人脸检测（在原图上检测，精度更高）
            img_np = np.array(img)
            try:
                detector = _get_detector()
                faces = detector.get(img_np)
                faces = [f for f in faces if f.det_score >= face_threshold]
            except Exception:
                faces = []

            # 等比缩放
            resized = img.resize((new_w, new_h), Image.LANCZOS)

            # 计算裁剪锚点
            if faces:
                # 取所有合格人脸中心的平均值，映射到缩放后坐标
                cx_sum, cy_sum = 0, 0
                for face in faces:
                    x1, y1, x2, y2 = face.bbox
                    cx_sum += (x1 + x2) / 2
                    cy_sum += (y1 + y2) / 2
                anchor_x = cx_sum / len(faces) * scale
                anchor_y = cy_sum / len(faces) * scale
            else:
                # fallback 居中裁剪
                anchor_x = new_w / 2
                anchor_y = new_h / 2

            # 以锚点为中心裁剪到目标尺寸，clamp 不超出边界
            crop_x = int(max(0, min(anchor_x - width / 2, new_w - width)))
            crop_y = int(max(0, min(anchor_y - height / 2, new_h - height)))
            cropped = resized.crop((crop_x, crop_y, crop_x + width, crop_y + height))

            # 输出
            if os.path.normpath(output_dir) == os.path.normpath(os.path.dirname(file_path)):
                out_name = f"{name}_resized{ext}"
            else:
                out_name = base

            out_path = os.path.join(output_dir, out_name)
            cropped.save(out_path, quality=95)

        return {
            "file": file_path, "output": out_path, "ok": True,
            "skipped": False, "faces_detected": len(faces)
        }
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
