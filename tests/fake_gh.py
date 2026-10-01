#!/usr/bin/env python3
import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

fixture = Path(os.environ["COMPUTE_DONOR_TEST_FIXTURE"])


def git(*args):
    return subprocess.check_output(["git", "--git-dir", str(fixture / "remote.git"), *args],
                                   text=True, stderr=subprocess.DEVNULL).strip()


with (fixture / "lock").open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads((fixture / "github.json").read_text())
    args = sys.argv[1:]
    code = 0
    output = None
    if args[:2] == ["pr", "checks"]:
        output = state.get("checks", [{"name": "verify", "bucket": "pass", "state": "SUCCESS",
                                       "link": "https://github.com/fixture/widgets/actions/runs/1", "workflow": "CI"}])
    else:
        method = args[args.index("--method") + 1]
        path = unquote(urlsplit(args[args.index("--method") + 2]).path)
        body = json.load(sys.stdin) if "--input" in args else None
        issue = state["issue"]
        if path == "user":
            output = {"login": "donor", "id": 123}
        elif path == "repos/fixture/widgets":
            output = {"default_branch": "main", "permissions": {"push": True}}
        elif path == "repos/fixture/widgets/commits/main":
            output = {"sha": git("rev-parse", "main")}
        elif path == "repos/fixture/widgets/issues/18":
            state["reads"] = state.get("reads", 0) + 1
            if state.get("revoke_at") == state["reads"]:
                issue["labels"] = []
            output = issue
        elif path.endswith("/issues/18/assignees"):
            issue["assignees"] = [{"login": login} for login in body["assignees"]]
            output = issue
        elif path.endswith("/issues/18/labels"):
            issue["labels"] = [{"name": name} for name in body["labels"]]
            output = issue["labels"]
        elif path.endswith("/labels/compute:approved"):
            if not state.get("label"):
                code = 1
                print("Not Found (HTTP 404)", file=sys.stderr)
            else:
                output = {"name": "compute:approved"}
        elif path == "repos/fixture/widgets/labels":
            state["label"] = True
            output = body
        elif path.endswith("/git/refs"):
            try:
                git("update-ref", body["ref"], body["sha"], "0" * 40)
                output = {"ref": body["ref"], "object": {"sha": body["sha"]}}
            except subprocess.CalledProcessError:
                code = 1
                print("Reference already exists (HTTP 422)", file=sys.stderr)
        elif "/git/ref/" in path:
            output = {"object": {"sha": git("rev-parse", "refs/" + path.split("/git/ref/", 1)[1])}}
        elif path == "repos/fixture/widgets/pulls":
            if method == "POST":
                state["pr"] = {**body, "number": 19, "html_url": "https://github.com/fixture/widgets/pull/19",
                               "state": "open", "head": {"sha": git("rev-parse", body["head"].split(":")[1])}}
                state["pr_creates"] = state.get("pr_creates", 0) + 1
                output = state["pr"]
            else:
                output = [state["pr"]] if state.get("pr") else []
        elif path == "repos/fixture/widgets/pulls/19":
            output = state["pr"]
        else:
            print(f"Unexpected fixture request: {method} {path}", file=sys.stderr)
            code = 1
    (fixture / "github.json").write_text(json.dumps(state))
    if output is not None:
        print(json.dumps(output))
    sys.exit(code)
