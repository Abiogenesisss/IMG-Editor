"""通用并行调度工具（从 server.py 提取，避免循环导入）"""

import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool


_pool = None


class CancelledError(Exception):
    pass


def get_pool():
    global _pool
    if _pool is None or _pool._broken:
        if _pool is not None:
            try:
                _pool.shutdown(wait=False)
            except Exception:
                pass
        workers = min(os.cpu_count() or 4, 8)
        _pool = ProcessPoolExecutor(max_workers=workers)
    return _pool


def shutdown_pool():
    """关闭进程池并释放资源（供外部调用，如清理缓存、切换 GPU 时）"""
    global _pool
    if _pool is not None:
        try:
            _pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        _pool = None


def _pool_broken_reset():
    """进程池崩溃后强制重建"""
    global _pool
    try:
        if _pool is not None:
            _pool.shutdown(wait=False)
    except Exception:
        pass
    _pool = None


def run_parallel(fn, args_list, progress_cb=None, cancel_event=None):
    """通用并行调度：fn(*args) 逐项提交到进程池，返回结果列表（保持原顺序）
    progress_cb(done, total) 每完成一项时回调
    进程池崩溃时自动重建并重试一次"""
    total = len(args_list)
    results = [None] * total
    for attempt in range(2):
        try:
            pool = get_pool()
            futures = {pool.submit(fn, *args): i for i, args in enumerate(args_list)}
            done = 0
            for fut in as_completed(futures):
                if cancel_event is not None and cancel_event.is_set():
                    for pending_fut in futures:
                        if not pending_fut.done():
                            pending_fut.cancel()
                    raise CancelledError("task cancelled")
                idx = futures[fut]
                try:
                    results[idx] = fut.result()
                except Exception as e:
                    results[idx] = {"file": args_list[idx][0] if args_list[idx] else "?",
                                    "ok": False, "error": str(e)}
                done += 1
                if progress_cb:
                    progress_cb(done, total)
            return results
        except BrokenProcessPool:
            _pool_broken_reset()
            if attempt == 1:
                raise

    return results
