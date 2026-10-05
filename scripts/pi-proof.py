#!/usr/bin/env python3
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description='Release gate: real installed pi 1.0.0 against a synthetic server; no inference')
parser.add_argument('--pi-root', required=True, type=Path)
parser.add_argument('--node', default='/usr/bin/node')
parser.add_argument('--tests', default='artifacts/tests/tokate-tests')
args = parser.parse_args()
package = args.pi_root / '@earendil-works/pi-coding-agent/package.json'
if not package.is_file():
    parser.error('Real pi installation is required; this probe never installs packages')
metadata = json.loads(package.read_text())
if metadata.get('name') != '@earendil-works/pi-coding-agent' or metadata.get('version') != '1.0.0':
    parser.error('The real pi 1.0.0 package is required')
subprocess.run([args.tests, '--pi-real', str(args.pi_root.resolve()), args.node], check=True, timeout=45)

class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_GET(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls += 1
        assert self.path == '/v1/chat/completions'
        assert body['model'] == 'synthetic/model:exact'
        assert 'reasoning_effort' not in body
        assert sorted(t['function']['name'] for t in body['tools']) == ['bash', 'edit', 'read', 'write']
        text = json.dumps(body)
        assert 'PRIVATE_CREDENTIAL_SENTINEL' not in text
        assert 'HOSTILE_CONTEXT_SENTINEL' not in text
        assert 'HOSTILE_EXTENSION_LOADED' not in text
        if self.server.case == 'failed':
            self.send_response(503)
            self.end_headers()
            return
        if self.server.case == 'malformed':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(b'data: {broken}\n\n')
            self.close_connection = True
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        turn = sum(m['role'] == 'assistant' for m in body['messages'])
        planned = self.server.planned
        if self.server.case == 'incomplete':
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Incomplete'}, 'finish_reason': 'length'}]}
        elif self.server.case == 'empty':
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': 'stop'}]}
        elif turn < len(planned):
            name, parameters = planned[turn]
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'call_{turn}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(parameters)}}]}, 'finish_reason': 'tool_calls'}]}
        else:
            for message in body['messages']:
                if message['role'] == 'tool' and 'BOUNDARY_FAILURE' in str(message.get('content', '')):
                    raise AssertionError('Execution boundary failed')
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Changes: synthetic edits. Verification: constrained tools. Limitations: no inference.'}, 'finish_reason': 'stop'}]}
        chunk.update(id=f'completion-{turn}', object='chat.completion.chunk', created=1, model='synthetic/model:exact', usage={'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15})
        self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
        self.close_connection = True

with Server(('127.0.0.1', 0), Handler) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    for case in ['off', 'on', 'failed', 'malformed', 'incomplete', 'empty', 'cancel']:
        with tempfile.TemporaryDirectory(prefix='tokate-pi-proof-', dir='/tmp') as directory:
            root = Path(directory)
            server.calls = 0
            server.case = case
            server.pending = threading.Event()
            private = root / 'private-credential'
            outside = root / 'denied-write'
            code = f"from pathlib import Path; import socket; p=Path({str(private)!r}); assert not p.exists(); assert not Path('.git/config').exists(); assert not Path('/tokate-control/models.json').exists(); denied=False\ntry: Path({str(outside)!r}).write_text('escaped')\nexcept OSError: denied=True\nassert denied\ns=socket.socket(); s.settimeout(1); connected=False\ntry: s.connect(('127.0.0.1',{port})); connected=True\nexcept OSError: pass\nassert connected == {case == 'on'}\nPath('result.txt').write_text('final')"
            import shlex
            shell = 'python3 -c ' + shlex.quote(code) + ' || echo BOUNDARY_FAILURE'
            server.planned = [('write', {'path': 'result.txt', 'content': 'before'}), ('read', {'path': 'result.txt'}), ('edit', {'path': 'result.txt', 'oldText': 'before', 'newText': 'after'}),
                              ('read', {'path': str(private)}), ('write', {'path': str(outside), 'content': 'escaped'}), ('read', {'path': '.git/config'}),
                              ('read', {'path': '/tokate-control/models.json'}), ('bash', {'command': shell, 'timeout': 4}),
                              ('bash', {'command': "setsid sh -c 'sleep 2; touch timeout-escaped' & wait", 'timeout': 0.2})]
            if case == 'cancel':
                server.planned = [('bash', {'command': "touch running; setsid sh -c 'sleep 2; touch cancel-escaped' & wait"})]
            command = [args.tests, '--pi-bridge', str(args.pi_root.resolve()), args.node, directory, f'http://127.0.0.1:{port}/v1', str(case == 'on').lower()]
            if case == 'cancel':
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                deadline = time.monotonic() + 5
                while not (root / 'checkout/running').exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                assert (root / 'checkout/running').exists(), 'Pi never launched constrained bash'
                os.killpg(process.pid, signal.SIGINT)
                process.communicate(timeout=5)
                assert process.returncode != 0
            else:
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                expected = case in ['off', 'on']
                assert (result.returncode == 0) == expected, f'{case}: {result.stderr}'
                if expected:
                    assert (root / 'checkout/result.txt').read_text() == 'final'
                else:
                    assert server.calls == 1, f'{case}: automatic provider retry observed'
            time.sleep(3)
            assert not (root / 'checkout/timeout-escaped').exists(), 'Timeout descendant survived'
            assert not (root / 'checkout/cancel-escaped').exists(), 'Cancelled descendant survived'
            assert not outside.exists(), 'Outside write escaped'
            assert private.read_text() == 'PRIVATE_CREDENTIAL_SENTINEL'
            assert (root / 'checkout/.git/config').read_text() == 'synthetic-private'
            print('PASS real pi synthetic ' + case)
    server.shutdown()
