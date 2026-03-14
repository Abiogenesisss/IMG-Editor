"""格式转换"""

import os
from PIL import Image


def convert_one(file_path, output_dir, target_format):
    """将单张图片转换为指定格式（png / jpg / webp）"""
    try:
        base = os.path.basename(file_path)
        name, src_ext = os.path.splitext(base)

        ext_map = {"png": ".png", "jpg": ".jpg", "webp": ".webp"}
        new_ext = ext_map.get(target_format, ".png")

        # 源文件已经是目标格式 → 跳过
        if src_ext.lower() == new_ext:
            return {"file": file_path, "ok": True, "skipped": True}

        with Image.open(file_path) as img:
            # RGBA → RGB（jpg 不支持透明通道）
            if target_format == "jpg" and img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            out_name = f"{name}{new_ext}"
            out_path = os.path.join(output_dir, out_name)

            save_kwargs = {}
            if target_format in ("jpg", "webp"):
                save_kwargs["quality"] = 95

            img.save(out_path, **save_kwargs)

        return {"file": file_path, "output": out_path, "ok": True}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
