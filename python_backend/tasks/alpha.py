"""透明通道合成"""

from PIL import Image
import os

from tasks.image_utils import output_path, save_image


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

            _, ext = os.path.splitext(file_path)
            ext = ext or ".png"
            suffix = "_black_bg" if background == "black" else "_white_bg"
            out_path = output_path(file_path, output_dir, suffix, ext)
            save_image(flattened, out_path)

        return {"file": file_path, "output": out_path, "ok": True, "background": background}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
