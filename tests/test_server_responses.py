"""HTTP/SSE request boundary regression tests, without loading model runtimes."""
import ast
import http.client
import importlib.util
import json
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND = Path(__file__).resolve().parents[1] / 'python_backend'
sys.path.insert(0, str(BACKEND))
from tasks.parallel import CancelledError

# Stub only task imports; exercise the real server and socket response format.
source = BACKEND / 'server.py'
stubs = {}
for node in ast.parse(source.read_text(encoding='utf-8')).body:
    if isinstance(node, ast.ImportFrom) and node.module.startswith('tasks.'):
        module = stubs.setdefault(node.module, types.ModuleType(node.module))
        for item in node.names:
            setattr(module, item.name, CancelledError if item.name == 'CancelledError' else Mock())
spec = importlib.util.spec_from_file_location('tested_backend_server', source)
backend = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, stubs):
    spec.loader.exec_module(backend)
backend.BACKEND_TOKEN = ''


class ResponseBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.log = patch.object(backend.logging, 'exception')
        self.log.start()
        self.addCleanup(self.log.stop)

    def request(self, action, path='/mirror-flip', body=None):
        class Handler(backend.Handler):
            def _mirror_flip(self):
                self._read_body()
                action(self)
        server = backend.ThreadedHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
        thread.start()
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
        try:
            connection.request('POST', path, json.dumps(body or {}), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.getheader('Content-Type'), response.read().decode()
        finally:
            connection.close()
            server.shutdown()
            thread.join()
            server.server_close()

    def test_error_before_stream_returns_json(self):
        def fail(_handler):
            raise ValueError('broken input')
        status, content_type, body = self.request(fail)
        self.assertEqual(status, 500)
        self.assertEqual(content_type, 'application/json')
        self.assertEqual(json.loads(body), {'success': False, 'error': 'broken input'})
        self.assertFalse(backend._cancel_events)

    def test_error_after_progress_returns_one_sse_done_without_http_headers(self):
        def fail(handler):
            handler._begin_sse()
            handler._send_event('progress', {'done': 1, 'total': 2})
            raise RuntimeError('worker failed')
        status, content_type, body = self.request(fail)
        self.assertEqual(status, 200)
        self.assertEqual(content_type, 'text/event-stream')
        self.assertNotIn('HTTP/', body)
        self.assertEqual(body.count('event: done'), 1)
        blocks = body.strip().split('\n\n')
        self.assertEqual(json.loads(blocks[-1].split('data: ')[1]), {'success': False, 'error': 'worker failed'})
        self.assertFalse(backend._cancel_events)

    def test_cancelled_task_keeps_the_sse_contract(self):
        def cancel(handler):
            handler._begin_sse()
            raise CancelledError()
        _, _, body = self.request(cancel)
        self.assertIn('"error": "task cancelled"', body)
        self.assertFalse(backend._cancel_events)

    def test_upstream_connection_refusal_is_reported_as_a_task_error(self):
        def fail(handler):
            handler._begin_sse()
            raise ConnectionRefusedError('upstream unavailable')
        _, _, body = self.request(fail)
        self.assertIn('upstream unavailable', body)

    def test_client_disconnect_cancels_and_unregisters_the_task(self):
        events = []
        def disconnected(handler):
            handler._begin_sse()
            events.append(handler.cancel_event)
            raise BrokenPipeError()
        _, _, body = self.request(disconnected)
        self.assertEqual(body, '')
        self.assertTrue(events[0].is_set())
        self.assertFalse(backend._cancel_events)

    def test_parallel_endpoint_failure_reaches_the_shared_boundary(self):
        with patch.object(backend, 'run_parallel', side_effect=RuntimeError('pool unavailable')):
            _, content_type, body = self.request(lambda _: None, '/resolution-filter', {'files': ['a.png']})
        self.assertEqual(content_type, 'text/event-stream')
        self.assertIn('pool unavailable', body)
        self.assertEqual(body.count('event: done'), 1)

    def test_json_encoding_failure_does_not_start_a_partial_response(self):
        _, _, body = self.request(lambda handler: handler._json({'invalid': object()}))
        self.assertFalse(json.loads(body)['success'])
        self.assertNotIn('HTTP/', body)


if __name__ == '__main__':
    unittest.main()
