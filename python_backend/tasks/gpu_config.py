"""全局 GPU/CUDA 加速配置模块"""

import torch

_gpu_enabled = True  # 默认开启


def set_gpu_enabled(enabled):
    """设置全局 GPU 开关"""
    global _gpu_enabled
    _gpu_enabled = bool(enabled)


def is_gpu_enabled():
    """当前是否应使用 GPU（开关开启且 CUDA 可用）"""
    return _gpu_enabled and torch.cuda.is_available()


def get_device():
    """返回当前应使用的 PyTorch 设备字符串"""
    return "cuda:0" if is_gpu_enabled() else "cpu"


def get_half():
    """是否使用半精度（仅 GPU 模式下启用）"""
    return is_gpu_enabled()


def get_onnx_providers():
    """返回当前应使用的 ONNX Runtime providers 列表"""
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
    """返回 GPU 状态信息"""
    info = {
        "cuda_available": torch.cuda.is_available(),
        "enabled": _gpu_enabled,
    }
    if torch.cuda.is_available():
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
