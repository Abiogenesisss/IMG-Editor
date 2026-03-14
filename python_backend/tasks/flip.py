"""镜像翻转"""

import os
from PIL import Image


def flip_one(fpath, output_dir):
    """单张水平镜像翻转"""
    try:
        img = Image.open(fpath)
        flipped = img.transpose(Image.FLIP_LEFT_RIGHT)
        name, ext = os.path.splitext(os.path.basename(fpath))
        # 输出目录与源文件同目录时，加后缀避免覆盖
        if os.path.normpath(output_dir) == os.path.normpath(os.path.dirname(fpath)):
            out_name = f"{name}_flip{ext}"
        else:
            out_name = f"{name}{ext}"
        out_path = os.path.join(output_dir, out_name)
        flipped.save(out_path, quality=95)
        return {"file": fpath, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": fpath, "ok": False, "error": str(e)}
