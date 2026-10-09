import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import runpy
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[2]


class ProofRegressions(unittest.TestCase):
    def test_download_preserves_unowned_files_and_failed_update(self):
        payload = b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x3e\x00'
        manifest = {'version': '1.2.3', 'platforms': {'linux-x64': {
            'binary': 'claude', 'size': len(payload), 'checksum': hashlib.sha256(payload).hexdigest(),
        }}}
        def response(url, **options):
            return io.BytesIO(json.dumps(manifest).encode() if url.endswith('manifest.json') else payload)
        with tempfile.TemporaryDirectory(prefix='tokate-download-') as directory:
            root = Path(directory)
            destination = root / 'claude'
            collision = destination.with_suffix('.download')
            collision.write_text('unowned partial download')
            args = ['claude-download.py', '--version', '1.2.3', '--output', str(destination)]
            with patch.object(sys, 'argv', args), patch('urllib.request.urlopen', response):
                runpy.run_path(str(PROJECT / 'scripts/claude-download.py'), run_name='__main__')
            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(collision.read_text(), 'unowned partial download')
            manifest['platforms']['linux-x64']['checksum'] = '0' * 64
            with patch.object(sys, 'argv', args), patch('urllib.request.urlopen', response):
                with self.assertRaisesRegex(RuntimeError, 'checksum or size mismatch'):
                    runpy.run_path(str(PROJECT / 'scripts/claude-download.py'), run_name='__main__')
            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(collision.read_text(), 'unowned partial download')
            self.assertEqual(list(root.glob('claude.*.download')), [])

    def test_package_excludes_unlisted_plugin_files(self):
        documents = ['owners', 'donors', 'recovery', 'security', 'development', 'nix',
                     'alpine', 'linux-security', 'linux-harnesses']
        notices = ['dotnet-LICENSE.TXT', 'dotnet-THIRD-PARTY-NOTICES.TXT', 'GSharp.txt', 'Spectre.Console.txt']
        files = ['scripts/package.sh', 'README.md', 'AGENTS.md', 'LICENSE',
                 'plugins/install.sh', 'plugins/tokate/SKILL.md']
        files += ['docs/' + name + '.md' for name in documents]
        files += ['licenses/' + name for name in notices]
        with tempfile.TemporaryDirectory(prefix='tokate-package-') as directory:
            root = Path(directory)
            for name in files:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(PROJECT / name, target)
            (root / 'plugins/.env').write_text('synthetic private settings')
            (root / 'plugins/private-note.txt').write_text('synthetic private note')
            for name, output in [('bin/dotnet', '1.2.3'), ('artifacts/linux-x64/tokate', 'tokate 1.2.3')]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("#!/bin/sh\nprintf '%s\\n' '" + output + "'\n")
                target.chmod(0o755)
            result = subprocess.run(['bash', str(root / 'scripts/package.sh')], cwd=root,
                env={'HOME': str(root), 'PATH': str(root / 'bin') + ':/usr/bin:/bin'},
                capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(root / 'artifacts/tokate-1.2.3-linux-x64.tar.gz') as archive:
                plugins = [member.name for member in archive.getmembers()
                           if member.isfile() and '/plugins/' in member.name]
            self.assertEqual(sorted(plugins), ['tokate-1.2.3-linux-x64/plugins/install.sh',
                'tokate-1.2.3-linux-x64/plugins/tokate/SKILL.md'])

    def test_omp_rejects_guard_failures_after_expected_error(self):
        node = Path(shutil.which('node')).resolve()
        with tempfile.TemporaryDirectory(prefix='tokate-omp-guards-', dir='/var/tmp') as directory:
            root = Path(directory)
            package = root / 'package'
            package.mkdir()
            (package / 'package.json').write_text(json.dumps({'exports': {'.': {'import': './sdk.mjs'}}}))
            shutil.copyfile(PROJECT / 'tests/Tools/proof-sdk.mjs', package / 'sdk.mjs')
            command = [
                'bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
                '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
                '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
                '--ro-bind', str(node), '/node', '--ro-bind', str(package), '/tokate-runtime/node_modules/@oh-my-pi/pi-coding-agent',
                '--ro-bind', str(PROJECT / 'scripts/omp-proof.mjs'), '/proof.mjs',
                '--setenv', 'PATH', '/usr/bin:/bin',
            ]
            for fault in ['', 'dispatch', 'transport', 'dispose']:
                with self.subTest(fault=fault):
                    result = subprocess.run(command + ['--setenv', 'PROOF_FAULT', fault, '--',
                        '/node', '/proof.mjs', 'error503', '/tmp/work', '/tmp/outside'],
                        capture_output=True, text=True, timeout=10)
                    record = json.loads(result.stdout)
                    self.assertEqual(result.returncode, 1 if fault else 0, result.stderr + result.stdout)
                    self.assertEqual(record['type'], 'omp.failure' if fault else 'omp.proof')
                    if fault:
                        self.assertEqual(record['assertion'], 'Unapproved dispatch, transport, or recovery')

    def test_pi_reaps_worker_and_child_when_fixture_read_fails(self):
        with tempfile.TemporaryDirectory(prefix='tokate-pi-cleanup-', dir='/var/tmp') as directory:
            root = Path(directory)
            package = root / 'modules/@earendil-works/pi-coding-agent'
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name': '@earendil-works/pi-coding-agent', 'version': 'fixture'}))
            pids = root / 'pids.json'
            heartbeat = root / 'heartbeat'
            worker = root / 'worker'
            child = "import pathlib,sys,time\np=pathlib.Path(sys.argv[1])\nwhile True:\n with p.open('a') as f:f.write('alive\\n')\n time.sleep(.02)\n"
            worker.write_text('#!/usr/bin/python3\n' +
                'import json,os,pathlib,subprocess,sys,time\n' +
                f'child=subprocess.Popen([sys.executable,"-c",{child!r},{str(heartbeat)!r}])\n' +
                f'pathlib.Path({str(pids)!r}).write_text(json.dumps([os.getpid(),child.pid]))\n' +
                f'while not pathlib.Path({str(heartbeat)!r}).exists():time.sleep(.01)\n' +
                'pathlib.Path(sys.argv[4],"fixture.json").write_text("{")\ntime.sleep(60)\n')
            worker.chmod(0o755)
            try:
                result = subprocess.run([sys.executable, str(PROJECT / 'scripts/pi-proof.py'),
                    '--pi-root', str(root / 'modules'), '--node', shutil.which('node'),
                    '--tests', str(worker), '--case', 'cancel'], capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('JSONDecodeError', result.stderr)
                for pid in json.loads(pids.read_text()):
                    stat = Path(f'/proc/{pid}/stat')
                    self.assertTrue(not stat.exists() or stat.read_text().split(') ', 1)[1].startswith('Z '))
                before = heartbeat.read_bytes()
                time.sleep(.2)
                self.assertEqual(heartbeat.read_bytes(), before)
            finally:
                if pids.exists():
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(json.loads(pids.read_text())[0], signal.SIGKILL)


if __name__ == '__main__':
    unittest.main()
