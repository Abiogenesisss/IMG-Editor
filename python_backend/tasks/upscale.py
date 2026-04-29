"""
超分辨率推理 – 多模型调度器
支持: Real-CUGAN / Real-ESRGAN (anime_6B) / Waifu2x (nunif SwinUNet / CUNet / UpConv7)
"""

import os
import io
import math
import base64
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from tasks.gpu_config import get_device, get_half


# ===================================================================
#  通用分块推理 (用于 Real-ESRGAN / Waifu2x)
# ===================================================================

def _tile_forward(model, img_tensor, scale, tile_size=256, tile_pad=16):
    """
    对 BCHW float32 tensor 做分块推理，避免大图 OOM
    img_tensor: (1, C, H, W) 范围 [0, 1]
    返回: (1, C, H*scale, W*scale)
    """
    _, c, h, w = img_tensor.shape
    if h <= tile_size and w <= tile_size:
        return model(img_tensor)

    out_h, out_w = h * scale, w * scale
    output = img_tensor.new_zeros((1, c, out_h, out_w))

    tiles_y = math.ceil(h / tile_size)
    tiles_x = math.ceil(w / tile_size)

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            # 输入 tile 坐标 (含 pad)
            y0 = ty * tile_size
            y1 = min(y0 + tile_size, h)
            x0 = tx * tile_size
            x1 = min(x0 + tile_size, w)

            py0 = max(y0 - tile_pad, 0)
            py1 = min(y1 + tile_pad, h)
            px0 = max(x0 - tile_pad, 0)
            px1 = min(x1 + tile_pad, w)

            tile_in = img_tensor[:, :, py0:py1, px0:px1]
            tile_out = model(tile_in)

            # 输出对应的裁切偏移 (去掉 pad 对应的输出)
            crop_top = (y0 - py0) * scale
            crop_left = (x0 - px0) * scale
            crop_h = (y1 - y0) * scale
            crop_w = (x1 - x0) * scale

            output[:, :, y0 * scale:y1 * scale, x0 * scale:x1 * scale] = \
                tile_out[:, :, crop_top:crop_top + crop_h, crop_left:crop_left + crop_w]

    return output


# ===================================================================
#  Real-CUGAN 后端
# ===================================================================

from tasks.upcunet_v3 import RealWaifuUpScaler

_CUGAN_MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "real-cugan")

_CUGAN_VARIANTS = {
    (2, "no-denoise"):  "up2x-latest-no-denoise.pth",
    (2, "denoise1x"):   "up2x-latest-denoise1x.pth",
    (2, "denoise2x"):   "up2x-latest-denoise2x.pth",
    (2, "denoise3x"):   "up2x-latest-denoise3x.pth",
    (3, "denoise3x"):   "up3x-latest-denoise3x.pth",
    (4, "denoise3x"):   "up4x-latest-denoise3x.pth",
}

_cugan_cache = {}


def _cugan_get_upscaler(scale, denoise):
    key = (scale, denoise)
    if key in _cugan_cache:
        return _cugan_cache[key]
    filename = _CUGAN_VARIANTS.get(key)
    if not filename:
        raise ValueError(f"Real-CUGAN 不支持: scale={scale}, denoise={denoise}")
    weight_path = os.path.join(_CUGAN_MODELS_DIR, filename)
    if not os.path.exists(weight_path):
        raise FileNotFoundError(f"权重文件不存在: {weight_path}")
    upscaler = RealWaifuUpScaler(scale, weight_path, half=get_half(), device=get_device())
    _cugan_cache[key] = upscaler
    return upscaler


def _cugan_upscale(pil_img, scale, denoise):
    upscaler = _cugan_get_upscaler(scale, denoise)
    img_rgb = np.array(pil_img.convert("RGB"))
    result = upscaler(img_rgb, tile_mode=2, cache_mode=1, alpha=1)
    return Image.fromarray(result)


def _cugan_cleanup():
    _cugan_cache.clear()


# ===================================================================
#  Real-ESRGAN 后端 (anime_6B: 固定 4x)
# ===================================================================

from tasks.rrdbnet_arch import RRDBNet

_ESRGAN_MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "real-esrgan")
_ESRGAN_WEIGHT = "RealESRGAN_x4plus_anime_6B.pth"

_esrgan_model = None


def _esrgan_load():
    global _esrgan_model
    if _esrgan_model is not None:
        return _esrgan_model

    weight_path = os.path.join(_ESRGAN_MODELS_DIR, _ESRGAN_WEIGHT)
    if not os.path.exists(weight_path):
        raise FileNotFoundError(
            f"权重文件不存在: {weight_path}\n"
            f"请下载: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/{_ESRGAN_WEIGHT}"
        )

    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=6, num_grow_ch=32, scale=4)
    loadnet = torch.load(weight_path, map_location="cpu", weights_only=False)
    if "params_ema" in loadnet:
        state_dict = loadnet["params_ema"]
    elif "params" in loadnet:
        state_dict = loadnet["params"]
    else:
        state_dict = loadnet
    model.load_state_dict(state_dict, strict=True)
    model.eval()
    model = model.to(get_device())
    if get_half():
        model = model.half()
    _esrgan_model = model
    return model


def _esrgan_upscale(pil_img, scale, denoise):
    """
    Real-ESRGAN anime_6B: 固定 4x 放大，denoise 参数忽略
    若用户选 2x，先 4x 再 resize 回 2x
    """
    model = _esrgan_load()
    img_rgb = np.array(pil_img.convert("RGB")).astype(np.float32) / 255.0
    # HWC -> BCHW
    tensor = torch.from_numpy(np.transpose(img_rgb, (2, 0, 1))).unsqueeze(0).to(get_device())
    if get_half():
        tensor = tensor.half()

    with torch.no_grad():
        output = _tile_forward(model, tensor, scale=4, tile_size=256, tile_pad=16)

    output = output.float().clamp(0, 1).squeeze(0).cpu().numpy()
    output = np.transpose(output, (1, 2, 0))  # CHW -> HWC
    result_img = Image.fromarray((output * 255).round().astype(np.uint8))

    # 如果请求不是 4x，调整到目标尺寸
    if scale != 4:
        orig_w, orig_h = pil_img.size
        target_w, target_h = orig_w * scale, orig_h * scale
        result_img = result_img.resize((target_w, target_h), Image.LANCZOS)

    return result_img


def _esrgan_cleanup():
    global _esrgan_model
    _esrgan_model = None


# ===================================================================
#  Waifu2x 后端 (nunif: SwinUNet / CUNet / UpConv7)
# ===================================================================

_w2x_model_cache = {}   # (model_type, method, noise_level) -> Waifu2xImageModel

# nunif 支持的 model_type 列表
_W2X_MODEL_TYPES = [
    "swin_unet/art", "swin_unet/art_scan", "swin_unet/photo",
    "cunet/art",
    "upconv_7/art", "upconv_7/photo",
]
# 不支持 4x 的模型
_W2X_NO_4X = {"cunet/art", "upconv_7/art", "upconv_7/photo"}


def _w2x_resolve_method(scale, denoise):
    """将前端传入的 (scale, denoise) 转换为 nunif 的 (method, noise_level)"""
    # denoise 格式: "no-denoise" / "denoise0" ~ "denoise3"
    if denoise == "no-denoise":
        noise_level = -1
    else:
        # "denoise0" -> 0, "denoise1" -> 1, ...
        noise_level = int(denoise.replace("denoise", ""))

    if scale == 1:
        method = "noise" if noise_level >= 0 else "noise"
        if noise_level < 0:
            noise_level = 0  # 1x 必须有降噪，否则无意义
    elif scale == 2:
        method = "noise_scale" if noise_level >= 0 else "scale"
    elif scale == 4:
        method = "noise_scale4x" if noise_level >= 0 else "scale4x"
    else:
        raise ValueError(f"Waifu2x 不支持 {scale}x 放大")

    return method, noise_level


def _w2x_get_model(model_type, method, noise_level):
    """获取或创建 Waifu2xImageModel 实例（带缓存）"""
    key = (model_type, method, noise_level)
    if key in _w2x_model_cache:
        return _w2x_model_cache[key]

    from waifu2x.hub import waifu2x as create_waifu2x_model
    model = create_waifu2x_model(
        model_type=model_type,
        method=method,
        noise_level=noise_level,
        tile_size=256,
        batch_size=4,
        keep_alpha=True,
        amp=True,
    )
    model = model.to(get_device())

    _w2x_model_cache[key] = model
    return model


def _w2x_upscale(pil_img, scale, denoise, style="art", tta=False):
    """Waifu2x 超分 + 降噪 (nunif 后端)"""
    # 默认使用 swin_unet 架构
    model_type = f"swin_unet/{style}"
    if model_type not in _W2X_MODEL_TYPES:
        model_type = "swin_unet/art"

    # 检查 4x 支持
    if scale == 4 and model_type in _W2X_NO_4X:
        raise ValueError(f"{model_type} 不支持 4x 放大，请使用 swin_unet 架构")

    method, noise_level = _w2x_resolve_method(scale, denoise)
    w2x = _w2x_get_model(model_type, method, noise_level)
    result = w2x.infer(pil_img, tta=tta, output_type="pil")
    return result


def _w2x_cleanup():
    _w2x_model_cache.clear()


# ===================================================================
#  模型注册表
# ===================================================================

_BACKENDS = {
    "real-cugan": {
        "upscale": _cugan_upscale,
        "cleanup": _cugan_cleanup,
    },
    "real-esrgan": {
        "upscale": _esrgan_upscale,
        "cleanup": _esrgan_cleanup,
    },
    "waifu2x": {
        "upscale": _w2x_upscale,
        "cleanup": _w2x_cleanup,
    },
}


def _get_backend(model):
    backend = _BACKENDS.get(model)
    if not backend:
        raise ValueError(f"未知超分模型: {model}，可选: {list(_BACKENDS.keys())}")
    return backend


# ===================================================================
#  公共接口
# ===================================================================

def cleanup_cache():
    """释放所有模型缓存"""
    for backend in _BACKENDS.values():
        try:
            backend["cleanup"]()
        except Exception:
            pass
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def upscale_one(file_path, output_dir, scale, denoise, model="real-cugan",
                style="art", tta=False):
    """处理单张图片"""
    try:
        backend = _get_backend(model)
        img = Image.open(file_path)
        if model == "waifu2x":
            result = backend["upscale"](img, scale, denoise, style=style, tta=tta)
        else:
            result = backend["upscale"](img, scale, denoise)
        name = os.path.splitext(os.path.basename(file_path))[0]
        out_path = os.path.join(output_dir, f"{name}.png")
        result.save(out_path, "PNG")
        return {"file": file_path, "ok": True, "output": out_path}
    except Exception as e:
        return {"file": file_path, "ok": False, "error": str(e)}


def preview_upscale(file_path, scale, denoise, model="real-cugan",
                    style="art", tta=False):
    """单张预览，返回 base64"""
    try:
        backend = _get_backend(model)
        img = Image.open(file_path).convert("RGB")

        max_preview = 800
        w, h = img.size
        ratio = min(max_preview / w, max_preview / h, 1.0)
        if ratio < 1.0:
            img_small = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        else:
            img_small = img

        if model == "waifu2x":
            result = backend["upscale"](img_small, scale, denoise, style=style, tta=tta)
        else:
            result = backend["upscale"](img_small, scale, denoise)

        rw, rh = result.size
        original_resized = img_small.resize((rw, rh), Image.LANCZOS)

        def to_base64(pil_img):
            buf = io.BytesIO()
            pil_img.save(buf, format="WEBP", quality=85)
            return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

        return {
            "ok": True,
            "original": to_base64(original_resized),
            "upscaled": to_base64(result),
            "width": rw,
            "height": rh,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_available_models():
    """返回所有模型及其变体信息"""
    result = {}

    # Real-CUGAN
    cugan_variants = {}
    for (s, d), filename in _CUGAN_VARIANTS.items():
        path = os.path.join(_CUGAN_MODELS_DIR, filename)
        cugan_variants[f"{s}x-{d}"] = {"scale": s, "denoise": d, "installed": os.path.exists(path)}
    result["real-cugan"] = cugan_variants

    # Real-ESRGAN
    esrgan_path = os.path.join(_ESRGAN_MODELS_DIR, _ESRGAN_WEIGHT)
    result["real-esrgan"] = {"4x": {"scale": 4, "installed": os.path.exists(esrgan_path)}}

    # Waifu2x (nunif)
    result["waifu2x"] = {
        "styles": ["art", "art_scan", "photo"],
        "scales": [1, 2, 4],
        "denoise_levels": [-1, 0, 1, 2, 3],
        "tta": True,
    }

    return result
