"""分辨率过滤：按宽度/高度/综合条件检查图片尺寸"""

from PIL import Image


def filter_one(file_path, min_width, max_width, min_height, max_height):
    """检查单张图片尺寸，返回是否不满足条件（值为0表示不限）"""
    try:
        with Image.open(file_path) as img:
            w, h = img.size

        filtered = False
        if min_width > 0 and w < min_width:
            filtered = True
        if max_width > 0 and w > max_width:
            filtered = True
        if min_height > 0 and h < min_height:
            filtered = True
        if max_height > 0 and h > max_height:
            filtered = True
        return {"file": file_path, "ok": True, "filtered": filtered, "width": w, "height": h}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}
