"""按比例裁剪（居中裁剪到指定宽高比）"""

import os
from PIL import Image


def crop_auto_one(file_path, output_dir, ratio_list):
    """自动选择最接近的比例进行居中裁剪，输出到 output_dir/WxH/ 子文件夹"""
    try:
        base = os.path.basename(file_path)
        with Image.open(file_path) as img:
            w, h = img.size
            orig_ratio = w / h

            # 找最接近的目标比例
            best = min(ratio_list, key=lambda r: abs(r[0] / r[1] - orig_ratio))
            rw, rh = best
            target_ratio = rw / rh

            if orig_ratio > target_ratio:
                new_w = int(h * target_ratio)
                new_h = h
            else:
                new_w = w
                new_h = int(w / target_ratio)

            left = (w - new_w) // 2
            top = (h - new_h) // 2
            cropped = img.crop((left, top, left + new_w, top + new_h))

            sub_dir = os.path.join(output_dir, f"{rw}x{rh}")
            os.makedirs(sub_dir, exist_ok=True)
            out_path = os.path.join(sub_dir, base)
            cropped.save(out_path, quality=95)

        return {"file": file_path, "output": out_path, "ok": True, "ratio": f"{rw}x{rh}"}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}


def crop_one(file_path, output_dir, ratio_w, ratio_h):
    """将单张图片居中裁剪到指定宽高比"""
    try:
        base = os.path.basename(file_path)
        name, ext = os.path.splitext(base)

        with Image.open(file_path) as img:
            w, h = img.size
            target_ratio = ratio_w / ratio_h
            current_ratio = w / h

            if current_ratio > target_ratio:
                # 图片更宽，裁宽度
                new_w = int(h * target_ratio)
                new_h = h
            else:
                # 图片更高，裁高度
                new_w = w
                new_h = int(w / target_ratio)

            left = (w - new_w) // 2
            top = (h - new_h) // 2
            cropped = img.crop((left, top, left + new_w, top + new_h))

            # 输出目录与源目录相同时加后缀
            if os.path.normpath(output_dir) == os.path.normpath(os.path.dirname(file_path)):
                out_name = f"{name}_crop{ext}"
            else:
                out_name = base

            out_path = os.path.join(output_dir, out_name)
            cropped.save(out_path, quality=95)

        return {"file": file_path, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
