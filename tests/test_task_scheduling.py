import sys
import threading
import unittest
from contextlib import contextmanager
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python_backend'))
from tasks import caption, parallel


class ParallelTests(unittest.TestCase):
    def tearDown(self):
        parallel._pool = None

    def test_preserves_order_and_reports_individual_failure(self):
        futures = [Future(), Future()]
        futures[0].set_result({'ok': True, 'file': 'a'})
        futures[1].set_exception(ValueError('bad image'))
        pool = Mock()
        pool.submit.side_effect = futures
        progress = Mock()
        with patch.object(parallel, 'get_pool', return_value=pool), patch.object(
            parallel, 'as_completed', return_value=reversed(futures)
        ):
            results = parallel.run_parallel(Mock(), [('a',), ('b',)], progress)
        self.assertEqual(results, [
            {'ok': True, 'file': 'a'},
            {'ok': False, 'file': 'b', 'error': 'bad image'},
        ])
        self.assertEqual(progress.call_args_list[-1].args, (2, 2))

    def test_broken_pool_does_not_replay_file_operations(self):
        for failure_stage in ['submit', 'result']:
            with self.subTest(failure_stage=failure_stage):
                pool = Mock()
                pool._broken = False
                parallel._pool = pool
                if failure_stage == 'submit':
                    pool.submit.side_effect = BrokenProcessPool('worker died')
                else:
                    future = Future()
                    future.set_exception(BrokenProcessPool('worker died'))
                    pool.submit.return_value = future
                with self.assertRaises(BrokenProcessPool):
                    parallel.run_parallel(Mock(), [('a',)])
                self.assertEqual(pool.submit.call_count, 1)
                pool.shutdown.assert_called_once_with(wait=False, cancel_futures=True)
                self.assertIsNone(parallel._pool)

    def test_cancel_stops_pending_work(self):
        completed, pending = Future(), Future()
        completed.set_result({'ok': True})
        pool = Mock()
        pool.submit.side_effect = [completed, pending]
        cancel = threading.Event()
        cancel.set()
        with patch.object(parallel, 'get_pool', return_value=pool), self.assertRaises(
            parallel.CancelledError
        ):
            parallel.run_parallel(Mock(), [('a',), ('b',)], cancel_event=cancel)
        self.assertTrue(pending.cancelled())

    def test_next_request_replaces_a_broken_pool(self):
        old_pool = Mock()
        old_pool._broken = True
        parallel._pool = old_pool
        with patch.object(parallel, 'ProcessPoolExecutor') as executor:
            self.assertIs(parallel.get_pool(), executor.return_value)
        old_pool.shutdown.assert_called_once_with(wait=False, cancel_futures=True)


class CaptionTests(unittest.TestCase):
    def test_local_batch_isolates_failures_and_closes_images_before_inference(self):
        closed = []

        @contextmanager
        def open_image(path):
            try:
                yield path
            finally:
                closed.append(path)

        def preprocess(image, _size):
            if image == 'bad':
                raise ValueError('bad image')
            return image

        def generate(images, *_args):
            self.assertIn(images[0], closed)
            if images[0] == 'infer-fail':
                raise RuntimeError('model failed')
            return ['caption']

        progress = Mock()
        with patch.object(caption.Image, 'open', side_effect=open_image), patch.object(
            caption, '_image_preprocess', side_effect=preprocess
        ), patch.object(caption, '_generate_local_captions', side_effect=generate):
            results = caption.local_caption_batch(
                ['good', 'bad', 'infer-fail'], '', '', progress_cb=progress
            )
        self.assertEqual([r['ok'] for r in results], [True, False, False])
        self.assertEqual(results[1]['error'], 'bad image')
        self.assertEqual(results[2]['error'], 'model failed')
        self.assertEqual(closed, ['good', 'bad', 'infer-fail'])
        self.assertEqual([call.args[0] for call in progress.call_args_list], [1, 2, 3])

    def test_local_batch_cancellation_keeps_completed_results(self):
        cancel = threading.Event()
        with patch.object(caption, 'local_caption_one', return_value={'ok': True, 'caption': 'done'}) as one:
            results = caption.local_caption_batch(
                ['a', 'b'], '', '', cancel_event=cancel,
                progress_cb=lambda *_args: cancel.set(),
            )
        one.assert_called_once()
        self.assertTrue(results[0]['ok'])
        self.assertEqual(results[1], {'file': 'b', 'ok': False, 'error': 'cancelled'})

    def test_progress_is_serial_and_results_keep_input_order(self):
        def describe(_client, file_path, *_args, **_kwargs):
            if file_path == 'bad':
                raise ValueError('bad image')
            return {'ok': True, 'caption': file_path}

        for multi in [False, True]:
            with self.subTest(multi=multi):
                progress = []
                caller = threading.get_ident()
                files = ['a', 'bad', 'c', 'd']
                with patch.object(caption, '_get_client', return_value=object()), patch.dict(
                    caption._DISPATCH, {'openai': describe}
                ):
                    kwargs = {'concurrency': 3, 'progress_cb': lambda *args: progress.append(
                        (threading.get_ident(), args[0])
                    )}
                    if multi:
                        results = caption.caption_batch_multi_api(
                            files, [{'model': 'gpt-test', 'apiKey': 'test'}], '', '', **kwargs
                        )
                    else:
                        results = caption.caption_batch_api(
                            files, 'gpt-test', 'test', '', '', **kwargs
                        )
                self.assertEqual([r['file'] for r in results], files)
                self.assertEqual([r['ok'] for r in results], [True, False, True, True])
                self.assertEqual(progress, [(caller, n) for n in range(1, 5)])


if __name__ == '__main__':
    unittest.main()
