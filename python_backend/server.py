"""
IMG_Editor Python 后端
HTTP 服务 + 进程池调度，业务逻辑在 tasks/ 下
"""

import os
import json
import socket
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

from tasks.parallel import (run_parallel, clear_cancelled, shutdown_pool,
                            CancelledError, _cancel_event)

from tasks.flip import flip_one
from tasks.filter_resolution import filter_one
from tasks.resize import resize_one
from tasks.convert import convert_one
from tasks.alpha import flatten_alpha_one
from tasks.crop import crop_one, crop_auto_one
from tasks.dedup import extract_perceptual_batch, find_duplicates_perceptual
from tasks.cluster import (extract_style_batch, extract_semantic_batch,
                           extract_fusion_batch, cluster_features, copy_files_to_groups)
from tasks.split import three_stage_split_batch
from tasks.augment import cutout_one, perspective_one, gaussian_blur_noise_one, preview_augment
from tasks.tagger import list_models as tagger_list_models, download_model as tagger_download, tag_batch
from tasks.upscale import upscale_one, preview_upscale, get_available_models as upscale_models, cleanup_cache as upscale_cleanup
from tasks.caption import (caption_one, caption_batch_api, caption_batch_multi_api,
                           local_load_model, local_unload_model, local_model_status,
                           local_caption_one, local_caption_batch, cleanup_local_model)
from tasks.grab import run_grab_download

# 导入各模块的缓存清理函数
from tasks.resize import cleanup_cache as resize_cleanup
from tasks.split import cleanup_cache as split_cleanup
from tasks.tagger import cleanup_cache as tagger_cleanup
from tasks.cluster import cleanup_cache as cluster_cleanup
from tasks.gpu_config import set_gpu_enabled, gpu_status as get_gpu_status

BACKEND_TOKEN = os.environ.get("IMG_EDITOR_BACKEND_TOKEN", "")


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------- HTTP Handler ----------

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _public_error(self, exc):
        message = str(exc).strip().splitlines()[0] if str(exc).strip() else exc.__class__.__name__
        return message[:1000]

    def _log_exception(self, exc, context="request failed"):
        logging.exception("%s: %s", context, self.path)
        return self._public_error(exc)

    def _authorized(self):
        if not BACKEND_TOKEN:
            return True
        return self.headers.get("X-IMG-Editor-Token", "") == BACKEND_TOKEN

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _begin_sse(self):
        """开启 SSE 流式响应"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def _send_event(self, event, data):
        """发送一条 SSE 事件"""
        payload = json.dumps(data, ensure_ascii=False)
        self.wfile.write(f"event: {event}\ndata: {payload}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _run_sse_parallel(self, body, fn, args_builder, require_output=True):
        """通用 SSE 并行任务模板：校验 → makedirs → begin_sse → run_parallel → send done"""
        files = body.get("files", [])
        output_dir = body.get("output_dir", "")

        if not files:
            return self._json({"success": False, "error": "no files selected"}, 400)
        if require_output and not output_dir:
            return self._json({"success": False, "error": "no output directory specified"}, 400)

        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        self._begin_sse()

        try:
            args_list = args_builder(files, body)
            results = run_parallel(fn, args_list,
                                   progress_cb=lambda d, t: self._send_event("progress", {"done": d, "total": t}))
            ok_count = sum(1 for r in results if r.get("ok"))
            self._send_event("done", {
                "success": True,
                "processed": ok_count,
                "failed": len(results) - ok_count,
                "results": results,
            })
        except CancelledError:
            self._send_event("done", {"success": False, "error": "task cancelled"})
        except Exception as exc:
            self._send_event("done", {"success": False, "error": self._log_exception(exc, "parallel task failed")})

    # ---- 路由 ----
    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok"})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if not self._authorized():
            return self._json({"success": False, "error": "forbidden"}, 403)

        routes = {
            "/mirror-flip": self._mirror_flip,
            "/resolution-filter": self._resolution_filter,
            "/batch-resize": self._batch_resize,
            "/format-convert": self._format_convert,
            "/flatten-alpha": self._flatten_alpha,
            "/proportional-crop": self._proportional_crop,
            "/auto-crop": self._auto_crop,
            "/deduplicate": self._deduplicate,
            "/cluster": self._cluster,
            "/cluster-move": self._cluster_move,
            "/three-stage-split": self._three_stage_split,
            "/cutout": self._cutout,
            "/perspective": self._perspective,
            "/gaussian-blur-noise": self._gaussian_blur_noise,
            "/preview-augment": self._preview_augment,
            "/tagger-models": self._tagger_models,
            "/tagger-download": self._tagger_download,
            "/tagger-tag": self._tagger_tag,
            "/upscale": self._upscale,
            "/preview-upscale": self._preview_upscale,
            "/upscale-models": self._upscale_models,
            "/caption-single": self._caption_single,
            "/caption-batch": self._caption_batch,
            "/caption-batch-multi-api": self._caption_batch_multi_api,
            "/local-model-load": self._local_model_load,
            "/local-model-unload": self._local_model_unload,
            "/local-model-status": self._local_model_status,
            "/local-caption-single": self._local_caption_single,
            "/local-caption-batch": self._local_caption_batch,
            "/cleanup-caches": self._cleanup_caches,
            "/gpu-status": self._gpu_status,
            "/set-gpu-config": self._set_gpu_config,
            "/grab-download": self._grab_download,
            "/cancel": self._cancel,
        }
        handler = routes.get(self.path)
        if handler:
            try:
                handler()
            except Exception as exc:
                error = self._log_exception(exc)
                try:
                    self._json({"success": False, "error": error}, 500)
                except Exception:
                    pass
        else:
            self._json({"error": "not found"}, 404)

    # ---- 镜像翻转 ----
    def _mirror_flip(self):
        body = self._read_body()
        self._run_sse_parallel(body, flip_one,
            lambda files, b: [(f, b["output_dir"]) for f in files])

    # ---- 分辨率过滤 ----
    def _resolution_filter(self):
        body = self._read_body()
        files = body.get("files", [])
        if not files:
            return self._json({"success": False, "error": "no files selected"}, 400)

        min_w, max_w = body.get("min_width", 0), body.get("max_width", 0)
        min_h, max_h = body.get("min_height", 0), body.get("max_height", 0)

        self._begin_sse()
        try:
            results = run_parallel(filter_one, [(f, min_w, max_w, min_h, max_h) for f in files],
                                   progress_cb=lambda d, t: self._send_event("progress", {"done": d, "total": t}))
            filtered_count = sum(1 for r in results if r.get("filtered"))
            self._send_event("done", {
                "success": True,
                "filtered_count": filtered_count,
                "total": len(results),
                "results": results,
            })
        except CancelledError:
            self._send_event("done", {"success": False, "error": "task cancelled"})
        except Exception as exc:
            self._send_event("done", {"success": False, "error": self._log_exception(exc, "resolution filter failed")})

    # ---- 批量缩放 ----
    def _batch_resize(self):
        body = self._read_body()
        files = body.get("files", [])
        output_dir = body.get("output_dir", "")
        if not files:
            return self._json({"success": False, "error": "no files selected"}, 400)
        if not output_dir:
            return self._json({"success": False, "error": "no output directory specified"}, 400)

        width = body.get("width", 1024)
        height = body.get("height", 1024)
        allow_upscale = body.get("allow_upscale", False)
        face_threshold = body.get("face_threshold", 0.5)

        os.makedirs(output_dir, exist_ok=True)
        self._begin_sse()

        try:
            results = run_parallel(resize_one,
                [(f, output_dir, width, height, allow_upscale, face_threshold) for f in files],
                progress_cb=lambda d, t: self._send_event("progress", {"done": d, "total": t}))
            ok_count = sum(1 for r in results if r["ok"])
            skipped = sum(1 for r in results if r.get("skipped"))
            self._send_event("done", {
                "success": True,
                "processed": ok_count,
                "skipped": skipped,
                "failed": len(results) - ok_count,
                "results": results,
            })
        except CancelledError:
            self._send_event("done", {"success": False, "error": "task cancelled"})
        except Exception as exc:
            self._send_event("done", {"success": False, "error": self._log_exception(exc, "batch resize failed")})

    # ---- 格式转换 ----
    def _format_convert(self):
        body = self._read_body()
        self._run_sse_parallel(body, convert_one,
            lambda files, b: [(f, b["output_dir"], b.get("target_format", "png")) for f in files])

    # ---- 透明通道合成 ----
    def _flatten_alpha(self):
        body = self._read_body()
        self._run_sse_parallel(body, flatten_alpha_one,
            lambda files, b: [(f, b["output_dir"], b.get("background", "white")) for f in files])

    # ---- 按比例裁剪 ----
    def _proportional_crop(self):
        body = self._read_body()
        self._run_sse_parallel(body, crop_one,
            lambda files, b: [(f, b["output_dir"], b.get("ratio_w", 1), b.get("ratio_h", 1)) for f in files])

    # ---- 自动比例裁剪 ----
    def _auto_crop(self):
        body = self._read_body()
        ratio_list = body.get("ratio_list", [])
        if not ratio_list:
            return self._json({"success": False, "error": "no ratio list"}, 400)
        ratio_tuples = [(r[0], r[1]) for r in ratio_list]
        self._run_sse_parallel(body, crop_auto_one,
            lambda files, b: [(f, b["output_dir"], ratio_tuples) for f in files])

    # ---- 去重 ----
    def _deduplicate(self):
        body = self._read_body()
        files = body.get("files", [])
        hash_thresh = body.get("hash_thresh", 10)
        phash_thresh = body.get("phash_thresh", 10)
        color_thresh = body.get("color_thresh", 0.5)

        if not files:
            return self._json({"success": False, "error": "no files selected"}, 400)

        self._begin_sse()

        feat_results = extract_perceptual_batch(files,
                                                progress_cb=lambda d, t: self._send_event("progress", {"done": d, "total": t, "stage": "extract"}))

        duplicates, dedup_backend = find_duplicates_perceptual(
            feat_results,
            hash_thresh=hash_thresh,
            phash_thresh=phash_thresh,
            color_thresh=color_thresh,
            progress_cb=lambda d, t, s="match": self._send_event("progress", {"done": d, "total": t, "stage": s}),
            return_debug=True
        )

        group_count = len(set(d["group"] for d in duplicates if d["group"] is not None))
        dup_count = sum(1 for d in duplicates if d["group"] is not None)

        self._send_event("done", {
            "success": True,
            "total": len(files),
            "duplicate_count": dup_count,
            "group_count": group_count,
            "results": duplicates,
            "backend": dedup_backend,
        })

    # ---- 聚类 ----
    def _cluster(self):
        body = self._read_body()
        files = body.get("files", [])
        method = body.get("method", "style")
        algorithm = body.get("algorithm", "kmeans")
        k = body.get("k", 5)
        fusion_weights = body.get("fusion_weights", None)

        if not files:
            return self._json({"success": False, "error": "no files"}, 400)

        self._begin_sse()

        try:
            progress_cb = lambda d, t: self._send_event("progress", {"done": d, "total": t})

            if fusion_weights:
                feature_results = extract_fusion_batch(
                    files, progress_cb=progress_cb,
                    weight_style=fusion_weights.get("style", 0.0),
                    weight_semantic=fusion_weights.get("semantic", 0.0),
                    weight_color=fusion_weights.get("color", 0.0),
                )
            elif method == "style":
                feature_results = extract_style_batch(files, progress_cb=progress_cb)
            elif method == "semantic":
                feature_results = extract_semantic_batch(files, progress_cb=progress_cb)
            else:
                return self._send_event("done", {"success": False, "error": f"unknown method: {method}"})

            results = cluster_features(feature_results, algorithm=algorithm, k=k)
            group_count = len(set(r["group"] for r in results if r["group"] is not None))

            self._send_event("done", {
                "success": True,
                "total": len(files),
                "group_count": group_count,
                "results": results,
            })
        except Exception as exc:
            self._send_event("done", {"success": False, "error": self._log_exception(exc, "cluster failed")})

    # ---- 聚类结果移动到子文件夹 ----
    def _cluster_move(self):
        body = self._read_body()
        files_by_group = body.get("files_by_group", {})
        output_dir = body.get("output_dir", "")

        if not files_by_group:
            return self._json({"success": False, "error": "no files"}, 400)
        if not output_dir:
            return self._json({"success": False, "error": "no output directory"}, 400)

        result = copy_files_to_groups(files_by_group, output_dir)
        self._json(result)

    # ---- 三阶段人物裁剪 ----
    def _three_stage_split(self):
        body = self._read_body()
        files = body.get("files", [])
        output_dir = body.get("output_dir", "")
        person_conf = body.get("person_conf", 0.3)
        halfbody_conf = body.get("halfbody_conf", 0.3)
        head_conf = body.get("head_conf", 0.3)

        if not files:
            return self._json({"success": False, "error": "no files selected"}, 400)
        if not output_dir:
            return self._json({"success": False, "error": "no output directory specified"}, 400)

        os.makedirs(output_dir, exist_ok=True)
        self._begin_sse()

        results = three_stage_split_batch(
            files, output_dir,
            person_conf=person_conf,
            halfbody_conf=halfbody_conf,
            head_conf=head_conf,
            progress_cb=lambda d, t: self._send_event("progress", {"done": d, "total": t})
        )
        ok_count = sum(1 for r in results if r.get("ok"))
        self._send_event("done", {
            "success": True,
            "processed": ok_count,
            "total": len(files),
            "results": results,
        })

    # ---- Cutout ----
    def _cutout(self):
        body = self._read_body()
        self._run_sse_parallel(body, cutout_one,
            lambda files, b: [(f, b["output_dir"], b.get("count", 1), b.get("size_ratio", 0.15)) for f in files])

    # ---- 透视变换 ----
    def _perspective(self):
        body = self._read_body()
        self._run_sse_parallel(body, perspective_one,
            lambda files, b: [(f, b["output_dir"], b.get("intensity", 0.1)) for f in files])

    # ---- 高斯模糊 + 噪声 ----
    def _gaussian_blur_noise(self):
        body = self._read_body()
        self._run_sse_parallel(body, gaussian_blur_noise_one,
            lambda files, b: [(f, b["output_dir"], b.get("blur_radius", 2.0), b.get("noise_sigma", 15.0)) for f in files])

    # ---- 增强预览 ----
    def _preview_augment(self):
        body = self._read_body()
        fpath = body.get("file", "")
        aug_type = body.get("aug_type", "")
        params = body.get("params", {})

        if not fpath:
            return self._json({"ok": False, "error": "no file"}, 400)
        if not aug_type:
            return self._json({"ok": False, "error": "no aug_type"}, 400)

        result = preview_augment(fpath, aug_type, params)
        self._json(result)

    # ---- Tagger: 模型列表 ----
    def _tagger_models(self):
        models = tagger_list_models()
        self._json({"success": True, "models": models})

    # ---- Tagger: 下载模型 ----
    def _tagger_download(self):
        body = self._read_body()
        model_key = body.get("model_key", "")

        if not model_key:
            return self._json({"success": False, "error": "no model_key"}, 400)

        self._begin_sse()

        def on_progress(step, total_steps, file_name, downloaded, total):
            self._send_event("progress", {
                "step": step,
                "total_steps": total_steps,
                "file": file_name,
                "downloaded": downloaded,
                "total": total,
            })

        try:
            result = tagger_download(model_key, progress_cb=on_progress)
            self._send_event("done", {"success": result.get("ok", False),
                                       "error": result.get("error", "")})
        except Exception as e:
            self._send_event("done", {"success": False, "error": str(e)})

    # ---- Tagger: 批量打标 ----
    def _tagger_tag(self):
        body = self._read_body()
        files = body.get("files", [])
        model_key = body.get("model_key", "")
        general_threshold = body.get("general_threshold", 0.35)
        character_threshold = body.get("character_threshold", 0.85)
        keep_copyright = bool(body.get("keep_copyright", True))
        keep_rating = bool(body.get("keep_rating", False))
        keep_meta = bool(body.get("keep_meta", False))
        keep_model = bool(body.get("keep_model", False))
        keep_quality = bool(body.get("keep_quality", False))

        if not files:
            return self._json({"success": False, "error": "no files"}, 400)
        if not model_key:
            return self._json({"success": False, "error": "no model_key"}, 400)

        self._begin_sse()

        try:
            results = tag_batch(
                files, model_key,
                general_threshold=general_threshold,
                character_threshold=character_threshold,
                keep_copyright=keep_copyright,
                keep_rating=keep_rating,
                keep_meta=keep_meta,
                keep_model=keep_model,
                keep_quality=keep_quality,
                progress_cb=lambda d, t: self._send_event("progress", {"done": d, "total": t})
            )
            ok_count = sum(1 for r in results if r.get("ok"))
            self._send_event("done", {
                "success": True,
                "processed": ok_count,
                "total": len(files),
                "results": results,
            })
        except Exception as exc:
            self._send_event("done", {"success": False, "error": self._log_exception(exc, "tagger failed")})

    # ---- 超分辨率: 批量处理（GPU 顺序执行，不走进程池）----
    def _upscale(self):
        body = self._read_body()
        files = body.get("files", [])
        output_dir = body.get("output_dir", "")
        scale = body.get("scale", 2)
        denoise = body.get("denoise", "no-denoise")
        model = body.get("model", "real-cugan")
        style = body.get("style", "art")
        tta = body.get("tta", False)

        if not files:
            return self._json({"success": False, "error": "no files selected"}, 400)
        if not output_dir:
            return self._json({"success": False, "error": "no output directory specified"}, 400)

        os.makedirs(output_dir, exist_ok=True)
        self._begin_sse()

        clear_cancelled()
        total = len(files)
        results = []
        for idx, f in enumerate(files):
            if _cancel_event.is_set():
                break
            r = upscale_one(f, output_dir, scale, denoise, model,
                            style=style, tta=tta)
            results.append(r)
            self._send_event("progress", {"done": idx + 1, "total": total})

        ok_count = sum(1 for r in results if r.get("ok"))
        self._send_event("done", {
            "success": True,
            "processed": ok_count,
            "failed": len(results) - ok_count,
            "results": results,
        })

    # ---- 超分辨率: 单张预览 ----
    def _preview_upscale(self):
        body = self._read_body()
        fpath = body.get("file", "")
        scale = body.get("scale", 2)
        denoise = body.get("denoise", "denoise3x")
        model = body.get("model", "real-cugan")
        style = body.get("style", "art")
        tta = body.get("tta", False)

        if not fpath:
            return self._json({"ok": False, "error": "no file"}, 400)

        result = preview_upscale(fpath, scale, denoise, model,
                                 style=style, tta=tta)
        self._json(result)

    # ---- 超分辨率: 模型列表 ----
    def _upscale_models(self):
        models = upscale_models()
        self._json({"success": True, "models": models})

    # ---- AI Caption: 单张 ----
    def _caption_single(self):
        body = self._read_body()
        file_path = body.get("file", "")
        model = body.get("model", "")
        api_key = body.get("api_key", "")
        system_prompt = body.get("system_prompt", "")
        user_prompt = body.get("user_prompt", "Please describe this image.")
        temperature = body.get("temperature", 0)
        top_p = body.get("top_p", 0)
        max_tokens = body.get("max_tokens", 1024)
        base_url = body.get("base_url", "")
        disable_think = body.get("disable_think", False)
        image_size = body.get("image_size", 1024)

        if not file_path:
            return self._json({"success": False, "error": "no file"}, 400)
        if not api_key:
            return self._json({"success": False, "error": "no api_key"}, 400)

        result = caption_one(file_path, model, api_key,
                             system_prompt, user_prompt,
                             temperature, top_p, max_tokens, base_url,
                             disable_think=disable_think,
                             image_size=image_size)
        self._json({"success": result.get("ok", False),
                     "caption": result.get("caption", ""),
                     "error": result.get("error", "")})

    # ---- AI Caption: 批量 ----
    def _caption_batch(self):
        body = self._read_body()
        files = body.get("files", [])
        model = body.get("model", "")
        api_key = body.get("api_key", "")
        system_prompt = body.get("system_prompt", "")
        user_prompt = body.get("user_prompt", "Please describe this image.")
        temperature = body.get("temperature", 0)
        top_p = body.get("top_p", 0)
        max_tokens = body.get("max_tokens", 1024)
        base_url = body.get("base_url", "")
        disable_think = body.get("disable_think", False)
        concurrency = body.get("concurrency", 4)
        image_size = body.get("image_size", 1024)

        if not files:
            return self._json({"success": False, "error": "no files"}, 400)
        if not api_key:
            return self._json({"success": False, "error": "no api_key"}, 400)

        self._begin_sse()

        def on_progress(done_count, total_count, file_path, r):
            self._send_event("progress", {
                "done": done_count,
                "total": total_count,
                "file": file_path,
                "caption": r.get("caption", ""),
                "ok": r.get("ok", False),
            })

        clear_cancelled()
        results = caption_batch_api(
            files, model, api_key, system_prompt, user_prompt,
            temperature, top_p, max_tokens, base_url,
            disable_think=disable_think,
            concurrency=concurrency, cancel_event=_cancel_event,
            progress_cb=on_progress,
            image_size=image_size,
        )

        ok_count = sum(1 for r in results if r.get("ok"))
        self._send_event("done", {
            "success": True,
            "processed": ok_count,
            "failed": len(results) - ok_count,
            "results": results,
        })

    # ---- AI Caption: 多API配置批量 ----
    def _caption_batch_multi_api(self):
        body = self._read_body()
        files = body.get("files", [])
        api_configs = body.get("api_configs", [])
        system_prompt = body.get("system_prompt", "")
        user_prompt = body.get("user_prompt", "Please describe this image.")
        temperature = body.get("temperature", 0)
        top_p = body.get("top_p", 0)
        max_tokens = body.get("max_tokens", 1024)
        disable_think = body.get("disable_think", False)
        concurrency = body.get("concurrency", 4)
        image_size = body.get("image_size", 1024)

        if not files:
            return self._json({"success": False, "error": "no files"}, 400)
        if not api_configs:
            return self._json({"success": False, "error": "no api_configs"}, 400)

        self._begin_sse()

        def on_progress(done_count, total_count, file_path, r):
            self._send_event("progress", {
                "done": done_count,
                "total": total_count,
                "file": file_path,
                "caption": r.get("caption", ""),
                "ok": r.get("ok", False),
            })

        clear_cancelled()
        results = caption_batch_multi_api(
            files, api_configs, system_prompt, user_prompt,
            temperature, top_p, max_tokens,
            disable_think=disable_think,
            concurrency=concurrency, cancel_event=_cancel_event,
            progress_cb=on_progress,
            image_size=image_size,
        )

        ok_count = sum(1 for r in results if r.get("ok"))
        self._send_event("done", {
            "success": True,
            "processed": ok_count,
            "failed": len(results) - ok_count,
            "results": results,
        })

    # ---- 本地模型: 加载 ----
    def _local_model_load(self):
        body = self._read_body()
        model_path = body.get("model_path", "")
        quantization = body.get("quantization", "none")
        use_sdpa = body.get("use_sdpa", False)
        use_cpu = body.get("use_cpu", False)
        image_size = body.get("image_size", 1024)
        model_type = body.get("model_type", "auto")

        if not model_path:
            return self._json({"success": False, "error": "no model_path"}, 400)

        result = local_load_model(model_path, quantization, use_sdpa,
                                  use_cpu, image_size, model_type)
        self._json({"success": result.get("ok", False),
                     "message": result.get("message", ""),
                     "error": result.get("error", ""),
                     "info": result.get("info", {})})

    # ---- 本地模型: 卸载 ----
    def _local_model_unload(self):
        result = local_unload_model()
        self._json({"success": result.get("ok", False),
                     "message": result.get("message", "")})

    # ---- 本地模型: 状态查询 ----
    def _local_model_status(self):
        result = local_model_status()
        self._json({"success": True, **result})

    # ---- 本地模型: 单张推理 ----
    def _local_caption_single(self):
        body = self._read_body()
        file_path = body.get("file", "")
        system_prompt = body.get("system_prompt", "")
        user_prompt = body.get("user_prompt", "Please describe this image.")
        temperature = body.get("temperature", 0)
        top_p = body.get("top_p", 0)
        max_tokens = body.get("max_tokens", 1024)
        image_size = body.get("image_size", 1024)
        disable_think = body.get("disable_think", False)

        if not file_path:
            return self._json({"success": False, "error": "no file"}, 400)

        result = local_caption_one(file_path, system_prompt, user_prompt,
                                   temperature, top_p, max_tokens,
                                   image_size, disable_think)
        self._json({"success": result.get("ok", False),
                     "caption": result.get("caption", ""),
                     "error": result.get("error", "")})

    # ---- 本地模型: 批量推理 ----
    def _local_caption_batch(self):
        body = self._read_body()
        files = body.get("files", [])
        system_prompt = body.get("system_prompt", "")
        user_prompt = body.get("user_prompt", "Please describe this image.")
        temperature = body.get("temperature", 0)
        top_p = body.get("top_p", 0)
        max_tokens = body.get("max_tokens", 1024)
        image_size = body.get("image_size", 1024)
        disable_think = body.get("disable_think", False)

        if not files:
            return self._json({"success": False, "error": "no files"}, 400)

        self._begin_sse()

        def on_progress(done_count, total_count, file_path, r):
            self._send_event("progress", {
                "done": done_count,
                "total": total_count,
                "file": file_path,
                "caption": r.get("caption", ""),
                "ok": r.get("ok", False),
            })

        clear_cancelled()
        results = local_caption_batch(
            files, system_prompt, user_prompt,
            temperature, top_p, max_tokens,
            image_size, disable_think,
            cancel_event=_cancel_event,
            progress_cb=on_progress,
        )

        ok_count = sum(1 for r in results if r.get("ok"))
        self._send_event("done", {
            "success": True,
            "processed": ok_count,
            "failed": len(results) - ok_count,
            "results": results,
        })

    # ---- GPU 配置 ----
    def _gpu_status(self):
        self._json(get_gpu_status())

    def _set_gpu_config(self):
        body = self._read_body()
        enabled = body.get("enabled", True)
        set_gpu_enabled(enabled)
        # 设置变更后清理所有缓存的模型（需要在新设备上重建）
        import gc
        for name, fn in [
            ("resize", resize_cleanup),
            ("split", split_cleanup),
            ("tagger", tagger_cleanup),
            ("cluster", cluster_cleanup),
            ("upscale", upscale_cleanup),
        ]:
            try:
                fn()
            except Exception:
                pass
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        # 重建进程池，让 worker 进程也刷新设备
        shutdown_pool()
        self._json({"success": True, **get_gpu_status()})

    # ---- 图片抓取: 站点适配下载 ----
    def _grab_download(self):
        body = self._read_body()
        self._begin_sse()

        try:
            clear_cancelled()
            result = run_grab_download(
                body,
                progress_cb=lambda data: self._send_event("progress", data),
                cancel_event=_cancel_event,
            )
            self._send_event("done", result)
        except Exception as exc:
            self._send_event("done", {"success": False, "error": self._log_exception(exc, "grab download failed")})
        finally:
            clear_cancelled()

    # ---- 取消当前任务 ----
    def _cancel(self):
        _cancel_event.set()
        self._json({"success": True})

    # ---- 清理模型缓存 ----
    def _cleanup_caches(self):
        """释放所有模块的模型缓存，回收内存"""
        import gc
        errors = []
        for name, fn in [
            ("resize", resize_cleanup),
            ("split", split_cleanup),
            ("tagger", tagger_cleanup),
            ("cluster", cluster_cleanup),
            ("upscale", upscale_cleanup),
            ("caption_local", cleanup_local_model),
        ]:
            try:
                fn()
            except Exception as e:
                errors.append(f"{name}: {e}")

        # 必须先执行 gc.collect() 强制回收失联的 Tensor 对象指针
        gc.collect()

        # 尝试深度清理 PyTorch 显存
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except ImportError:
            pass
        except Exception as e:
            errors.append(f"torch_cleanup: {e}")
        # 同时重建进程池，释放 worker 进程中缓存的模型内存
        shutdown_pool()
        self._json({"success": True, "errors": errors})

def main():
    port = find_free_port()
    server = ThreadedHTTPServer(("127.0.0.1", port), Handler)
    print(f"PORT:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        shutdown_pool()


if __name__ == "__main__":
    main()
