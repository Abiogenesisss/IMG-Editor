"""
AI Caption — 支持两种模式:
  1. API 模式: Gemini / Claude / OpenAI 兼容 API（远程请求）
  2. 本地模式: 通过 transformers 直接加载 VL 模型到 GPU/CPU（Qwen3.5 等）
     支持 4bit/8bit 量化、SDPA 注意力、图像预处理（白底填充+正方形缩放）
     预留通用本地模型接口，不仅限于 Qwen
"""

import os
import re
import base64
import mimetypes
import time
import threading
from io import BytesIO
from PIL import Image

from tasks.gpu_config import is_gpu_enabled

# 图片最大边长（API 模式，超过则缩放，减少 token 消耗）
MAX_IMAGE_SIZE = 2048

# =====================================================================
#  本地模型管理（单例）
# =====================================================================

_local_model = None       # 当前加载的模型实例
_local_processor = None   # 当前加载的 processor
_local_model_id = None    # 当前模型标识（用于判断是否需要重新加载）
_local_model_info = {}    # 模型元信息（model_type, device, quant 等）
_local_inference_lock = threading.Lock()


def _image_preprocess(image, target_size=1024):
    """图像预处理：RGBA→白底RGB → 正方形白边填充 → 缩放到 target_size"""
    import cv2
    import numpy as np

    # RGBA → 白底 RGB
    image = image.convert('RGBA')
    bg = Image.new('RGBA', image.size, 'WHITE')
    bg.alpha_composite(image)
    image = bg.convert('RGB')

    # 正方形白边填充
    w, h = image.size
    desired = max(max(w, h), target_size)
    dw, dh = desired - w, desired - h
    top, bottom = dh // 2, dh - (dh // 2)
    left, right = dw // 2, dw - (dw // 2)
    img_arr = np.asarray(image)
    padded = cv2.copyMakeBorder(img_arr, top, bottom, left, right,
                                 borderType=cv2.BORDER_CONSTANT, value=[255, 255, 255])

    # 缩放到 target_size
    if padded.shape[0] > target_size:
        padded = cv2.resize(padded, (target_size, target_size), interpolation=cv2.INTER_AREA)
    elif padded.shape[0] < target_size:
        padded = cv2.resize(padded, (target_size, target_size), interpolation=cv2.INTER_LANCZOS4)

    return Image.fromarray(padded)


def local_load_model(model_path, quantization="none", use_sdpa=False,
                     use_cpu=False, image_size=1024, model_type="auto"):
    """
    加载本地 VL 模型到内存。
    model_path: HuggingFace model ID 或本地路径
    quantization: "none" / "4bit" / "8bit"
    use_sdpa: 是否使用 SDPA (PyTorch 原生注意力)
    use_cpu: 是否强制使用 CPU
    model_type: "auto" 自动检测 / "qwen" / "其他未来扩展"
    """
    global _local_model, _local_processor, _local_model_id, _local_model_info
    import torch

    # 如果已经加载了同一个模型，跳过
    cache_key = f"{model_path}|{quantization}|{use_sdpa}|{use_cpu}"
    if _local_model is not None and _local_model_id == cache_key:
        return {"ok": True, "message": "模型已加载，无需重复加载"}

    # 先卸载旧模型
    if _local_model is not None:
        local_unload_model()

    start = time.monotonic()

    try:
        from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

        # 量化配置
        quant_config = None
        compute_dtype = torch.float16
        if quantization == "4bit":
            quant_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=compute_dtype,
                bnb_4bit_use_double_quant=True
            )
        elif quantization == "8bit":
            quant_config = BitsAndBytesConfig(
                load_in_8bit=True,
                llm_int8_enable_fp32_cpu_offload=True
            )

        device_map = "cpu" if use_cpu else ("auto" if is_gpu_enabled() else "cpu")
        attn_impl = "sdpa" if use_sdpa else None

        # 判断是否为本地路径
        is_local = os.path.isdir(model_path)

        load_kwargs = {
            "device_map": device_map,
            "trust_remote_code": True,
            "local_files_only": is_local,
        }
        if quant_config is not None:
            load_kwargs["quantization_config"] = quant_config
            load_kwargs["torch_dtype"] = compute_dtype
        if attn_impl:
            load_kwargs["attn_implementation"] = attn_impl

        _local_model = AutoModelForImageTextToText.from_pretrained(
            model_path, **load_kwargs
        )
        _local_model.eval()

        _local_processor = AutoProcessor.from_pretrained(
            model_path, trust_remote_code=True, local_files_only=is_local
        )

        _local_model_id = cache_key
        elapsed = time.monotonic() - start
        _local_model_info = {
            "model_path": model_path,
            "model_type": model_type,
            "quantization": quantization,
            "use_sdpa": use_sdpa,
            "use_cpu": use_cpu,
            "image_size": image_size,
            "load_time": round(elapsed, 1),
        }

        return {"ok": True, "message": f"模型加载完成 ({elapsed:.1f}s)", "info": _local_model_info}

    except Exception as e:
        _local_model = None
        _local_processor = None
        _local_model_id = None
        _local_model_info = {}
        return {"ok": False, "error": str(e)}


def local_unload_model():
    """卸载本地模型，释放显存/内存"""
    global _local_model, _local_processor, _local_model_id, _local_model_info
    import gc

    if _local_model is not None:
        del _local_model
        _local_model = None
    if _local_processor is not None:
        del _local_processor
        _local_processor = None
    _local_model_id = None
    _local_model_info = {}

    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    return {"ok": True, "message": "模型已卸载"}


def local_model_status():
    """查询当前本地模型状态"""
    if _local_model is None:
        return {"loaded": False}
    return {"loaded": True, "info": _local_model_info}


def _generate_local_captions(processed_images, system_prompt, user_prompt,
                             temperature=0, top_p=0, max_tokens=1024,
                             disable_think=False):
    """Run local VL inference under a process-wide lock."""
    import torch

    with _local_inference_lock:
        if _local_model is None or _local_processor is None:
            raise RuntimeError("本地模型未加载，请先调用 local_load_model")

        if not _local_model_info.get("use_cpu", False):
            torch.cuda.empty_cache()

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": user_prompt}
            ]
        })

        text = _local_processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
        )

        inputs = _local_processor(
            images=processed_images,
            text=[text] * len(processed_images),
            padding=True,
            return_tensors="pt"
        ).to(_local_model.device)

        gen_kwargs = {}
        if max_tokens and max_tokens > 0:
            gen_kwargs["max_new_tokens"] = max_tokens
        if temperature and temperature > 0:
            gen_kwargs["temperature"] = temperature
            gen_kwargs["do_sample"] = True
        if top_p and top_p > 0:
            gen_kwargs["top_p"] = top_p

        with torch.no_grad():
            gen_ids = _local_model.generate(**inputs, **gen_kwargs)
            gen_ids = [out[len(inp):] for inp, out in zip(inputs.input_ids, gen_ids)]
            captions = _local_processor.batch_decode(
                gen_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False
            )

    if disable_think:
        captions = [_strip_think_tags(cap) for cap in captions]

    return captions


def local_caption_one(image_path, system_prompt, user_prompt,
                      temperature=0, top_p=0, max_tokens=1024,
                      image_size=1024, disable_think=False):
    """本地模型：单张推理"""
    try:
        img = Image.open(image_path)
        preprocessed = _image_preprocess(img, image_size)
        captions = _generate_local_captions(
            [preprocessed], system_prompt, user_prompt,
            temperature, top_p, max_tokens, disable_think
        )
        return {"ok": True, "caption": captions[0]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def local_caption_batch(files, system_prompt, user_prompt,
                        temperature=0, top_p=0, max_tokens=1024,
                        image_size=1024, disable_think=False,
                        cancel_event=None, progress_cb=None):
    """本地模型：批量推理（逐张顺序执行，避免本地 VL 批量生成的显存风险）"""
    results = [None] * len(files)
    done_count = 0
    total = len(files)

    for idx, fp in enumerate(files):
        if cancel_event and cancel_event.is_set():
            break

        try:
            img = Image.open(fp)
            preprocessed = _image_preprocess(img, image_size)
        except Exception as e:
            r = {"ok": False, "error": f"Load/Preprocess Error: {str(e)}"}
            results[idx] = {"file": fp, **r}
            done_count += 1
            if progress_cb:
                progress_cb(done_count, total, fp, r)
            continue

        try:
            captions = _generate_local_captions(
                [preprocessed], system_prompt, user_prompt,
                temperature, top_p, max_tokens, disable_think
            )
            r = {"ok": True, "caption": captions[0]}
        except Exception as e:
            r = {"ok": False, "error": f"Inference Error: {str(e)}"}

        results[idx] = {"file": fp, **r}
        done_count += 1
        if progress_cb:
            progress_cb(done_count, total, fp, r)

    # 填充被取消的结果
    for i in range(len(results)):
        if results[i] is None:
            results[i] = {"file": files[i], "ok": False, "error": "cancelled"}

    return results


# =====================================================================
#  API 模式（保留原有逻辑）
# =====================================================================

# ---------- Client 缓存 ----------
_client_cache = {}  # key: (provider, api_key, base_url) -> client


def _get_client(provider, api_key, base_url=""):
    """获取或创建缓存的 API Client"""
    cache_key = (provider, api_key, base_url)
    if cache_key in _client_cache:
        return _client_cache[cache_key]

    client = None
    if provider == "gemini":
        from google import genai
        client_kwargs = {"api_key": api_key}
        if base_url:
            client_kwargs["api_endpoint"] = base_url
        client = genai.Client(**client_kwargs)
    elif provider == "claude":
        import anthropic
        client_kwargs = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        client = anthropic.Anthropic(**client_kwargs)
    else:
        from openai import OpenAI
        client_kwargs = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        client = OpenAI(**client_kwargs)

    _client_cache[cache_key] = client
    return client


def _load_and_encode_image(image_path, max_size=MAX_IMAGE_SIZE, image_size=0):
    """读取图片，必要时缩放，返回 (base64_str, media_type)
    当 image_size > 0 时，使用与本地模型相同的预处理：白底填充+正方形缩放
    """
    ext = os.path.splitext(image_path)[1].lower()
    media_type = mimetypes.types_map.get(ext, "image/jpeg")
    if media_type == "image/jpg":
        media_type = "image/jpeg"

    img = Image.open(image_path)

    if image_size and image_size > 0:
        # 与本地模型相同的预处理：RGBA→白底RGB → 正方形白边填充 → 缩放到 image_size
        img = _image_preprocess(img, target_size=image_size)
    else:
        # RGBA → RGB
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # 大图缩放
        w, h = img.size
        if max(w, h) > max_size:
            ratio = max_size / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    buf = BytesIO()
    fmt = "PNG" if ext == ".png" else "JPEG"
    img.save(buf, format=fmt, quality=90)
    b64 = base64.standard_b64encode(buf.getvalue()).decode("utf-8")

    if fmt == "JPEG":
        media_type = "image/jpeg"
    elif fmt == "PNG":
        media_type = "image/png"

    return b64, media_type


def _detect_provider(model):
    """根据模型名自动检测 provider"""
    m = model.lower()
    if "gemini" in m:
        return "gemini"
    if "claude" in m:
        return "claude"
    # 默认走 OpenAI 兼容接口
    return "openai"


def _caption_gemini(client, image_path, model, system_prompt, user_prompt,
                    temperature=0, top_p=0, max_tokens=1024, image_size=0):
    """使用缓存的 Gemini client 生成描述"""
    from google.genai import types

    b64_data, media_type = _load_and_encode_image(image_path, image_size=image_size)
    image_bytes = base64.standard_b64decode(b64_data)

    contents = [
        types.Part.from_bytes(data=image_bytes, mime_type=media_type),
        types.Part.from_text(text=user_prompt),
    ]

    gen_config_kwargs = {}
    if max_tokens and max_tokens > 0:
        gen_config_kwargs["max_output_tokens"] = max_tokens
    if temperature and temperature > 0:
        gen_config_kwargs["temperature"] = temperature
    if top_p and top_p > 0:
        gen_config_kwargs["top_p"] = top_p

    gen_config = types.GenerateContentConfig(
        system_instruction=system_prompt if system_prompt else None,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        **gen_config_kwargs,
    )

    response = client.models.generate_content(
        model=model, contents=contents, config=gen_config,
    )
    caption = response.text.strip() if response.text else ""
    return {"ok": True, "caption": caption}


def _caption_claude(client, image_path, model, system_prompt, user_prompt,
                    temperature=0, top_p=0, max_tokens=1024, image_size=0):
    """使用缓存的 Claude client 生成描述"""
    b64_data, media_type = _load_and_encode_image(image_path, image_size=image_size)

    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64_data}},
            {"type": "text", "text": user_prompt},
        ],
    }]

    msg_kwargs = {"model": model, "max_tokens": max_tokens or 1024, "messages": messages}
    if system_prompt:
        msg_kwargs["system"] = system_prompt
    if temperature and temperature > 0:
        msg_kwargs["temperature"] = temperature
    if top_p and top_p > 0:
        msg_kwargs["top_p"] = top_p

    response = client.messages.create(**msg_kwargs)
    caption = "".join(b.text for b in response.content if b.type == "text").strip()
    return {"ok": True, "caption": caption}


def _caption_openai(client, image_path, model, system_prompt, user_prompt,
                    temperature=0, top_p=0, max_tokens=1024, image_size=0):
    """使用缓存的 OpenAI 兼容 client 生成描述"""
    b64_data, media_type = _load_and_encode_image(image_path, image_size=image_size)

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{b64_data}"}},
            {"type": "text", "text": user_prompt},
        ],
    })

    kwargs = {"model": model, "messages": messages, "max_tokens": max_tokens or 1024}
    if temperature and temperature > 0:
        kwargs["temperature"] = temperature
    if top_p and top_p > 0:
        kwargs["top_p"] = top_p

    response = client.chat.completions.create(**kwargs)
    caption = response.choices[0].message.content.strip()
    return {"ok": True, "caption": caption}


_DISPATCH = {
    "gemini": _caption_gemini,
    "claude": _caption_claude,
    "openai": _caption_openai,
}


def _strip_think_tags(text):
    """去除模型输出中的 <think>...</think> 思考标签"""
    return re.sub(r'<think>.*?</think>\s*', '', text, flags=re.DOTALL).strip()


def caption_one(image_path, model, api_key, system_prompt, user_prompt,
                temperature=0, top_p=0, max_tokens=1024, base_url="",
                disable_think=False, image_size=0, **kwargs):
    """统一入口：根据模型名分发到对应的 API"""
    provider = _detect_provider(model)
    try:
        client = _get_client(provider, api_key, base_url)
        fn = _DISPATCH[provider]
        result = fn(client, image_path, model, system_prompt, user_prompt,
                  temperature, top_p, max_tokens, image_size=image_size)
        if disable_think and result.get("ok") and result.get("caption"):
            result["caption"] = _strip_think_tags(result["caption"])
        return result
    except ImportError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def caption_batch_api(files, model, api_key, system_prompt, user_prompt,
                      temperature=0, top_p=0, max_tokens=1024, base_url="",
                      disable_think=False,
                      concurrency=4, cancel_event=None, progress_cb=None,
                      image_size=0):
    """API 模式批量并发请求"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    provider = _detect_provider(model)
    try:
        client = _get_client(provider, api_key, base_url)
    except ImportError as e:
        return [{"file": f, "ok": False, "error": str(e)} for f in files]
    except Exception as e:
        return [{"file": f, "ok": False, "error": str(e)} for f in files]

    fn = _DISPATCH[provider]
    results = [None] * len(files)
    done_count = 0
    done_lock = threading.Lock()
    total = len(files)

    def do_one(idx, file_path):
        try:
            r = fn(client, file_path, model, system_prompt, user_prompt,
                           temperature, top_p, max_tokens, image_size=image_size)
            if disable_think and r.get("ok") and r.get("caption"):
                r["caption"] = _strip_think_tags(r["caption"])
            return idx, r
        except Exception as e:
            return idx, {"ok": False, "error": str(e)}

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {}
        for i, f in enumerate(files):
            if cancel_event and cancel_event.is_set():
                break
            futures[pool.submit(do_one, i, f)] = i

        for future in as_completed(futures):
            # 先提取当前已完成请求的结果
            idx, r = future.result()
            results[idx] = {"file": files[idx], **r}
            
            # 再检查是否有取消指令，如果有则打断后续
            if cancel_event and cancel_event.is_set():
                # 尝试取消还没开始执行的任务
                for remaining in futures:
                    if not remaining.done():
                        remaining.cancel()
                break
            with done_lock:
                done_count += 1
                current_done = done_count
            if progress_cb:
                progress_cb(current_done, total, files[idx], r)

    # 填充被取消的结果
    for i in range(len(results)):
        if results[i] is None:
            results[i] = {"file": files[i], "ok": False, "error": "cancelled"}

    return results


def caption_batch_multi_api(files, api_configs, system_prompt, user_prompt,
                            temperature=0, top_p=0, max_tokens=1024,
                            disable_think=False,
                            concurrency=4, cancel_event=None, progress_cb=None,
                            image_size=0):
    """多API配置批量并发请求 — 将文件轮流分配给多个API配置"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not api_configs:
        return [{"file": f, "ok": False, "error": "no api configs"} for f in files]

    # 预创建所有client
    clients = []
    for cfg in api_configs:
        model = cfg.get("model", "")
        api_key = cfg.get("apiKey", "")
        base_url = cfg.get("endpoint", "")
        provider = _detect_provider(model)
        try:
            client = _get_client(provider, api_key, base_url)
            clients.append({"client": client, "model": model, "provider": provider})
        except Exception as e:
            clients.append({"client": None, "error": str(e), "model": model, "provider": provider})

    # 过滤掉创建失败的client
    valid_clients = [c for c in clients if c["client"] is not None]
    if not valid_clients:
        errors = "; ".join(c.get("error", "unknown") for c in clients)
        return [{"file": f, "ok": False, "error": f"all API configs failed: {errors}"} for f in files]

    results = [None] * len(files)
    done_count = 0
    done_lock = threading.Lock()
    total = len(files)

    def do_one(idx, file_path, client_info):
        provider = client_info["provider"]
        client = client_info["client"]
        model = client_info["model"]
        fn = _DISPATCH[provider]
        try:
            r = fn(client, file_path, model, system_prompt, user_prompt,
                   temperature, top_p, max_tokens, image_size=image_size)
            if disable_think and r.get("ok") and r.get("caption"):
                r["caption"] = _strip_think_tags(r["caption"])
            return idx, r
        except Exception as e:
            return idx, {"ok": False, "error": str(e)}

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {}
        for i, f in enumerate(files):
            if cancel_event and cancel_event.is_set():
                break
            # 轮流分配给不同的API配置
            client_info = valid_clients[i % len(valid_clients)]
            futures[pool.submit(do_one, i, f, client_info)] = i

        for future in as_completed(futures):
            # 取结果
            idx, r = future.result()
            results[idx] = {"file": files[idx], **r}
            
            # 判断取消
            if cancel_event and cancel_event.is_set():
                for remaining in futures:
                    if not remaining.done():
                        remaining.cancel()
                break
            with done_lock:
                done_count += 1
                current_done = done_count
            if progress_cb:
                progress_cb(current_done, total, files[idx], r)

    for i in range(len(results)):
        if results[i] is None:
            results[i] = {"file": files[i], "ok": False, "error": "cancelled"}

    return results


def cleanup_local_model():
    """用于 server.py 的 cleanup_caches 清理入口"""
    global _client_cache
    if _local_model is not None:
        local_unload_model()
    _client_cache.clear()
