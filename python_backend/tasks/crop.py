"""按比例居中裁剪。"""

import os
from PIL import Image

from tasks.image_utils import center_crop_to_ratio, output_path, save_image


def crop_auto_one(file_path, output_dir, ratio_list):
    """自动选择最接近原图的比例，输出到 output_dir/WxH/。"""
    try:
        base = os.path.basename(file_path)
        with Image.open(file_path) as img:
            w, h = img.size
            orig_ratio = w / h
            rw, rh = min(ratio_list, key=lambda r: abs(r[0] / r[1] - orig_ratio))
            cropped = center_crop_to_ratio(img, rw, rh)

            sub_dir = os.path.join(output_dir, f"{rw}x{rh}")
            os.makedirs(sub_dir, exist_ok=True)
            out_path = os.path.join(sub_dir, base)
            save_image(cropped, out_path)

        return {"file": file_path, "output": out_path, "ok": True, "ratio": f"{rw}x{rh}"}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}


def crop_one(file_path, output_dir, ratio_w, ratio_h):
    """将单张图片居中裁剪到指定宽高比。"""
    try:
        with Image.open(file_path) as img:
            cropped = center_crop_to_ratio(img, ratio_w, ratio_h)
            out_path = output_path(file_path, output_dir, "_crop")
            save_image(cropped, out_path)

        return {"file": file_path, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
