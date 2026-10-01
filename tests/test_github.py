import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class GitHubFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        source = self.root / "source"
        source.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main", str(source)], check=True)
        (source / "README.md").write_text("Committed content\n")
        subprocess.run(["git", "-C", str(source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(source), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture"], check=True)
        subprocess.run(["git", "clone", "-q", "--bare", str(source), str(self.root / "remote.git")], check=True)
        self.base = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        self.update({"issue": {"number": 18, "state": "open", "title": "Improve fixture", "body": "EDIT",
                               "html_url": "https://github.com/fixture/widgets/issues/18", "labels": [], "assignees": []}})
        for name in ["gh", "codex"]:
            shutil.copyfile(ROOT / "tests" / f"fake_{name}.py", self.root / name)
            (self.root / name).chmod(0o700)
        self.env = {**os.environ, "PYTHONPATH": str(ROOT), "COMPUTE_DONOR_TEST_FIXTURE": str(self.root),
                    "GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": f"url.file://{self.root}/remote.git.insteadOf",
                    "GIT_CONFIG_VALUE_0": "https://github.com/fixture/widgets.git",
                    "GIT_CONFIG_KEY_1": "protocol.file.allow", "GIT_CONFIG_VALUE_1": "always"}

    def tearDown(self):
        self.temp.cleanup()

    def state(self):
        return json.loads((self.root / "github.json").read_text())

    def update(self, change):
        state = self.state() if (self.root / "github.json").exists() else {}
        (self.root / "github.json").write_text(json.dumps({**state, **change}))

    def cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, "-m", "compute_donor", "github", "--gh", str(self.root / "gh"), *args],
                                cwd=self.root, env=self.env, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def approve(self):
        return self.cli("approve", "--repo", "fixture/widgets", "--issue", "18", "--donor", "@me")

    def work(self, ok=True):
        return self.cli("work", "--repo", "fixture/widgets", "--issue", "18", "--model", "fixture-model",
                        "--seconds", "10", "--codex", str(self.root / "codex"), ok=ok)

    def run_path(self):
        return next((self.root / ".runs").iterdir())

    def test_issue_approval_to_pushed_pr_and_exact_commit_ci(self):
        self.approve()
        self.work()
        directory = self.run_path()
        run = json.loads((directory / "github.json").read_text())
        receipt = json.loads((directory / "receipt.json").read_text())
        self.assertEqual(receipt["model"], "fixture-model")
        self.assertEqual(run["pr_url"], "https://github.com/fixture/widgets/pull/19")
        self.assertIn("Fixes #18", self.state()["pr"]["body"])
        remote = ["git", "--git-dir", str(self.root / "remote.git")]
        self.assertEqual(subprocess.check_output([*remote, "rev-parse", "main"], text=True).strip(), self.base)
        self.assertEqual(subprocess.check_output([*remote, "show", run["branch"] + ":NEW.txt"], text=True), "New file\n")
        self.cli("publish", "--run", str(directory))
        self.assertEqual(self.state()["pr_creates"], 1)
        self.assertIn('"passed"', self.cli("checks", "--run", str(directory)).stdout)
        self.update({"checks": []})
        self.assertIn('"pending"', self.cli("checks", "--run", str(directory)).stdout)
        self.update({"checks": [{"name": "verify", "bucket": "skipping"}]})
        self.assertIn('"pending"', self.cli("checks", "--run", str(directory)).stdout)
        self.update({"checks": [{"name": "verify", "bucket": "fail"}]})
        self.cli("checks", "--run", str(directory), ok=False)
        state = self.state()
        state["pr"]["head"]["sha"] = "a" * 40
        self.update(state)
        self.assertIn("PR head changed", self.cli("checks", "--run", str(directory), ok=False).stderr)

    def test_unapproved_and_wrong_donor_never_start_compute(self):
        self.assertIn("needs the compute:approved", self.work(ok=False).stderr)
        self.approve()
        state = self.state()
        state["issue"]["assignees"] = [{"login": "someone-else"}]
        self.update(state)
        self.assertIn("not assigned", self.work(ok=False).stderr)
        self.assertFalse((self.root / ".runs").exists())

    def test_existing_branch_blocks_duplicate_compute_and_revocation_blocks_pr(self):
        self.approve()
        self.update({"revoke_at": 3})
        self.assertIn("needs the compute:approved", self.work(ok=False).stderr)
        self.assertNotIn("pr", self.state())
        self.assertTrue((self.run_path() / "receipt.json").exists())
        self.approve()
        self.assertIn("Reference already exists", self.work(ok=False).stderr)
        self.assertEqual(len(list((self.root / ".runs").glob("*/receipt.json"))), 1)


if __name__ == "__main__":
    unittest.main()
