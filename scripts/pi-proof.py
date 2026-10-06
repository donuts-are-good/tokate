#!/usr/bin/env python3
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import shlex
import shutil
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description='Release gate: real installed pi 1.0.0 against a synthetic server; no inference')
parser.add_argument('--pi-root', required=True, type=Path)
parser.add_argument('--node', default='/usr/bin/node')
parser.add_argument('--tests', default='artifacts/tests/tokate-tests')
parser.add_argument('--binary', default='artifacts/linux-x64/tokate')
args = parser.parse_args()
package = args.pi_root / '@earendil-works/pi-coding-agent/package.json'
if not package.is_file():
    parser.error('Real pi installation is required; this probe never installs packages')
metadata = json.loads(package.read_text())
if metadata.get('name') != '@earendil-works/pi-coding-agent' or metadata.get('version') != '1.0.0':
    parser.error('The real pi 1.0.0 package is required')

class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def race_paths(self, checkout):
        leaf, temporary = checkout / 'race-leaf', checkout / 'race-next'
        directory, saved = checkout / 'race-dir', checkout / 'race-saved'
        saved.mkdir()
        (saved / 'models.json').write_text('synthetic-safe-file')
        try:
            while not self.stop_race.is_set():
                temporary.symlink_to('/tokate-control/models.json')
                temporary.replace(leaf)
                temporary.write_text('synthetic-safe-file')
                temporary.replace(leaf)
                saved.rename(directory)
                time.sleep(0.001)
                directory.rename(saved)
                directory.symlink_to('/tokate-control', target_is_directory=True)
                time.sleep(0.001)
                directory.unlink()
                self.race_cycles += 1
        except Exception as error:
            self.race_error = str(error)
        finally:
            for path in [leaf, temporary, directory, saved]:
                if path.is_symlink() or path.is_file():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path)

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
        for message in body['messages']:
            if message['role'] == 'tool':
                assert 'tokate-no-auth' not in str(message.get('content', '')), 'File tool exposed private model settings'
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
        fixture = json.loads((self.server.root / 'fixture.json').read_text())
        if self.server.case == 'off' and self.server.calls == 1:
            self.server.racer = threading.Thread(target=self.server.race_paths, args=(Path(fixture['checkout']),))
            self.server.racer.start()
        private, outside = fixture['private'], fixture['outside']
        code = f"from pathlib import Path; import socket; assert not Path({private!r}).exists(); assert not Path('.git/config').exists(); assert not Path('/tokate-control/models.json').exists(); denied=False\ntry: Path({outside!r}).write_text('escaped')\nexcept OSError: denied=True\nassert denied\ns=socket.socket(); s.settimeout(1); connected=False\ntry: s.connect(('127.0.0.1',{self.server.server_address[1]})); connected=True\nexcept OSError: pass\nassert connected == {self.server.case == 'on'}\nPath('result.txt').write_text('final')"
        planned = [('write', {'path': 'result.txt', 'content': 'before'}), ('read', {'path': 'result.txt'}),
                   ('edit', {'path': 'result.txt', 'edits': [{'oldText': 'before', 'newText': 'after'}]}),
                   ('read', {'path': private}), ('write', {'path': outside, 'content': 'escaped'}),
                   ('read', {'path': '.git/config'}), ('read', {'path': '/tokate-control/models.json'}),
                   ('bash', {'command': 'python3 -c ' + shlex.quote(code) + ' || echo BOUNDARY_FAILURE', 'timeout': 4}),
                   ('bash', {'command': "setsid sh -c 'sleep 2; touch timeout-escaped' & wait", 'timeout': 0.2})]
        if self.server.case == 'cancel':
            planned = [('bash', {'command': "touch running; setsid sh -c 'sleep 2; touch cancel-escaped' & wait"})]
        elif self.server.case == 'off':
            planned += [('read', {'path': path}) for path in ['race-leaf', 'race-dir/models.json'] * 4]
            planned += [('write', {'path': 'race-leaf', 'content': 'synthetic-safe-update'})]
        if self.server.case == 'incomplete':
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Incomplete'}, 'finish_reason': 'length'}]}
        elif self.server.case == 'empty':
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': 'stop'}]}
        elif turn < len(planned):
            name, parameters = planned[turn]
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'call_{turn}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(parameters)}}]}, 'finish_reason': 'tool_calls'}]}
        else:
            self.server.stop_race.set()
            if self.server.racer:
                self.server.racer.join(timeout=5)
                assert not self.server.racer.is_alive(), 'Synthetic path racer did not stop'
                assert self.server.race_cycles > 0 and self.server.race_error is None, 'Synthetic path race failed'
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
        with tempfile.TemporaryDirectory(prefix='tokate-pi-proof-', dir='/var/tmp') as directory:
            root = Path(directory)
            server.root = root
            server.calls = 0
            server.case = case
            server.stop_race = threading.Event()
            server.racer = None
            server.race_cycles = 0
            server.race_error = None
            fixture_root = root / 'fixtures'
            fixture_root.mkdir()
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TOKATE_TEST_ROOT': str(fixture_root),
                   'TOKATE_BINARY': str(Path(args.binary).resolve())}
            command = [args.tests, '--pi-proof', str(args.pi_root.resolve()), args.node, directory, f'http://127.0.0.1:{port}/v1', case]
            if case == 'cancel':
                process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                deadline = time.monotonic() + 45
                fixture = None
                while time.monotonic() < deadline and process.poll() is None:
                    if (root / 'fixture.json').exists():
                        fixture = json.loads((root / 'fixture.json').read_text())
                        if (Path(fixture['checkout']) / 'running').exists():
                            break
                    time.sleep(0.1)
                assert fixture and (Path(fixture['checkout']) / 'running').exists(), 'Pi never launched constrained bash'
                checkout = Path(fixture['checkout'])
                git = (checkout / '.git/config').read_text()
                children = set()
                for task in Path(f'/proc/{process.pid}/task').iterdir():
                    children.update((task / 'children').read_text().split())
                targets = [int(pid) for pid in children if Path(f'/proc/{pid}/exe').resolve() == Path(args.binary).resolve()]
                assert len(targets) == 1, 'Expected one owned Tokate work process'
                descriptor = os.pidfd_open(targets[0])
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGINT)
                finally:
                    os.close(descriptor)
                process.communicate(timeout=15)
                time.sleep(3)
                assert checkout.is_dir(), 'Cancellation evidence disappeared'
                assert not (checkout / 'cancel-escaped').exists(), 'Cancelled descendant survived'
                assert not Path(fixture['outside']).exists(), 'Outside write escaped'
                assert Path(fixture['private']).read_text() == 'PRIVATE_CREDENTIAL_SENTINEL'
                assert (checkout / '.git/config').read_text() == git
                saved = json.loads((Path(fixture['run']) / 'run.json').read_text())
                assert saved['state'] == 'failed' and saved['failure_reason'] == 'inference_interrupted', {key: saved.get(key) for key in ['state', 'failure_stage', 'failure_reason', 'error']}
                assert 'turn_completed' not in saved
            else:
                try:
                    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=150)
                finally:
                    server.stop_race.set()
                    if server.racer:
                        server.racer.join(timeout=5)
                assert result.returncode == 0, f'{case}: {result.stdout}\n{result.stderr}'
                if case not in ['off', 'on']:
                    assert server.calls == 1, f'{case}: automatic provider retry observed'
            print('PASS native Pi workflow ' + case, flush=True)
    server.shutdown()
