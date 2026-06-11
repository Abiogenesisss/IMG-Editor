"""Global GPU/CUDA acceleration configuration."""

_gpu_enabled = True
_torch = None
_torch_import_error = None


def _get_torch():
    global _torch, _torch_import_error
    if _torch is not None:
        return _torch
    if _torch_import_error is not None:
        return None
    try:
        import torch
    except Exception as exc:
        _torch_import_error = exc
        return None
    _torch = torch
    return _torch


def set_gpu_enabled(enabled):
    global _gpu_enabled
    _gpu_enabled = bool(enabled)


def is_gpu_enabled():
    torch = _get_torch()
    return bool(_gpu_enabled and torch is not None and torch.cuda.is_available())


def get_device():
    return "cuda:0" if is_gpu_enabled() else "cpu"


def get_half():
    return is_gpu_enabled()


def get_onnx_providers():
    if is_gpu_enabled():
        try:
            import onnxruntime as ort

            available = ort.get_available_providers()
            if "CUDAExecutionProvider" in available:
                return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        except ImportError:
            pass
    return ["CPUExecutionProvider"]


def gpu_status():
    torch = _get_torch()
    cuda_available = bool(torch is not None and torch.cuda.is_available())
    info = {
        "cuda_available": cuda_available,
        "enabled": _gpu_enabled,
    }
    if _torch_import_error is not None:
        info["torch_error"] = _torch_import_error.__class__.__name__
    if cuda_available:
        info["gpu_name"] = torch.cuda.get_device_name(0)
        info["vram_total"] = round(
            torch.cuda.get_device_properties(0).total_memory / 1024**3, 1
        )
        try:
            free, _ = torch.cuda.mem_get_info()
            info["vram_free"] = round(free / 1024**3, 1)
        except Exception:
            pass
    return info
