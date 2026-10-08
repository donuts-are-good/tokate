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
import sys
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description='Real installed pi against a synthetic server; no inference')
parser.add_argument('--pi-root', required=True, type=Path)
parser.add_argument('--node', default='/usr/bin/node')
parser.add_argument('--tests', default='artifacts/tests/tokate-tests')
parser.add_argument('--binary', default='artifacts/linux-x64/tokate')
parser.add_argument('--catalog-only', action='store_true')
args = parser.parse_args()
package = args.pi_root / '@earendil-works/pi-coding-agent/package.json'
if not package.is_file():
    parser.error('Real pi installation is required; this probe never installs packages')
metadata = json.loads(package.read_text())
if metadata.get('name') != '@earendil-works/pi-coding-agent' or not metadata.get('version'):
    parser.error('The real pi SDK package is required')
node_version = subprocess.check_output([args.node, '--version'], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, text=True, timeout=10).strip()
print('Pi proof versions: ' + metadata['version'] + ', Node ' + node_version, flush=True)
length_cases = ['incomplete', 'continued', 'repeated', 'truncated-tool', 'identity', 'usage', 'length-cancel', 'length-timeout']
catalog_cases = ['catalog-missing', 'catalog-substituted', 'catalog-malformed', 'catalog-duplicate', 'catalog-duplicate-id',
                 'catalog-invalid-id', 'catalog-whitespace-id', 'catalog-invalid-metadata', 'catalog-oversized', 'catalog-chunked',
                 'catalog-redirect', 'catalog-unreachable', 'catalog-deadline', 'catalog-metadata',
                 'catalog-recheck-substituted', 'catalog-recheck-unreachable', 'catalog-recheck-malformed']
partial_text = 'PRIVATE_PARTIAL_LENGTH_SENTINEL ' + 'é' * 35000 + ' RETAINED_LENGTH_CONTEXT_SENTINEL'
continuation_instruction = 'Continue the existing approved work and return a complete concise final report.'
thinking_text = 'PRIVATE_THINKING_CONTENT_SENTINEL'

def message_text(message):
    content = message.get('content') or ''
    return content if isinstance(content, str) else ''.join(block.get('text', '') for block in content if block.get('type') == 'text')

class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        self.errors.append(str(sys.exc_info()[1]))

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
        if self.path != '/v1/models':
            assert self.path == '/', 'Metadata followed a redirect or scanned another path'
            self.send_response(204)
            self.end_headers()
            return
        self.server.catalog_calls += 1
        assert self.headers.get('Authorization') is None, 'Metadata sent authentication'
        case = self.server.case
        if case.startswith('catalog-recheck-'):
            case = case.replace('catalog-recheck-', 'catalog-') if self.server.catalog_calls == 2 else ''
        if case == 'catalog-unreachable':
            self.close_connection = True
            self.connection.close()
            return
        if case == 'catalog-redirect':
            self.send_response(302)
            self.send_header('Location', '/PRIVATE_CATALOG_SENTINEL')
            self.end_headers()
            return
        entry = {'id': 'synthetic/model:exact', 'private': 'PRIVATE_CATALOG_SENTINEL'}
        if case == 'catalog-substituted':
            entry['id'] = 'synthetic/model:other'
        if case == 'catalog-invalid-id':
            entry.pop('id')
        if case == 'catalog-whitespace-id':
            entry['id'] += '\n'
        if case == 'catalog-invalid-metadata':
            entry['digest'] = 'PRIVATE_CATALOG_SENTINEL\n'
        if case == 'catalog-metadata':
            entry.update(runtime_version='1.2.3', digest='sha256:abc123', quantization='Q4_K_M', context_window=7, supports_tools=False)
        body = json.dumps({'object': 'list', 'data': [] if case == 'catalog-missing' else [entry]}).encode()
        if case == 'catalog-malformed':
            body = b'{PRIVATE_CATALOG_SENTINEL'
        if case == 'catalog-duplicate':
            body = b'{"data":[{"id":"PRIVATE_CATALOG_SENTINEL","id":"synthetic/model:exact"}]}'
        if case == 'catalog-duplicate-id':
            body = json.dumps({'data': [entry, entry]}).encode()
        if case in ['catalog-oversized', 'catalog-chunked']:
            body = b' ' * (1024 * 1024 + 1)
        self.send_response(200)
        if case != 'catalog-chunked':
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if case == 'catalog-deadline':
            self.server.catalog_release.wait(15)
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls += 1
        assert self.path == '/v1/chat/completions'
        assert body['model'] == 'synthetic/model:exact'
        assert 'reasoning_effort' not in body
        compacting = not body.get('tools')
        if compacting:
            assert self.server.case in ['compact', 'compact-failed']
            self.server.compactions += 1
        else:
            assert sorted(t['function']['name'] for t in body['tools']) == ['bash', 'edit', 'read', 'write']
            assert body['max_tokens'] == 8192, 'Configured output limit was ignored'
        assert self.headers.get('Authorization') in [None, 'Bearer tokate-no-auth'], 'Configured credentials escaped'
        text = json.dumps(body)
        assert 'PRIVATE_CREDENTIAL_SENTINEL' not in text
        assert 'HOSTILE_CONTEXT_SENTINEL' not in text
        assert 'HOSTILE_EXTENSION_LOADED' not in text
        for message in body['messages']:
            if message['role'] == 'tool':
                assert 'tokate-no-auth' not in str(message.get('content', '')), 'File tool exposed private model settings'
        if self.server.case == 'failed' or (compacting and self.server.case == 'compact-failed'):
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
        if self.server.case in length_cases:
            if self.server.calls == 1:
                self.server.original_prompt = next(m['content'] for m in body['messages'] if m['role'] == 'user')
            else:
                assert sum(m['role'] == 'user' and m['content'] == self.server.original_prompt for m in body['messages']) == 1, 'Original task was replayed'
            prelude = self.server.case in ['continued', 'repeated'] and self.server.calls == 1
            completed = self.server.case == 'continued' and self.server.calls == 3
            if self.server.calls >= 3:
                assert any(m['role'] == 'assistant' and partial_text in message_text(m) for m in body['messages']), 'Continuation discarded the truncated assistant context'
                assert sum(m['role'] == 'user' and message_text(m) == continuation_instruction for m in body['messages']) == 1, 'Continuation instruction was missing or repeated'
            if prelude:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'write-before-length', 'type': 'function', 'function': {'name': 'write', 'arguments': json.dumps({'path': 'result.txt', 'content': 'final'})}}]}
                finish = 'tool_calls'
            elif completed:
                delta = {'role': 'assistant', 'content': 'Changes: synthetic edits. Verification: constrained tools. Limitations: no inference.'}
                finish = 'stop'
            else:
                delta = {'role': 'assistant', 'content': partial_text}
                finish = 'length'
                if self.server.case == 'incomplete':
                    delta['reasoning_content'] = thinking_text
                if self.server.case == 'truncated-tool' or (self.server.case == 'repeated' and self.server.calls == 2):
                    delta['tool_calls'] = [{'index': 0, 'id': 'truncated-write', 'type': 'function', 'function': {'name': 'write', 'arguments': json.dumps({'path': 'truncated-executed', 'content': 'unsafe'})}}]
            output_tokens = 5 if prelude or completed else 8192
            if self.server.case == 'usage':
                output_tokens = -1
            tokens = 10000
            self.server.input_tokens += tokens
            self.server.output_tokens += output_tokens
            chunk = {'id': f'completion-{self.server.calls}', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'synthetic/other' if self.server.case == 'identity' else 'synthetic/model:exact',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
                     'usage': {'prompt_tokens': tokens, 'completion_tokens': output_tokens, 'total_tokens': tokens + output_tokens}}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.flush()
            if self.server.case in ['length-cancel', 'length-timeout']:
                release = self.server.release_length
                finished = self.server.length_finished
                self.server.length_waiting.set()
                release.wait(30)
                finished.set()
            else:
                self.wfile.write(b'data: [DONE]\n\n')
            self.close_connection = True
            return
        if self.server.case == 'off' and self.server.calls == 1:
            self.server.racer = threading.Thread(target=self.server.race_paths, args=(Path(fixture['checkout']),))
            self.server.racer.start()
        private, outside = fixture['private'], fixture['outside']
        code = f"""from pathlib import Path
import socket
for path in [{private!r}, '.git/config', '/tokate-control/models.json']:
    try:
        Path(path).read_bytes()
    except (FileNotFoundError, PermissionError):
        pass
    else:
        raise AssertionError('Private file is readable')
"""
        code += f"denied=False\ntry: Path({outside!r}).write_text('escaped')\nexcept OSError: denied=True\nassert denied\ns=socket.socket(); s.settimeout(1); connected=False\ntry: s.connect(('127.0.0.1',{self.server.server_address[1]})); connected=True\nexcept OSError: pass\nassert connected == {self.server.case == 'on'}\nPath('result.txt').write_text('final')"
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
        if self.server.case in ['compact', 'compact-failed']:
            planned[0][1]['content'] = 'synthetic padding ' * 6000 + 'before'
        final = not compacting and turn >= len(planned)
        if compacting:
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Synthetic compacted task state.'}, 'finish_reason': 'stop'}]}
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
                    raise AssertionError('Execution boundary failed: ' + str(message.get('content', ''))[:2000])
            chunk = {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Changes: synthetic edits. Verification: constrained tools. Limitations: no inference.'}, 'finish_reason': 'stop'}]}
        tokens = 60000 if final and self.server.case in ['compact', 'compact-failed'] else 10
        self.server.input_tokens += tokens
        self.server.output_tokens += 5
        chunk.update(id=f'completion-{turn}', object='chat.completion.chunk', created=1, model='synthetic/model:exact', usage={'prompt_tokens': tokens, 'completion_tokens': 5, 'total_tokens': tokens + 5})
        self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
        self.close_connection = True

with Server(('127.0.0.1', 0), Handler) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    cases = catalog_cases if args.catalog_only else ['off', 'on', 'compact', 'compact-failed', 'failed', 'malformed', *length_cases, 'empty', 'cancel', *catalog_cases]
    for case in cases:
        with tempfile.TemporaryDirectory(prefix='tokate-pi-proof-', dir='/var/tmp') as directory:
            root = Path(directory)
            server.root = root
            server.calls = 0
            server.catalog_calls = 0
            server.catalog_release = threading.Event()
            server.compactions = 0
            server.input_tokens = 0
            server.output_tokens = 0
            server.case = case
            server.errors = []
            server.original_prompt = None
            server.length_waiting = threading.Event()
            server.release_length = threading.Event()
            server.length_finished = threading.Event()
            server.stop_race = threading.Event()
            server.racer = None
            server.race_cycles = 0
            server.race_error = None
            fixture_root = root / 'fixtures'
            fixture_root.mkdir()
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TOKATE_TEST_ROOT': str(fixture_root),
                   'TOKATE_BINARY': str(Path(args.binary).resolve())}
            command = [args.tests, '--pi-proof', str(args.pi_root.resolve()), args.node, directory, f'http://127.0.0.1:{port}/v1', case]
            if case in ['cancel', 'length-cancel']:
                process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                deadline = time.monotonic() + 45
                fixture = None
                ready = False
                while time.monotonic() < deadline and process.poll() is None:
                    if (root / 'fixture.json').exists():
                        fixture = json.loads((root / 'fixture.json').read_text())
                        ready = (Path(fixture['checkout']) / 'running').exists() if case == 'cancel' else server.length_waiting.is_set()
                        if ready:
                            break
                    time.sleep(0.1)
                assert fixture and ready, 'Pi never reached the cancellation boundary'
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
                try:
                    process.communicate(timeout=15)
                finally:
                    server.release_length.set()
                    if case == 'length-cancel':
                        assert server.length_finished.wait(5), 'Cancelled length response did not settle'
                time.sleep(3)
                assert checkout.is_dir(), 'Cancellation evidence disappeared'
                assert not (checkout / 'cancel-escaped').exists(), 'Cancelled descendant survived'
                assert not Path(fixture['outside']).exists(), 'Outside write escaped'
                assert Path(fixture['private']).read_text() == 'PRIVATE_CREDENTIAL_SENTINEL'
                assert (checkout / '.git/config').read_text() == git
                saved = json.loads((Path(fixture['run']) / 'run.json').read_text())
                assert saved['state'] == 'failed' and saved['failure_reason'] == 'inference_interrupted', {key: saved.get(key) for key in ['state', 'failure_stage', 'failure_reason', 'error']}
                assert 'turn_completed' not in saved
                assert saved['pi_version'] == metadata['version'], 'Pi version evidence does not match the installed package'
                assert saved['observed_invocation']['sdk_version'] == metadata['version'], 'SDK version evidence is incorrect'
                assert saved['observed_invocation']['node_version'] == node_version, 'Node version evidence is incorrect'
                assert server.calls == 1, 'Cancellation scheduled another provider request'
            else:
                started = time.monotonic()
                try:
                    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=150)
                finally:
                    server.catalog_release.set()
                    server.release_length.set()
                    if case == 'length-timeout' and server.length_waiting.is_set():
                        assert server.length_finished.wait(5), 'Expired length response did not settle'
                    server.stop_race.set()
                    if server.racer:
                        server.racer.join(timeout=5)
                assert result.returncode == 0, f'{case}: {result.stdout}\n{result.stderr}'
                if case.startswith('catalog-') and case != 'catalog-metadata':
                    assert server.calls == 0, 'Unavailable metadata reached inference'
                    assert server.catalog_calls == (2 if case.startswith('catalog-recheck-') else 1), 'Metadata was retried or omitted'
                    if case == 'catalog-deadline':
                        assert time.monotonic() - started < 25, 'Metadata deadline was not bounded'
                    assert not server.errors, server.errors
                    print('PASS native Pi workflow ' + case, flush=True)
                    continue
                if case in ['compact', 'compact-failed']:
                    assert server.compactions > 0, 'Pi did not compact its configured context'
                elif case in ['continued', 'repeated']:
                    assert server.calls == 3, f'{case}: expected one tool-write prelude and two responses at the length boundary'
                    assert server.compactions == 0, 'Length continuation changed the compaction threshold'
                elif case not in ['off', 'on', 'catalog-metadata']:
                    assert server.calls == 1, f'{case}: automatic provider retry observed'
                saved = json.loads((root / 'result.json').read_text())
                if case in ['off', 'on', 'compact', 'continued', 'catalog-metadata']:
                    assert saved['usage']['input_tokens'] == server.input_tokens, 'Usage omitted context compaction'
                    assert saved['usage']['output_tokens'] == server.output_tokens, 'Usage omitted context compaction'
                if case in ['incomplete', 'repeated', 'truncated-tool']:
                    assert 'length limit' in saved['error'], 'Truncation reason was not surfaced'
                if case == 'length-timeout':
                    assert server.length_waiting.is_set(), 'Deadline proof did not reach the length response'
                    assert saved['state'] == 'failed' and saved['failure_reason'] == 'inference_interrupted', 'Deadline fabricated completion'
                    assert 'Runtime limit' in saved['error'], 'Original coding deadline was not retained'
            assert not server.errors, server.errors
            assert server.catalog_calls == (3 if case == 'off' else 2), 'Metadata selection/launch checks were omitted or retried'
            if case in length_cases:
                evidence = json.loads((root / 'result.json').read_text())
                events = [json.loads(line) for line in evidence['events'].splitlines()]
                started = [event for event in events if event['type'] == 'pi.started']
                allowed = case in ['continued', 'repeated', 'identity', 'usage', 'length-cancel', 'length-timeout']
                assert len(started) == 1 and started[0]['length_continuation_limit'] == int(allowed), 'Explicit continuation allowance was not recorded'
                continuations = [event for event in events if event.get('event') == 'length_continuation']
                expected_continuations = int(case in ['continued', 'repeated'])
                assert len(continuations) == expected_continuations, 'Continuation count differs from donor authorization'
                for event in continuations:
                    assert event['count'] == 1 and event['limit'] == 1
                assistants = [event for event in events if event.get('event') == 'assistant_end']
                completed = [event for event in events if event['type'] == 'pi.completed']
                assert len(completed) == int(case == 'continued'), 'Incomplete inference fabricated completion'
                if completed:
                    assert assistants[-1]['stop_reason'] == 'stop', 'Completion preceded the final stop'
                    assert completed[0]['length_continuations'] == 1
                    assert completed[0]['usage']['cached_input_tokens'] == 0
                if case in ['incomplete', 'continued', 'repeated', 'truncated-tool']:
                    partials = [event for event in assistants if event['stop_reason'] == 'length']
                    assert len(partials) == (2 if case == 'repeated' else 1)
                    for event in partials:
                        assert event['model'] == 'synthetic/model:exact' and event['provider'] == 'tokate-local'
                        assert event['partial_text'].startswith('PRIVATE_PARTIAL_LENGTH_SENTINEL ')
                        assert len(event['partial_text'].encode('utf-8')) <= 65536 and event['partial_text_truncated'] is True
                        assert '\ufffd' not in event['partial_text'], 'Private text truncation split a Unicode character'
                        assert event['text_characters'] == len(partial_text)
                        assert event['thinking_characters'] == (len(thinking_text) if case == 'incomplete' else 0)
                        assert set(event['content_counts']) == {'text', 'thinking', 'toolCall', 'other'}
                        assert event['content_counts']['text'] == 1 and event['content_counts']['thinking'] == int(case == 'incomplete') and event['content_counts']['other'] == 0
                        assert 'thinking' not in event and 'thinkingSignature' not in event
                        assert event['usage']['output'] == 8192
                    assert thinking_text not in evidence['events'], 'Private diagnostic captured thinking content'
                    if case == 'truncated-tool':
                        assert partials[0]['content_counts']['toolCall'] == 1
                    if case == 'repeated':
                        assert partials[0]['content_counts']['toolCall'] == 1 and partials[1]['content_counts']['toolCall'] == 0
                    failed = [event for event in events if event['type'] == 'pi.failed']
                    if case != 'continued':
                        assert len(failed) == 1 and failed[0]['reason'] == 'length'
                        assert failed[0]['length_continuations'] == expected_continuations
                if case in ['identity', 'usage']:
                    failed = [event for event in events if event['type'] == 'pi.failed']
                    assert len(failed) == 1 and failed[0]['reason'] == case, 'Invalid response evidence did not stop continuation'
                    assert failed[0]['length_continuations'] == 0
            print('PASS native Pi workflow ' + case, flush=True)
    server.shutdown()
