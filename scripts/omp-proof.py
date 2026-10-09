import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description="Synthetic native OMP SDK proof; installs nothing and never performs inference.")
    parser.add_argument("--omp-root", required=True, type=Path, help="Installed node_modules directory containing the normal OMP package")
    parser.add_argument("--bun", required=True, type=Path)
    parser.add_argument("--tests", type=Path, default=Path("tests/bin/Release/net10.0/linux-x64/tokate-tests"))
    parser.add_argument("--release-record", type=Path, help="Official latest release response resolved once before this invocation")
    parser.add_argument("--case", action="append", help="Run selected synthetic cases for source validation only")
    options = parser.parse_args()
    checkout = Path(__file__).resolve().parent.parent
    package_root = options.omp_root.resolve(strict=True)
    bun = options.bun.resolve(strict=True)
    tests = options.tests.resolve(strict=True)
    metadata = json.loads((package_root / "@oh-my-pi/pi-coding-agent/package.json").read_text())
    require(metadata.get("name") == "@oh-my-pi/pi-coding-agent" and metadata.get("version"), "Supply the normal installed OMP SDK")
    if options.release_record:
        require(options.release_record.stat().st_size <= 1024 * 1024, "Release record exceeded the discovery bound")
        release = json.loads(options.release_record.read_text())
    else:
        response = subprocess.run([
            "/usr/bin/curl", "-qfsS", "--max-time", "15", "--max-filesize", "1048576",
            "--max-redirs", "0", "--proto", "=https", "--write-out", "%{http_code}",
            "https://api.github.com/repos/can1357/oh-my-pi/releases/latest",
        ], env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, capture_output=True, timeout=20)
        require(response.returncode == 0 and response.stdout[-3:] == b"200", "Official release discovery refused a redirect or error")
        require(len(response.stdout) <= 1024 * 1024 + 3, "Official release response exceeded the discovery bound")
        release = json.loads(response.stdout[:-3])
    require(release.get("tag_name", "").startswith("v") and release.get("draft") is False and release.get("prerelease") is False,
            "Missing stable official release evidence")
    with bun.open("rb") as runtime_file:
        runtime_hash = hashlib.sha256()
        for chunk in iter(lambda: runtime_file.read(1024 * 1024), b""):
            runtime_hash.update(chunk)
        runtime_digest = runtime_hash.hexdigest()
    print(json.dumps({"official_release": release["tag_name"], "tested_package": metadata["version"],
                      "bun_sha256": runtime_digest}), flush=True)
    spec = importlib.util.spec_from_file_location("native_proof", checkout / "scripts/native-proof.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    cases = ["missing", "invalid", "ambiguous", "unconfigured", "unknown-settings", "boundary", "unsupported", "stop", "tools", "network-tool", "length", "truncated-tool", "empty",
             "incomplete", "malformed", "bad-usage", "missing-usage", "overflow-usage", "error401", "error404", "error429", "error503", "effort-error", "redirect", "cancel", "cleanup-stop", "cleanup-cancel", "command-cancel", "command-timeout"]
    full = not options.case
    if options.case:
        require(set(options.case) <= set(cases), "Unknown native proof case")
        cases = options.case
    blockers = []
    blocked_cases = []
    failures = []
    deadline = time.monotonic() + 600
    with tempfile.TemporaryDirectory(prefix=".omp-proof-", dir=checkout) as directory:
        root = Path(directory)
        root.chmod(0o700)
        control = root / "control"
        control.mkdir()
        shutil.copyfile(checkout / "scripts/omp-proof.mjs", control / "proof.mjs")
        (control / "descendant.py").write_text("""import os, sys, time
if os.fork():
    sys.exit(0)
os.setsid()
if os.fork():
    sys.exit(0)
for descriptor in (0, 1, 2):
    os.dup2(os.open('/dev/null', os.O_RDWR), descriptor)
with open(sys.argv[1] + '/descendant-ready', 'w') as ready:
    ready.write('ready')
while True:
    with open(sys.argv[1] + '/descendant-heartbeat', 'a') as heartbeat:
        heartbeat.write('alive\\n')
    time.sleep(0.02)
""")
        sentinel = root / "synthetic-home/private"
        sentinel.parent.mkdir()
        sentinel.write_text("synthetic-private-sentinel")
        sentinel.with_suffix(".json").write_text(json.dumps({"value": "synthetic-private-sentinel"}))
        for case in cases:
            require(time.monotonic() < deadline, "Native proof exceeded its total deadline")
            work = root / case
            work.mkdir()
            (work / ".git").mkdir()
            (work / ".git/config").write_text("synthetic-private-sentinel")
            (work / "escape").symlink_to(sentinel)
            if case == "boundary":
                (work / "large.txt").write_text("".join(f"line-{i} " + "x" * 70 + "\n" for i in range(1, 100001)))
                (work / "helper.json").write_text(json.dumps({"value": "native-helper"}))
            if case.startswith(("cleanup-", "command-")):
                shutil.copyfile(control / "descendant.py", work / "descendant.py")
            before = sentinel.read_bytes()
            before_json = sentinel.with_suffix(".json").read_bytes()
            boundary = subprocess.run([str(tests), "--omp-boundary", str(work), str(package_root), str(bun), str(control)],
                                      env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, capture_output=True, timeout=10)
            require(boundary.returncode == 0, "Cannot obtain the existing SDK process boundary")
            args = json.loads(boundary.stdout)
            require(args[-1] == "--" and "--unshare-net" in args and "--unshare-pid" in args, "Incomplete SDK process boundary")
            command = ["/usr/bin/bwrap", *args, "/tokate-node", "/tokate-control/proof.mjs", case, str(work), str(sentinel)]
            try:
                owned = native.Owned(command, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, str(work), mounts=(package_root, bun))
                code, stdout, stderr = owned.run(seconds=min(30, deadline - time.monotonic()))
                records = [json.loads(line) for line in stdout.splitlines() if line.startswith('{')]
                if records and records[0].get("type") == "omp.failure":
                    print(json.dumps(records[0]), flush=True)
                require(code == 0 and len(records) == 1 and records[0].get("type") == "omp.proof", "Native case did not provide settled evidence")
                record = records[0]
                require(record["package"] == metadata["version"], "Native package version evidence disagrees with the installation")
                require(sentinel.read_bytes() == before and sentinel.with_suffix(".json").read_bytes() == before_json and
                        (work / ".git/config").read_text() == "synthetic-private-sentinel", "Protected sentinels changed")
                if case.startswith(("cleanup-", "command-")):
                    require((work / "descendant-ready").is_file(), "Missing descendant readiness evidence")
                    heartbeat = work / "descendant-heartbeat"
                    before_cleanup = heartbeat.read_bytes()
                    time.sleep(0.15)
                    require(heartbeat.read_bytes() == before_cleanup, "Descendant survived the owned PID namespace")
                    record["descendants_cleaned"] = True
                if "completion_candidate" in record:
                    record["completed_after_cleanup"] = record.pop("completion_candidate")
                record["output_drained"] = True
                record["status"] = "blocked" if record["blockers"] else "passed"
                if record["blockers"]:
                    blocked_cases.append(case)
                blockers.extend(record["blockers"])
                print(json.dumps(record), flush=True)
            except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError) as error:
                failures.append(case)
                print(json.dumps({"type": "omp.failure", "mode": case, "reason": type(error).__name__}), flush=True)
        print(json.dumps({"type": "omp.result", "passed_cases": len(cases) - len(failures) - len(blocked_cases), "failed_cases": failures, "blocked_cases": blocked_cases,
                          "blockers": blockers, "all_cases_run": full, "managed_support": False}), flush=True)
    return 1 if failures or blockers else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError):
        print("BLOCKED: Native OMP proof prerequisite failed; no retry was attempted.", file=sys.stderr)
        sys.exit(1)
