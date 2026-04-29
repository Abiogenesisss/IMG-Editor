"""透明通道合成"""

import os
from PIL import Image


def _has_transparency(img):
    """Return True only when the image has pixels with alpha below 255."""
    if img.mode in ("RGBA", "LA"):
        alpha = img.getchannel("A")
        return alpha.getextrema()[0] < 255

    if img.mode == "P" and "transparency" in img.info:
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        return alpha.getextrema()[0] < 255

    return False


def flatten_alpha_one(file_path, output_dir, background="white"):
    """将带透明通道的图片合成到黑色或白色背景。"""
    try:
        background = "black" if background == "black" else "white"
        bg_color = (0, 0, 0) if background == "black" else (255, 255, 255)

        with Image.open(file_path) as img:
            if not _has_transparency(img):
                return {"file": file_path, "ok": True, "skipped": True, "reason": "no_alpha"}

            rgba = img.convert("RGBA")
            canvas = Image.new("RGBA", rgba.size, (*bg_color, 255))
            flattened = Image.alpha_composite(canvas, rgba).convert("RGB")

            name, ext = os.path.splitext(os.path.basename(file_path))
            ext = ext or ".png"
            suffix = "_black_bg" if background == "black" else "_white_bg"
            if os.path.normpath(output_dir) == os.path.normpath(os.path.dirname(file_path)):
                out_name = f"{name}{suffix}{ext}"
            else:
                out_name = f"{name}{ext}"
            out_path = os.path.join(output_dir, out_name)

            save_kwargs = {}
            if ext.lower() in (".jpg", ".jpeg", ".webp"):
                save_kwargs["quality"] = 95

            flattened.save(out_path, **save_kwargs)

        return {"file": file_path, "output": out_path, "ok": True, "background": background}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
