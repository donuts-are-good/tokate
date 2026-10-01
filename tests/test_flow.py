import concurrent.futures
from contextlib import closing
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from compute_donor.queue import server
from compute_donor.worker import request


ROOT = Path(__file__).resolve().parents[1]


class DonationFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("Committed content\n")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture")
        (self.repo / "README.md").write_text("Uncommitted work\n")
        (self.repo / "private.txt").write_text("Do not copy\n")
        self.fake = self.root / "codex"
        shutil.copyfile(ROOT / "tests/fake_codex.py", self.fake)
        self.fake.chmod(0o700)
        self.http = server(self.state, port=0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.http.server_port}"
        self.token = (self.state / "admin.token").read_text()
        self.cli("project", "example", "--repo", str(self.repo))

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True).strip()

    def cli(self, *args, ok=True):
        env = {**os.environ, "PYTHONPATH": str(ROOT), "OPENAI_API_KEY": "must-not-inherit",
               "CODEX_API_KEY": "must-not-inherit", "DONOR_SECRET": "must-not-inherit"}
        result = subprocess.run([sys.executable, "-m", "compute_donor", "--state", str(self.state),
                                 "--url", self.url, *args], cwd=self.root, env=env,
                                capture_output=True, text=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def api(self, path, body=None, token=None):
        return request(self.url, token or self.token, path, body)

    def task(self, prompt="REPORT", mode="read-only", project="example"):
        return self.api("/jobs", {"project": project, "prompt": prompt, "mode": mode})["id"]

    def grant(self, jobs=1, seconds=10, project="example"):
        path = self.root / f"grant-{time.time_ns()}.json"
        self.cli("grant", project, "--donor", "test", "--jobs", str(jobs),
                 "--task-seconds", str(seconds), "--out", str(path))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        return path, json.loads(path.read_text())

    def worker(self, path, *args, ok=True):
        return self.cli("work", "--grant", str(path), "--repo", str(self.repo),
                        "--codex", str(self.fake), "--seconds", "10", *args, ok=ok)

    def assert_child_stopped(self, job):
        pid = (self.root / ".runs" / job / "child.pid").read_text()
        proc = Path("/proc") / pid / "stat"
        if proc.exists():
            self.assertEqual(proc.read_text().split()[2], "Z")

    def test_full_flow_patch_receipt_budget_and_original_checkout(self):
        job = self.task("EDIT BACKGROUND", "workspace-write")
        second = self.task()
        path, grant = self.grant()
        before = self.git("status", "--porcelain")
        self.worker(path, "--sandbox", "workspace-write", "--jobs", "2")
        result = json.loads(self.cli("show", job).stdout)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["report"], "Fixture report\n")
        self.assertEqual(result["result"]["usage"]["output_tokens"], 5)
        self.assertIn("NEW.txt", result["result"]["patch"])
        self.assertIn("-Committed content", result["result"]["patch"])
        self.assert_child_stopped(job)
        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual((self.repo / "README.md").read_text(), "Uncommitted work\n")
        self.assertEqual(self.api("/jobs/" + second)["status"], "queued")
        applied = self.root / "patch-check"
        subprocess.run(["git", "clone", "-q", str(self.repo), str(applied)], check=True)
        subprocess.run(["git", "-C", str(applied), "apply", "--check", "-"],
                       input=result["result"]["patch"], text=True, check=True)
        self.cli("publish", job, "--grant", str(path))
        self.assertEqual(self.api("/status")["grants"][0]["jobs_left"], 0)
        with closing(sqlite3.connect(self.state / "queue.sqlite3")) as db:
            self.assertNotIn(grant["token"], str(db.execute("SELECT * FROM grants").fetchall()))

    def test_atomic_claims_and_project_scope(self):
        self.cli("project", "other", "--repo", str(self.repo))
        other_job = self.task(project="other")
        job = self.task()
        grants = [self.grant()[1] for _ in range(5)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            claimed = list(pool.map(lambda g: self.api("/claim", {"seconds": 5}, g["token"]), grants))
        winners = [i for i, response in enumerate(claimed) if response["job"]]
        self.assertEqual(len(winners), 1)
        self.assertEqual(claimed[winners[0]]["job"]["id"], job)
        loser = grants[(winners[0] + 1) % 5]
        with self.assertRaisesRegex(ValueError, "403"):
            self.api("/complete", {"id": job, "result": {"status": "completed"}}, loser["token"])
        with self.assertRaisesRegex(ValueError, "401"):
            self.api("/status", token=loser["token"])
        self.assertEqual(self.api("/jobs/" + other_job)["status"], "queued")

    def test_donor_read_only_choice_and_revocation(self):
        job = self.task("EDIT", "workspace-write")
        path, grant = self.grant()
        self.assertIn("No compatible", self.worker(path).stdout)
        self.assertEqual(self.api("/jobs/" + job)["status"], "queued")
        self.cli("revoke", grant["id"])
        self.worker(path, "--sandbox", "workspace-write", ok=False)
        self.assertEqual(self.api("/jobs/" + job)["status"], "queued")

    def test_failed_run_is_recorded_and_not_retried(self):
        job = self.task("FAIL")
        path, _ = self.grant(jobs=2)
        self.worker(path, ok=False)
        result = self.api("/jobs/" + job)
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["result"]["usage"])
        self.assertIn("Fixture usage limit", result["result"]["error"])
        self.assertIn("No compatible", self.worker(path).stdout)

    def test_runtime_cap_kills_child_process_and_records_timeout(self):
        job = self.task("TIMEOUT")
        path, _ = self.grant(seconds=1)
        started = time.monotonic()
        self.worker(path, ok=False)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.api("/jobs/" + job)["status"], "timed_out")
        self.assert_child_stopped(job)

    def test_expired_job_cannot_be_claimed_again(self):
        job = self.task()
        _, grant = self.grant(jobs=2)
        self.api("/claim", {"seconds": 1}, grant["token"])
        with closing(sqlite3.connect(self.state / "queue.sqlite3")) as db:
            db.execute("UPDATE jobs SET deadline=0 WHERE id=?", (job,))
            db.commit()
        self.assertIsNone(self.api("/claim", {"seconds": 1}, grant["token"])["job"])
        self.assertEqual(self.api("/jobs/" + job)["status"], "expired")


if __name__ == "__main__":
    unittest.main()
