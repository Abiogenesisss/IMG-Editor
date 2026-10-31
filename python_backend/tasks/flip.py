"""镜像翻转"""

from PIL import Image

from tasks.image_utils import output_path, save_image


def flip_one(fpath, output_dir):
    """单张水平镜像翻转"""
    try:
        img = Image.open(fpath)
        flipped = img.transpose(Image.FLIP_LEFT_RIGHT)
        # 输出目录与源文件同目录时，加后缀避免覆盖
        out_path = output_path(fpath, output_dir, "_flip")
        save_image(flipped, out_path)
        return {"file": fpath, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": fpath, "ok": False, "error": str(e)}
