import os


def same_dir(file_path, output_dir):
    return os.path.normpath(output_dir) == os.path.normpath(os.path.dirname(file_path))


def output_path(file_path, output_dir, suffix="", ext=None):
    name, source_ext = os.path.splitext(os.path.basename(file_path))
    target_ext = ext if ext is not None else source_ext
    target_suffix = suffix if suffix and same_dir(file_path, output_dir) else ""
    return os.path.join(output_dir, f"{name}{target_suffix}{target_ext}")


def suffixed_output_path(file_path, output_dir, suffix, ext=None):
    name, source_ext = os.path.splitext(os.path.basename(file_path))
    return os.path.join(output_dir, f"{name}_{suffix}{ext or source_ext}")


def save_image(img, path, quality=95):
    kwargs = {}
    if os.path.splitext(path)[1].lower() in (".jpg", ".jpeg", ".webp", ".avif"):
        kwargs["quality"] = quality
    img.save(path, **kwargs)


def center_crop_to_ratio(img, ratio_w, ratio_h):
    w, h = img.size
    target_ratio = ratio_w / ratio_h
    current_ratio = w / h

    if current_ratio > target_ratio:
        new_w, new_h = int(h * target_ratio), h
    else:
        new_w, new_h = w, int(w / target_ratio)

    left = (w - new_w) // 2
    top = (h - new_h) // 2
    return img.crop((left, top, left + new_w, top + new_h))
