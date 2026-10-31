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
        shutdown_pool()
        workers = min(os.cpu_count() or 4, 8)
        _pool = ProcessPoolExecutor(max_workers=workers)
    return _pool


def shutdown_pool():
    """关闭进程池并释放资源（供外部调用，如清理缓存、切换 GPU 时）"""
    global _pool
    pool = _pool
    _pool = None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)


def run_parallel(fn, args_list, progress_cb=None, cancel_event=None):
    """通用并行调度：fn(*args) 逐项提交到进程池，返回结果列表（保持原顺序）
    progress_cb(done, total) 每完成一项时回调
    进程池崩溃时释放资源并报错；文件操作可能已完成，不能自动重放整批任务。"""
    total = len(args_list)
    results = [None] * total
    try:
        pool = get_pool()
        futures = {pool.submit(fn, *args): i for i, args in enumerate(args_list)}
        for done, fut in enumerate(as_completed(futures), 1):
            if cancel_event is not None and cancel_event.is_set():
                for pending_fut in futures:
                    pending_fut.cancel()
                raise CancelledError("task cancelled")
            idx = futures[fut]
            try:
                results[idx] = fut.result()
            except BrokenProcessPool:
                raise
            except Exception as e:
                results[idx] = {"file": args_list[idx][0] if args_list[idx] else "?",
                                "ok": False, "error": str(e)}
            if progress_cb:
                progress_cb(done, total)
    except BrokenProcessPool:
        shutdown_pool()
        raise
    return results
