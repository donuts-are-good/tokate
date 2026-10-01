import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('TOKATE_BINARY', PROJECT / 'artifacts/linux-x64/tokate')).resolve()

class NativeFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tokate-e2e-')
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ['gh', 'codex', 'git']:
            path = self.bin / name
            shutil.copyfile(PROJECT / 'tests/native_fixture.py', path)
            path.chmod(0o755)
        (self.bin / 'codex').rename(self.bin / 'codex-impl')
        (self.bin / 'alias').symlink_to(self.bin, target_is_directory=True)
        (self.bin / 'codex').symlink_to(self.bin / 'alias/codex-impl')
        self.env = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'], 'GH_TOKEN': 'fixture-secret', 'OPENAI_API_KEY': 'fixture-secret'}
        self.state = {'issue': {'number': 1, 'state': 'open', 'title': 'Implement fixture', 'body': 'Acceptance criteria: result.txt exists.', 'labels': [], 'assignees': []}}
        self.save()
        self.git('init', '-b', 'main', str(self.bin / 'upstream'))
        upstream = self.bin / 'upstream'
        self.call('init', '--path', str(upstream))
        policy_path = upstream / '.github/tokate.json'
        policy = json.loads(policy_path.read_text())
        policy['verification'] = [['/bin/sh', '-c', 'test -f result.txt']]
        policy_path.write_text(json.dumps(policy))
        self.git('-C', str(upstream), 'add', '.')
        self.git('-C', str(upstream), '-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'Initial')
        self.git('clone', '--bare', str(upstream), str(self.bin / 'fork'))

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', *args], text=True, stderr=subprocess.DEVNULL).strip()

    def save(self):
        (self.bin / 'state.json').write_text(json.dumps(self.state))

    def reload(self):
        self.state = json.loads((self.bin / 'state.json').read_text())

    def call(self, *args, code=0, owner=False):
        result = subprocess.run([str(BINARY), *args], env={**self.env, 'FIXTURE_ACTOR': 'owner' if owner else 'donor'}, text=True, capture_output=True, timeout=25)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def approve(self):
        self.call('approve', '--repo', 'owner/project', '--issue', '1', '--donor', 'donor', owner=True)

    def claim(self, seconds='30', model='gpt-6.1-sol', code=0):
        result = self.call('claim', '--repo', 'owner/project', '--issue', '1', '--model', model, '--effort', 'high', '--seconds', seconds, '--runs', str(self.root / 'runs'), code=code)
        return result.stdout.split('Run: ')[-1].strip()

    def test_native_help_and_strict_arguments(self):
        self.assertIn('toh-KAH-teh', self.call('--help').stdout)
        self.call('nonsense', code=1)
        self.call('approve', '--unknown', 'true', code=1)
        self.call('init', '--path', str(self.bin / 'upstream'), code=1)

    def test_cross_account_flow_and_exact_required_checks(self):
        self.approve()
        run = self.claim()
        self.claim(code=1)
        self.call('work', '--run', run)
        self.call('publish', '--run', run)
        self.reload()
        self.assertEqual(self.state['exec_count'], 1)
        self.assertTrue(self.state['pulls'][0]['draft'])
        self.call('verify-pr', '--repo', 'owner/project', '--pr', '10', owner=True)
        self.call('checks', '--run', run, code=8)
        for checks, expected in [([{'name': 'unrelated', 'bucket': 'pass'}], 8), ([{'name': 'verify', 'bucket': 'skipping'}], 8), ([{'name': 'verify', 'bucket': 'fail'}], 1), ([{'name': 'verify', 'bucket': 'pass'}], 0)]:
            self.reload()
            self.state['checks'] = checks
            self.save()
            self.call('checks', '--repo', 'owner/project', '--pr', '10', code=expected, owner=True)
        self.reload()
        self.state['pulls'][0]['head']['sha'] = 'a' * 40
        self.save()
        self.call('checks', '--run', run, code=1)

    def test_owner_only_and_policy_before_compute(self):
        self.call('approve', '--repo', 'owner/project', '--issue', '1', '--donor', 'donor', code=1)
        self.approve()
        self.claim(model='not-allowed', code=1)
        self.claim(seconds='2000', code=1)
        self.reload()
        self.assertNotIn('exec_count', self.state)

    def test_issue_edit_invalidates_approval(self):
        self.approve()
        self.reload()
        self.state['issue']['body'] = 'Changed task'
        self.save()
        self.claim(code=1)

    def test_revocation_during_execution_blocks_publication(self):
        self.approve()
        run = self.claim()
        self.reload()
        self.state['mode'] = 'revoke'
        self.save()
        self.call('work', '--run', run, code=1)
        self.reload()
        self.assertNotIn('pulls', self.state)
        self.call('publish', '--run', run, code=1)

    def test_timeout_kills_descendants_no_automatic_retry(self):
        self.approve()
        run = self.claim(seconds='1')
        self.reload()
        self.state['mode'] = 'timeout'
        self.save()
        self.call('work', '--run', run, code=1)
        pid = int((self.bin / 'child.pid').read_text())
        status = Path('/proc') / str(pid) / 'stat'
        self.assertTrue(not status.exists() or status.read_text().split()[2] == 'Z')
        self.call('work', '--run', run, code=1)
        self.reload()
        self.assertEqual(self.state['exec_count'], 1)

    def test_policy_change_and_reassignment_invalidate_claim(self):
        self.approve()
        run = self.claim()
        self.call('assign', '--repo', 'owner/project', '--issue', '1', '--donor', 'donor', owner=True)
        self.call('work', '--run', run, code=1)
        self.reload()
        self.assertNotIn('exec_count', self.state)

    def test_independent_verification_rejects_false_success(self):
        self.approve()
        run = self.claim()
        self.reload()
        self.state['mode'] = 'verification_fail'
        self.save()
        result = self.call('work', '--run', run, code=1)
        self.assertIn('Owner verification failed', result.stderr)
        self.assertEqual(json.loads((Path(run) / 'verification.json').read_text())[0]['exit_code'], 1)
        self.reload()
        self.assertNotIn('pulls', self.state)

    def test_policy_edit_requires_new_approval(self):
        self.approve()
        run = self.claim()
        upstream = self.bin / 'upstream'
        path = upstream / '.github/tokate.json'
        value = json.loads(path.read_text())
        value['models'] = {'gpt-6.1-sol': ['low']}
        path.write_text(json.dumps(value))
        self.git('-C', str(upstream), 'add', '.')
        self.git('-C', str(upstream), '-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'Change policy')
        result = self.call('work', '--run', run, code=1)
        self.assertIn('policy or template changed', result.stderr)
        self.reload()
        self.assertNotIn('exec_count', self.state)

    def test_ci_changes_cannot_be_published(self):
        self.approve()
        run = self.claim()
        self.reload()
        self.state['mode'] = 'workflow'
        self.save()
        result = self.call('work', '--run', run, code=1)
        self.assertIn('cannot change owner policy', result.stderr)
        self.reload()
        self.assertNotIn('pulls', self.state)

    def test_repo_agent_configuration_stops_before_compute(self):
        upstream = self.bin / 'upstream'
        (upstream / '.codex').mkdir()
        (upstream / '.codex/config.toml').write_text('sandbox_mode="danger-full-access"')
        self.git('-C', str(upstream), 'add', '.')
        self.git('-C', str(upstream), '-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'Agent config')
        self.git('-C', str(self.bin / 'fork'), 'fetch', str(upstream), 'main')
        self.approve()
        run = self.claim()
        result = self.call('work', '--run', run, code=1)
        self.assertIn('Repository Codex configuration', result.stderr)
        self.reload()
        self.assertNotIn('exec_count', self.state)

    def test_no_patch_never_opens_pr(self):
        self.approve()
        run = self.claim()
        self.reload()
        self.state['mode'] = 'empty'
        self.save()
        result = self.call('work', '--run', run, code=1)
        self.assertIn('No changes returned', result.stderr)
        self.reload()
        self.assertNotIn('pulls', self.state)

if __name__ == '__main__':
    unittest.main()
