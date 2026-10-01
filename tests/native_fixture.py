#!/usr/bin/env python3
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'state.json'
a = sys.argv[1:]
name = Path(sys.argv[0]).name
s = json.loads(STATE.read_text())
env = {**os.environ, 'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.test', 'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.test'}

def git(repo, *args, data=None):
    return subprocess.check_output(['/usr/bin/git', '-C', str(ROOT / repo), *args], input=data, text=True, env=env).strip()

def save():
    STATE.write_text(json.dumps(s))

def answer(value):
    save()
    print(json.dumps(value))
    sys.exit(0)

def fail(text):
    print(text, file=sys.stderr)
    sys.exit(1)

if name == 'git':
    a = [str(ROOT / ('upstream' if x == 'https://github.com/owner/project.git' else 'fork')) if x in ['https://github.com/owner/project.git', 'https://github.com/donor/project.git'] else x for x in a]
    a = ['protocol.file.allow=always' if x == 'protocol.file.allow=never' else x for x in a]
    os.execv('/usr/bin/git', ['git', *a])

if name.startswith('codex'):
    if a == ['--version']:
        print('codex-cli 0.159.3')
        sys.exit(0)
    if a == ['login', 'status']:
        print('Logged in using ChatGPT')
        sys.exit(0)
    if a[0] == 'sandbox':
        assert 'permissions.tokate.network.enabled=false' in a
        if '/usr/bin/env' in a:
            command = a[a.index('--') + 1:]
            sys.exit(subprocess.run(command, cwd=a[a.index('-C') + 1]).returncode)
        sys.exit(0)
    assert a[0] == 'exec'
    assert not os.environ.get('GH_TOKEN') and not os.environ.get('OPENAI_API_KEY')
    assert '--strict-config' in a and '--ignore-user-config' in a and '--ignore-rules' in a
    assert 'approval_policy="never"' in a
    assert any(':root' in x and 'deny' in x and '.git' in x for x in a)
    prompt = sys.stdin.read()
    assert 'Acceptance criteria addressed' in prompt
    s['exec_count'] = s.get('exec_count', 0) + 1
    save()
    if s.get('mode') == 'timeout':
        child = subprocess.Popen(['/usr/bin/sleep', '120'])
        (ROOT / 'child.pid').write_text(str(child.pid))
        time.sleep(120)
    if s.get('mode') == 'revoke':
        s['issue']['labels'] = []
        save()
    checkout = Path(a[a.index('--cd') + 1])
    if s.get('mode') == 'verification_fail':
        (checkout / 'other.txt').write_text('Slop')
    elif s.get('mode') != 'empty':
        (checkout / 'result.txt').write_text('Implemented acceptance criteria\n')
    if s.get('mode') == 'workflow':
        workflows = checkout / '.github/workflows'
        workflows.mkdir()
        (workflows / 'verify.yml').write_text('tampered')
    Path(a[a.index('--output-last-message') + 1]).write_text('### Changes\nAdded result.\n### Acceptance criteria addressed\nFixture.\n### Verification\nFixture check passed.\n### Unresolved limitations\nNone.\n')
    print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 50, 'output_tokens': 10}}))
    sys.exit(0)

if a == ['--version']:
    print('gh version fixture')
    sys.exit(0)

actor = os.environ.get('FIXTURE_ACTOR', 'donor')
if a[:2] == ['pr', 'checks']:
    answer(s.get('checks', []))
assert a[0] == 'api', a
method = a[a.index('--method') + 1]
path = a[a.index('--method') + 2]
body = json.load(sys.stdin) if '--input' in a else None
if path == 'user':
    answer({'login': actor, 'id': 123})
parts = path.split('/')
assert parts[0] == 'repos', path
repo = '/'.join(parts[1:3])
folder = 'upstream' if repo == 'owner/project' else 'fork'
tail = '/'.join(parts[3:])
if not tail:
    answer({'default_branch': 'main', 'permissions': {'push': actor == repo.split('/')[0]}, 'parent': {'full_name': 'owner/project'}})
if tail.startswith('commits/'):
    answer({'sha': git(folder, 'rev-parse', tail[8:])})
if tail.startswith('contents/'):
    file, ref = tail[9:].split('?ref=')
    from urllib.parse import unquote
    text = git(folder, 'show', unquote(ref) + ':' + file)
    answer({'encoding': 'base64', 'content': base64.b64encode(text.encode()).decode()})
if tail.startswith('issues/'):
    if method == 'GET':
        answer(s['issue'])
    if tail.endswith('/assignees'):
        s['issue']['assignees'] = [] if method == 'DELETE' else [{'login': x} for x in body['assignees']]
    elif tail.endswith('/labels'):
        s['issue']['labels'] = [{'name': x} for x in body['labels']]
    elif method == 'DELETE':
        s['issue']['labels'] = []
    answer(s['issue'])
if tail.startswith('labels'):
    answer({'name': 'tokate:approved'})
if tail.startswith('git/ref/heads/'):
    try:
        sha = git(folder, 'rev-parse', '--verify', 'refs/heads/' + tail[14:])
    except subprocess.CalledProcessError:
        fail('HTTP 404')
    answer({'object': {'sha': sha}})
if tail.startswith('git/commits/'):
    answer({'tree': {'sha': git(folder, 'rev-parse', tail[12:] + '^{tree}')}})
if tail == 'git/trees':
    index = ROOT / 'tree.index'
    e = {**env, 'GIT_INDEX_FILE': str(index)}
    def indexgit(*args, data=None):
        return subprocess.check_output(['/usr/bin/git', '-C', str(ROOT / folder), *args], input=data, text=True, env=e).strip()
    indexgit('read-tree', body['base_tree'])
    for item in body['tree']:
        sha = indexgit('hash-object', '-w', '--stdin', data=item['content'])
        indexgit('update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + item['path'])
    answer({'sha': indexgit('write-tree')})
if tail == 'git/commits':
    args = ['commit-tree', body['tree']]
    for parent in body['parents']:
        args += ['-p', parent]
    answer({'sha': git(folder, *args, data=body['message'])})
if tail == 'git/refs':
    try:
        git(folder, 'update-ref', body['ref'], body['sha'], '0' * 40)
    except subprocess.CalledProcessError:
        fail('Reference already exists')
    answer({'ref': body['ref']})
if tail.startswith('git/refs/heads/'):
    git(folder, 'update-ref', 'refs/heads/' + tail[15:], body['sha'])
    answer({})
if tail.startswith('pulls?'):
    answer(s.get('pulls', []))
if tail.startswith('pulls/'):
    answer(s['pulls'][0])
if tail == 'pulls':
    branch = body['head'].split(':')[1]
    pull = {**body, 'number': 10, 'html_url': 'https://github.com/owner/project/pull/10', 'state': 'open', 'user': {'login': actor}, 'head': {'sha': git('fork', 'rev-parse', branch), 'ref': branch, 'repo': {'owner': {'login': 'donor'}}}, 'base': {'ref': body['base']}}
    s['pulls'] = [pull]
    answer(pull)
fail('Unhandled fixture API: ' + path)
