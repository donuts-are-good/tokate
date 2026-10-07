#!/usr/bin/env python3
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time


MODEL = 'claude-opus-4-6'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def system_mounts():
    result = []
    for path in ['/usr/bin', '/usr/lib', '/usr/share', '/bin', '/lib', '/lib64']:
        if Path(path).exists():
            result += ['--ro-bind', path, path]
    for path in ['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf']:
        if Path(path).exists():
            result += ['--ro-bind', path, path]
    return result


def run(command, seconds=30):
    return subprocess.run(command, text=True, capture_output=True, timeout=seconds,
                          env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/tmp/home'})


def gate(root, extra=(), success=True, profile=None):
    command = ['/tokate-control/tokate', 'claude-capabilities', '--claude', '/tokate-control/claude',
               '--claude-profile', str(profile or root / 'profile'), '--sole-use', '--model', MODEL, '--effort', 'high', '--json', *extra]
    result = run(command)
    require((result.returncode == 0) == success, 'Native capability gate gave an unexpected result: ' + result.stderr[:1000])
    envelope = json.loads(result.stdout)
    require('synthetic-organization' not in result.stdout, 'Native organization fields were retained')
    return envelope.get('data') if success else envelope


class Fixture(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root, network, case):
        super().__init__(('127.0.0.1', 0), Handler)
        self.root, self.network, self.case = root, network, case
        self.calls, self.gets, self.errors, self.requests, self.tool_results = 0, 0, [], [], []

    def handle_error(self, request, address):
        self.errors.append(str(sys.exc_info()[1]))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_GET(self):
        require(self.path == '/command', 'Unexpected local fixture GET')
        self.server.gets += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'local fixture response')

    def do_POST(self):
        require(self.path.split('?')[0] == '/v1/messages', 'Unexpected local fixture POST')
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        server = self.server
        server.calls += 1
        server.requests.append(body)
        require(body.get('model') == MODEL, 'Native CLI remapped the exact model')
        require(body.get('output_config', {}).get('effort') == 'high', 'Native CLI did not request high effort')
        names = {tool['name'] for tool in body.get('tools', [])}
        require({'Read', 'Write', 'Bash'} <= names and names <= {'Read', 'Write', 'Edit', 'Bash', 'EndConversation'},
                'Native CLI enabled unexpected automatic tools')
        results = [block for message in body['messages'] if isinstance(message.get('content'), list)
                   for block in message['content'] if block.get('type') == 'tool_result']
        server.tool_results = results
        if server.case == 'error':
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"type":"error","error":{"type":"api_error","message":"synthetic failure"}}')
            return
        if server.case in ('cancel', 'timeout'):
            tool = ('Bash', {'command': 'printf started > lifecycle.txt; (while true; do printf x >> heartbeat.txt; sleep 0.1; done) & wait',
                             'timeout': 30000})
        else:
            steps = [('Read', {'file_path': str(server.root / 'checkout/input.txt')}),
                     ('Write', {'file_path': str(server.root / 'checkout/output.txt'), 'content': 'native fixture write\n'}),
                     ('Bash', {'command': "printf progress > command.txt; sh -c 'printf helper > helper.txt'"}),
                     ('Bash', {'command': f"curl --noproxy '' --max-time 3 -fsS http://localhost:{server.server_port}/command"})]
            tool = steps[server.calls - 1] if server.calls <= len(steps) else None
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.event('message_start', {'type': 'message_start', 'message': {'id': 'msg_synthetic_' + str(server.calls),
                   'type': 'message', 'role': 'assistant', 'model': MODEL, 'content': [], 'stop_reason': None,
                   'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}})
        if tool:
            name, inputs = tool
            self.event('content_block_start', {'type': 'content_block_start', 'index': 0,
                       'content_block': {'type': 'tool_use', 'id': 'tool_synthetic_' + str(server.calls), 'name': name, 'input': {}}})
            self.event('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                       'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(inputs)}})
        else:
            self.event('content_block_start', {'type': 'content_block_start', 'index': 0,
                       'content_block': {'type': 'text', 'text': ''}})
            self.event('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                       'delta': {'type': 'text_delta', 'text': 'synthetic fixture complete'}})
        self.event('content_block_stop', {'type': 'content_block_stop', 'index': 0})
        self.event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if tool else 'end_turn',
                   'stop_sequence': None}, 'usage': {'output_tokens': 1}})
        self.event('message_stop', {'type': 'message_stop'})

    def event(self, name, body):
        self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps(body) + '\n\n').encode())
        self.wfile.flush()


def owned_case(root, network, case):
    checkout = root / 'checkout'
    data = gate(root, ['--path', str(checkout), *(['--allow-network'] if network else [])])
    require(data['managed_execution_enabled'] is False, 'Managed inference was enabled')
    require(data['auth_status'] == {'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty', 'subscriptionType': 'pro'},
            'Native auth status did not pass the approved schema')
    server = Fixture(root, network, case)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    boundary = data['configured_boundary']
    split = boundary.index('--')
    boundary[split:split] = ['--setenv', 'ANTHROPIC_BASE_URL', f'http://127.0.0.1:{server.server_port}',
                            '--setenv', 'ANTHROPIC_API_KEY', 'synthetic-local-fixture-key']
    boundary += data['invocation']
    process = subprocess.Popen(['/usr/bin/bwrap', *boundary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    observed = process.args[-len(data['invocation']):]
    evidence = {'requested': data['requested'], 'observed_invocation': observed}
    evidence_path = root / 'invocation.json'
    heartbeat = checkout / 'heartbeat.txt'
    try:
        evidence_path.write_text(json.dumps(evidence))
        process.stdin.write('Run the synthetic scripted fixture.\n')
        process.stdin.close()
        process.stdin = None
        if case in ('cancel', 'timeout'):
            deadline = time.monotonic() + 30
            while (not heartbeat.exists() or heartbeat.stat().st_size == 0) and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            require(heartbeat.exists() and heartbeat.stat().st_size > 0, 'Native CLI never started the ordinary lifecycle child')
            os.killpg(process.pid, signal.SIGINT if case == 'cancel' else signal.SIGTERM)
        output, error = process.communicate(timeout=40)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        server.shutdown()
        server.server_close()
        thread.join()
    require(not server.errors, 'Local protocol fixture failed: ' + str(server.errors))
    require(server.calls >= 1, 'Native CLI never contacted the local protocol fixture: ' + error[:1500])
    if case in ('cancel', 'timeout'):
        size = heartbeat.stat().st_size
        time.sleep(0.3)
        require(heartbeat.stat().st_size == size and server.calls == 1, 'Ordinary cancellation leaked a child or retried')
        require((checkout / 'lifecycle.txt').read_text() == 'started', 'Cancellation lost useful checkout progress')
        print('PASS native ' + case + ', child cleanup and retained fixture progress', flush=True)
        return
    report = root / 'report.jsonl'
    report.write_text(output)
    report_profile = root / 'report-profile'
    new_profile(report_profile)
    if case == 'error':
        refusal = gate(root, ['--file', str(report)], profile=report_profile, success=False)
        require('reported conflicting model' in refusal['error']['message'], 'Native error-report model conflict was not refused')
        require(process.returncode != 0 and server.calls == 1, 'Native request failure retried or succeeded')
        print('PASS native failed request without retry or fallback and conflicting error-report model refusal', flush=True)
        return
    parsed = gate(root, ['--file', str(report)], profile=report_profile)['native_reports']
    evidence['native_reports'] = parsed
    evidence_path.write_text(json.dumps(evidence))
    require(observed[observed.index('--model') + 1] == evidence['requested']['model'] and
            observed[observed.index('--effort') + 1] == evidence['requested']['effort'], 'Observed invocation conflicts with requested choices')
    require(parsed.get('model') == MODEL and parsed.get('permissionMode') == 'default', 'Native invocation reports conflict or are missing')
    require(process.returncode == 0, 'Native fixture failed: ' + error[:1500])
    require(server.calls == 5, 'Unexpected native fixture turn or retry count')
    require((checkout / 'output.txt').read_text() == 'native fixture write\n', 'Native Write did not persist its fixture output')
    require((checkout / 'command.txt').read_text() == 'progress' and (checkout / 'helper.txt').read_text() == 'helper',
            'Ordinary repository command or helper failed')
    require(server.gets == (1 if network else 0), 'Command-network permission did not reach the expected local fixture result: ' + str(server.tool_results[-1].get('content'))[:1200])
    require(len(server.tool_results) == 4 and not any(block.get('is_error') for block in server.tool_results[:3]),
            'Ordinary native fixture file tools failed')
    require('native fixture read' in str(server.tool_results[0].get('content')), 'Native Read did not return the fixture contents')
    require(bool(server.tool_results[-1].get('is_error')) == (not network), 'Command-network tool result was not the expected success or refusal')
    print('PASS native Read, Write, Bash, helper, exact request and command-network ' + ('permitted' if network else 'denied'), flush=True)
    if 'effort' not in parsed and 'effortLevel' not in parsed:
        print('LIMIT native reports omit effort; requested high is observed only in the local synthetic protocol request', flush=True)


def new_profile(profile, plan='pro'):
    profile.mkdir(parents=True, mode=0o700)
    (profile / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': 'synthetic-native-status-only',
        'refreshToken': 'synthetic-native-status-only', 'expiresAt': 9999999999999, 'scopes': ['user:inference', 'user:profile'],
        'subscriptionType': plan, 'rateLimitTier': 'default_claude_pro'}}))
    (profile / '.claude.json').write_text(json.dumps({'oauthAccount': {'organizationUuid': 'synthetic-organization',
        'organizationName': 'synthetic-organization', 'emailAddress': 'synthetic-organization'}}))


def managed_metadata(root):
    policy = root / 'policy'
    policy.mkdir()
    (policy / 'managed-settings.json').write_text('{}')
    command = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
               '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
               '--setenv', 'HOME', '/tmp/home', '--setenv', 'TERM', 'dumb', *system_mounts(),
               '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home', '--bind', str(root), '/fixture',
               '--ro-bind', '/tokate-control', '/tokate-control', '--ro-bind', str(policy), '/etc/claude-code',
               '--chdir', '/fixture', '--', '/tokate-control/tokate', 'claude-capabilities',
               '--claude', '/tokate-control/claude', '--claude-profile', '/fixture/profile', '--sole-use',
               '--model', MODEL, '--effort', 'high', '--json']
    result = run(command)
    require(result.returncode == 1 and 'managed-policy presence' in result.stdout,
            'Managed-policy metadata was not refused before profile exposure')
    blocked = root / 'blocked-policy-parent'
    blocked.mkdir(mode=0o000)
    position = command.index(str(policy))
    command[position:position + 2] = [str(blocked), '/etc']
    try:
        result = run(command)
        require(result.returncode == 1 and 'managed-policy metadata' in result.stdout,
                'Managed-policy metadata inspection error was not refused: ' + result.stdout[-1200:] + result.stderr[-600:])
    finally:
        blocked.chmod(0o700)
    print('PASS managed-policy metadata presence and inspection-error refusal before profile exposure', flush=True)


def inside():
    root = Path('/fixture')
    managed_metadata(root)
    max_profile = root / 'max-status'
    new_profile(max_profile, 'max')
    require(gate(root, profile=max_profile)['auth_status']['subscriptionType'] == 'max', 'Native Max status was not accepted')
    print('PASS standalone native Max auth schema and organization field omission', flush=True)
    for case, network in [('denied', False), ('permitted', True), ('error', False), ('cancel', False), ('timeout', False)]:
        current = root / case
        profile = current / 'profile'
        new_profile(profile)
        checkout = current / 'checkout'
        (checkout / '.git').mkdir(parents=True)
        (checkout / 'input.txt').write_text('native fixture read\n')
        data = gate(current)
        print('Native Claude tested version: ' + data['version'], flush=True)
        for key in ['settings.json', 'managed-settings.json']:
            (profile / key).write_text('{}')
            gate(current, success=False)
            (profile / key).unlink()
        owned_case(current, network, case)
    print('LIMIT fixture behavior and declared mounts do not prove remote subscription entitlement or all credential and helper isolation', flush=True)
    print('Managed Claude inference remains disabled; no external service route or inference was used', flush=True)


def main():
    parser = argparse.ArgumentParser(description='Native Claude ordinary synthetic protocol checks without external service access or inference')
    parser.add_argument('--claude', required=True, type=Path)
    parser.add_argument('--binary', type=Path, default=Path('artifacts/linux-x64/tokate'))
    parser.add_argument('--inside', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.inside:
        inside()
        return
    require(sys.platform == 'linux' and Path('/usr/bin/bwrap').is_file(), 'Linux bubblewrap is required; no fallback')
    claude, binary = args.claude.resolve(strict=True), args.binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='tokate-claude-proof-') as root:
        command = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
                   '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', *system_mounts(),
                   '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home',
                   '--bind', root, '/fixture', '--ro-bind', str(Path(__file__).resolve()), '/tokate-control/proof.py',
                   '--ro-bind', str(claude), '/tokate-control/claude', '--ro-bind', str(binary), '/tokate-control/tokate',
                   '--chdir', '/fixture', '--', '/usr/bin/python3', '/tokate-control/proof.py',
                   '--inside', '--claude', '/tokate-control/claude', '--binary', '/tokate-control/tokate']
        result = subprocess.run(command, timeout=300)
        require(result.returncode == 0, 'Native Claude proof failed; managed execution remains disabled')


if __name__ == '__main__':
    main()
