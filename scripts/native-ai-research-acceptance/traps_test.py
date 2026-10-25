"""Focused finalization/inspection negatives; never launches an agent CLI."""
import ast
import json
import http.server
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import urllib.request

SCRIPTS = Path(__file__).resolve().parent
BASE = Path(sys.argv.pop(1)).resolve()
OUTPUT = Path(sys.argv.pop(1)).resolve()
OUTPUT.mkdir(parents=True, exist_ok=True)


class TrapTest(unittest.TestCase):
    def test_finally_joins_actual_request_handler(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as tmp:
            out = Path(tmp)
            entered, release = threading.Event(), threading.Event()
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_): pass
                def do_GET(self):
                    entered.set()
                    if not release.wait(5): return
                    (out / 'external-agent-calls.log').write_text('late-owned-handler-record\n')
                    self.send_response(200); self.end_headers()
            servers = [http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) for _ in range(2)]
            workers = []
            for server in servers:
                server.daemon_threads = False
                worker = threading.Thread(target=server.serve_forever)
                worker.start(); workers.append(worker)
            def client():
                with urllib.request.urlopen('http://127.0.0.1:' + str(servers[0].server_port), timeout=5) as response:
                    response.read()
            request = threading.Thread(target=client)
            request.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertFalse((out / 'external-agent-calls.log').exists())
                result = {'externalAgentCalls': 0}
                final = next(x.finalbody for x in reversed(ast.parse((SCRIPTS / 'acceptance.py').read_text()).body) if isinstance(x, ast.Try))
                env = {'OUT': out, 'RESULT': result, 'STATE': {'errors': [], 'modelCalls': 0, 'searchCalls': {}, 'requests': []},
                       'RELEASE': release, 'stop': lambda: None, 'model': servers[0], 'proxy': servers[1], 'workers': workers, 'save': lambda: None}
                exec(compile(ast.Module(body=final, type_ignores=[]), str(SCRIPTS / 'acceptance.py'), 'exec'), env)
                self.assertEqual(result['externalAgentCalls'], 1)
                self.assertFalse(any(worker.is_alive() for worker in workers))
            finally:
                release.set()
                for server in servers: server.shutdown(); server.server_close()
                for worker in workers: worker.join()
                request.join()

    def test_finally_counts_late_record_after_workers_join(self):
        # Execute the actual finally block without replaying the full scenario.
        tree = ast.parse((SCRIPTS / 'acceptance.py').read_text())
        final = next(x.finalbody for x in reversed(tree.body) if isinstance(x, ast.Try))
        with tempfile.TemporaryDirectory(dir=OUTPUT) as tmp:
            out = Path(tmp)
            result = {'externalAgentCalls': 0}  # early checkpoint
            events = []
            def stop():
                events.append('process stopped')
            def join():
                events.append('joined')
                (out / 'external-agent-calls.log').write_text('late-owned-fixture-record\n')
            worker = types.SimpleNamespace(shutdown=lambda: events.append('shutdown'), server_close=lambda: events.append('closed'))
            env = {'OUT': out, 'RESULT': result, 'STATE': {'errors': [], 'modelCalls': 1, 'searchCalls': {}, 'requests': []},
                   'RELEASE': types.SimpleNamespace(set=lambda: None), 'stop': stop, 'model': worker, 'proxy': worker,
                   'workers': [types.SimpleNamespace(join=join)], 'save': lambda: events.append('saved')}
            exec(compile(ast.Module(body=final, type_ignores=[]), str(SCRIPTS / 'acceptance.py'), 'exec'), env)
            self.assertEqual(result['externalAgentCalls'], 1, 'late trap record was frozen at the early zero')
            self.assertEqual(events[-1], 'saved')
            self.assertIn('closed', events)
            self.assertIn('joined', events)

    def test_inspector_rejects_late_record_with_stale_zero(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as tmp:
            out = Path(tmp)
            for name in ['result.json', 'research-report.md', 'research-report.pdf', 'novelty-report.md']:
                shutil.copyfile(BASE / name, out / name)
            (out / 'count-join').mkdir()
            shutil.copyfile(BASE / 'count-join/result.json', out / 'count-join/result.json')
            self.assertEqual(json.loads((out / 'result.json').read_text())['externalAgentCalls'], 0)
            (out / 'external-agent-calls.log').write_text('late-owned-fixture-record\n')
            result = subprocess.run(['node', str(SCRIPTS / 'inspect.mjs'), str(out)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, 'inspector accepted stale zero despite actual trap record')
            self.assertIn('trap count', result.stderr)


if __name__ == '__main__':
    unittest.main()
