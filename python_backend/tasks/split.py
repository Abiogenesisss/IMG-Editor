"""三阶段人物裁剪（全身/半身/头像）— 基于 ONNX YOLO 检测模型"""

import os
import json
import numpy as np
from PIL import Image

from tasks.gpu_config import get_onnx_providers

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODELS_DIR = os.path.join(_BACKEND_DIR, "models")

_PERSON_MODEL_PATH = os.path.join(_MODELS_DIR, "anime_person_detect.onnx")
_HALFBODY_MODEL_PATH = os.path.join(_MODELS_DIR, "anime_halfbody_detect.onnx")
_HEAD_MODEL_PATH = os.path.join(_MODELS_DIR, "anime_head_detect.onnx")

# ==================== ONNX 会话缓存 ====================

_sessions = {}


def cleanup_cache():
    """释放缓存的 ONNX 检测模型会话"""
    global _sessions
    _sessions = {}


def _load_session(model_path):
    """加载或获取缓存的 ONNX 推理会话"""
    if model_path in _sessions:
        return _sessions[model_path]

    import onnxruntime as ort

    if not os.path.isfile(model_path):
        raise RuntimeError(
            f"找不到检测模型：{model_path}\n"
            "请确认 python_backend/models/ 下存在对应的 .onnx 文件"
        )

    providers = get_onnx_providers()

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    session = ort.InferenceSession(model_path, options, providers=providers)
    _sessions[model_path] = session
    return session


# ==================== YOLO 检测通用逻辑 ====================


def _get_infer_size(session):
    """从 ONNX 元数据读取推理尺寸，默认 (640, 640)"""
    meta = session.get_modelmeta().custom_metadata_map
    if "imgsz" in meta:
        sz = json.loads(meta["imgsz"])
        return (sz, sz) if isinstance(sz, int) else tuple(sz)
    return (640, 640)


def _letterbox(image, target_size):
    """等比缩放 + 灰边填充到目标尺寸"""
    iw, ih = image.size
    tw, th = target_size
    scale = min(tw / iw, th / ih)
    nw, nh = int(iw * scale), int(ih * scale)

    resized = image.resize((nw, nh), Image.BILINEAR)
    padded = Image.new("RGB", (tw, th), (114, 114, 114))
    padded.paste(resized, ((tw - nw) // 2, (th - nh) // 2))

    return padded, scale, ((tw - nw) // 2, (th - nh) // 2)


def _nms(boxes, scores, iou_threshold):
    """非极大值抑制"""
    if len(boxes) == 0:
        return []

    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []

    while len(order) > 0:
        i = order[0]
        keep.append(i)
        if len(order) == 1:
            break

        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[np.where(iou <= iou_threshold)[0] + 1]

    return keep


def _yolo_detect(session, image, conf_threshold=0.3, iou_threshold=0.5):
    """
    通用 YOLO 检测，返回 [(x0, y0, x1, y1, score), ...] 按 score 降序。
    """
    infer_size = _get_infer_size(session)
    padded, scale, (pad_x, pad_y) = _letterbox(image, infer_size)

    # 预处理：HWC uint8 -> CHW float32 [0,1] -> 加 batch 维
    arr = np.array(padded, dtype=np.float32) / 255.0
    data = arr.transpose(2, 0, 1)[None, ...]

    # 推理
    output, = session.run(["output0"], {"images": data})
    output = np.squeeze(output)

    # 确保 shape 为 [N, 4+C]（每行一个检测框）
    if output.ndim == 2 and output.shape[0] < output.shape[1]:
        output = output.T

    if output.ndim != 2 or output.shape[1] < 5:
        return []

    # xywh -> xyxy（模型坐标系）
    cx, cy, w, h = output[:, 0], output[:, 1], output[:, 2], output[:, 3]
    x0 = cx - w / 2
    y0 = cy - h / 2
    x1 = cx + w / 2
    y1 = cy + h / 2

    # 取所有类别中的最大置信度
    class_scores = output[:, 4:]
    scores = class_scores.max(axis=1)
    mask = scores > conf_threshold

    if not mask.any():
        return []

    boxes = np.stack([x0[mask], y0[mask], x1[mask], y1[mask]], axis=1)
    scores = scores[mask]

    # 去除 letterbox 填充，映射回原图坐标
    boxes[:, [0, 2]] = (boxes[:, [0, 2]] - pad_x) / scale
    boxes[:, [1, 3]] = (boxes[:, [1, 3]] - pad_y) / scale

    # 裁剪到图片边界
    iw, ih = image.size
    boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, iw)
    boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, ih)

    # NMS
    keep = _nms(boxes, scores, iou_threshold)
    results = [(
        int(boxes[k][0]), int(boxes[k][1]),
        int(boxes[k][2]), int(boxes[k][3]),
        float(scores[k]),
    ) for k in keep]

    # 按 score 降序
    results.sort(key=lambda r: -r[4])
    return results


# ==================== 三阶段裁剪 ====================


def three_stage_split_batch(files, output_dir, person_conf=0.3, halfbody_conf=0.3,
                            head_conf=0.3, head_scale=1.5, progress_cb=None):
    """批量三阶段裁剪：全身 / 半身 / 头像"""
    person_sess = _load_session(_PERSON_MODEL_PATH)
    halfbody_sess = _load_session(_HALFBODY_MODEL_PATH)
    head_sess = _load_session(_HEAD_MODEL_PATH)

    os.makedirs(output_dir, exist_ok=True)
    total = len(files)
    count = 0
    results = []

    for idx, filepath in enumerate(files):
        try:
            image = Image.open(filepath).convert("RGB")
            basename = os.path.splitext(os.path.basename(filepath))[0]

            # ---- 阶段 1：检测人物 ----
            persons = _yolo_detect(person_sess, image,
                                   conf_threshold=person_conf, iou_threshold=0.5)
            if not persons:
                results.append({"file": filepath, "ok": True, "crops": 0})
                if progress_cb:
                    progress_cb(idx + 1, total)
                continue

            for pi, (px0, py0, px1, py1, _) in enumerate(persons):
                person_crop = image.crop((px0, py0, px1, py1))

                # 保存全身裁剪
                name = f"{basename}_person{pi}_{count:04d}.png"
                person_crop.save(os.path.join(output_dir, name), quality=95)
                count += 1

                # ---- 阶段 2：检测半身 ----
                halfbodies = _yolo_detect(halfbody_sess, person_crop,
                                          conf_threshold=halfbody_conf, iou_threshold=0.7)
                if halfbodies:
                    hx0, hy0, hx1, hy1, _ = halfbodies[0]
                    hb_crop = person_crop.crop((hx0, hy0, hx1, hy1))
                    name = f"{basename}_person{pi}_halfbody_{count:04d}.png"
                    hb_crop.save(os.path.join(output_dir, name), quality=95)
                    count += 1

                # ---- 阶段 3：检测头部（带放大裁剪） ----
                heads = _yolo_detect(head_sess, person_crop,
                                     conf_threshold=head_conf, iou_threshold=0.7)
                if heads:
                    hx0, hy0, hx1, hy1, _ = heads[0]
                    cx = (hx0 + hx1) / 2
                    cy = (hy0 + hy1) / 2
                    side = max(hx1 - hx0, hy1 - hy0) * head_scale

                    nx0 = int(max(cx - side / 2, 0))
                    ny0 = int(max(cy - side / 2, 0))
                    nx1 = int(min(cx + side / 2, person_crop.width))
                    ny1 = int(min(cy + side / 2, person_crop.height))

                    head_crop = person_crop.crop((nx0, ny0, nx1, ny1))
                    name = f"{basename}_person{pi}_head_{count:04d}.png"
                    head_crop.save(os.path.join(output_dir, name), quality=95)
                    count += 1

            results.append({"file": filepath, "ok": True})
        except Exception as e:
            results.append({"file": filepath, "ok": False, "error": str(e)})

        if progress_cb:
            progress_cb(idx + 1, total)

    return results
