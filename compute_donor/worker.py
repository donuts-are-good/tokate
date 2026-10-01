import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Coordinator redirects are not allowed")


def request(url, token, path, body=None):
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Use a coordinator origin without credentials, path, query, or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Remote coordinators require HTTPS")
    data = json.dumps(body).encode() if body is not None else None
    req = Request(url.rstrip("/") + path, data=data,
                  headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect).open(req, timeout=20) as response:
            return json.load(response)
    except HTTPError as error:
        with error:
            raise ValueError(f"Coordinator {error.code}: {error.read().decode()}") from None


def git(repo, *args, timeout=30):
    return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
                          check=True, capture_output=True, text=True, timeout=timeout).stdout


def codex_environment():
    allowed = {"HOME", "USER", "PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME",
               "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
               "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"}
    return {key: value for key, value in os.environ.items() if key in allowed}


def check_login(codex):
    result = subprocess.run([codex, "login", "status"], capture_output=True, text=True,
                            timeout=15, env=codex_environment())
    if result.returncode or "Logged in using ChatGPT" not in result.stdout + result.stderr:
        raise ValueError("This worker requires a ChatGPT subscription login. Run: codex login")


def stop_process(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    except ProcessLookupError:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def execute(job, repo, run_dir, codex, model=None):
    started = time.monotonic()
    run_dir.mkdir(parents=True, mode=0o700)
    checkout = run_dir / "checkout"
    result = {"status": "failed", "report": "", "patch": "", "usage": None,
              "revision": job["revision"], "error": None}
    process = None
    try:
        remaining = lambda: max(0.01, job["seconds"] - (time.monotonic() - started))
        git(run_dir, "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", str(repo), str(checkout),
            timeout=remaining())
        git(checkout, "checkout", "--quiet", "--detach", job["revision"], timeout=remaining())
        git(checkout, "remote", "remove", "origin", timeout=remaining())
        prompt = ("You are running a maintainer's task using donated compute. Work only in this checkout. "
                  "Do not access donor credentials, account configuration, or files outside this checkout. "
                  "Do not push, publish, contact people, or spawn other agents. "
                  "Return the requested artifact in your final response. "
                  "For edits, leave changes uncommitted. "
                  f"Sandbox: {job['mode']}.\n\n{job['prompt']}")
        command = [codex, "exec", "--ignore-user-config", "--ephemeral", "--json",
                   "--sandbox", job["mode"], "-c", 'approval_policy="never"',
                   "-c", 'web_search="disabled"', "--cd", str(checkout),
                   "--output-last-message", str(run_dir / "report.md")]
        if model:
            command += ["--model", model]
        command.append("-")
        with (run_dir / "events.jsonl").open("w") as events, (run_dir / "stderr.log").open("w") as errors:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=events, stderr=errors,
                                       env=codex_environment(), start_new_session=True, text=True)
            try:
                process.communicate(prompt, timeout=remaining())
            except subprocess.TimeoutExpired:
                result["status"] = "timed_out"
                result["error"] = "Donor runtime limit reached"
                stop_process(process)
            except BaseException:
                stop_process(process)
                raise
        if result["status"] != "timed_out":
            result["error"] = f"Codex exited with code {process.returncode}" if process.returncode else None
        completed = False
        usage = {}
        for line in (run_dir / "events.jsonl").read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "turn.completed":
                completed = True
                for key, value in (event.get("usage") or {}).items():
                    if type(value) is int:
                        usage[key] = usage.get(key, 0) + value
            if event.get("type") == "turn.failed":
                result["error"] = str(event.get("error", "Codex turn failed"))
        result["usage"] = usage or None
        report = run_dir / "report.md"
        result["report"] = report.read_text() if report.exists() else ""
        if completed and not result["error"] and result["report"].strip():
            result["status"] = "completed"
        elif not result["error"]:
            result["error"] = "Codex did not return a completed turn with a report"
        if job["mode"] == "workspace-write":
            git(checkout, "add", "-A", timeout=10)
            result["patch"] = git(checkout, "diff", "--cached", "--binary", job["revision"], timeout=10)
            (run_dir / "changes.patch").write_text(result["patch"])
    except subprocess.TimeoutExpired:
        result["status"], result["error"] = "timed_out", "Donor runtime limit reached during checkout"
    except (OSError, subprocess.CalledProcessError) as error:
        result["error"] = str(error)
    result["seconds"] = round(time.monotonic() - started, 3)
    (run_dir / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def work(args):
    grant = json.loads(args.grant.read_text())
    project = grant["project"]
    repo = args.repo.expanduser().resolve()
    revision = project["revision"]
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
        raise ValueError("Grant must pin a full commit hash")
    git(repo, "cat-file", "-e", revision + "^{commit}")
    check_login(args.codex)
    args.runs.mkdir(parents=True, exist_ok=True, mode=0o700)
    deadline = time.monotonic() + args.seconds
    print(f"Donating to {project['name']} at {revision[:12]}: up to {args.jobs} jobs / {args.seconds}s", flush=True)
    for _ in range(args.jobs):
        seconds = int(deadline - time.monotonic())
        if seconds < 1:
            break
        claimed = request(grant["url"], grant["token"], "/claim",
                          {"mode": args.sandbox, "seconds": min(seconds, 3600)})
        job = claimed["job"]
        if job is None:
            print(claimed["reason"])
            break
        if (job["project"] != project["name"] or job["revision"] != revision
                or job["mode"] not in ("read-only", args.sandbox)
                or not re.fullmatch(r"[0-9a-f]{16}", job["id"])):
            raise ValueError("Coordinator returned a job outside this donation's scope")
        job["seconds"] = min(int(job["seconds"]), seconds, grant["task_seconds"])
        run_dir = args.runs.resolve() / job["id"]
        print(f"Running {job['id']} ({job['mode']}, {job['seconds']}s cap)", flush=True)
        result = execute(job, repo, run_dir, args.codex, args.model)
        request(grant["url"], grant["token"], "/complete", {"id": job["id"], "result": result})
        print(f"{result['status']}: {run_dir / 'receipt.json'}", flush=True)
        if result["status"] != "completed":
            raise ValueError(result["error"] or "Job failed")
