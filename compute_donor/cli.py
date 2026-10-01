import argparse
import json
import subprocess
from pathlib import Path
from urllib.error import URLError

from .queue import Queue, private_write, server
from .worker import git, request, work
from . import github


def positive(value):
    value = int(value)
    if value <= 0:
        raise argparse.ArgumentTypeError("Must be positive")
    return value


def main():
    parser = argparse.ArgumentParser(description="Donate local Codex runs to a project task queue")
    parser.add_argument("--state", type=Path, default=Path(".state"))
    parser.add_argument("--url", default="http://127.0.0.1:8768")
    commands = parser.add_subparsers(dest="command", required=True)
    github.configure(commands, positive)
    commands.add_parser("init", help="Create the local queue and admin credential")
    serve = commands.add_parser("serve", help="Run the coordinator")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8768)
    project = commands.add_parser("project", help="Register a project at a fixed commit")
    project.add_argument("name")
    project.add_argument("--repo", type=Path, required=True)
    project.add_argument("--revision", default="HEAD")
    submit = commands.add_parser("submit", help="Queue a maintainer task")
    submit.add_argument("project")
    submit.add_argument("--prompt-file", type=Path, required=True)
    submit.add_argument("--mode", choices=["read-only", "workspace-write"], default="read-only")
    grant = commands.add_parser("grant", help="Issue a project-scoped worker credential")
    grant.add_argument("project")
    grant.add_argument("--donor", required=True)
    grant.add_argument("--jobs", type=positive, default=1)
    grant.add_argument("--task-seconds", type=positive, default=180)
    grant.add_argument("--out", type=Path, required=True)
    worker = commands.add_parser("work", help="Run queued tasks using your local ChatGPT login")
    worker.add_argument("--grant", type=Path, required=True)
    worker.add_argument("--repo", type=Path, required=True)
    worker.add_argument("--jobs", type=positive, default=1)
    worker.add_argument("--seconds", type=positive, default=180)
    worker.add_argument("--sandbox", choices=["read-only", "workspace-write"], default="read-only")
    worker.add_argument("--runs", type=Path, default=Path(".runs"))
    worker.add_argument("--codex", default="codex")
    worker.add_argument("--model")
    commands.add_parser("status", help="Show projects, grants, and jobs")
    show = commands.add_parser("show", help="Read a task and its returned artifact")
    show.add_argument("id")
    revoke = commands.add_parser("revoke", help="Prevent a donor grant from claiming further jobs")
    revoke.add_argument("id")
    publish = commands.add_parser("publish", help="Retry uploading a locally saved receipt")
    publish.add_argument("id")
    publish.add_argument("--grant", type=Path, required=True)
    publish.add_argument("--runs", type=Path, default=Path(".runs"))
    args = parser.parse_args()
    try:
        if args.command == "github":
            print(json.dumps(github.dispatch(args), indent=2))
            return
        if args.command == "init":
            Queue(args.state)
            print(f"Queue ready: {args.state.resolve()}")
            return
        if args.command == "serve":
            with server(args.state, args.host, args.port) as http:
                print(f"Coordinator listening on http://{args.host}:{http.server_port}", flush=True)
                http.serve_forever()
            return
        if args.command == "work":
            work(args)
            return
        if args.command == "publish":
            grant = json.loads(args.grant.read_text())
            result = json.loads((args.runs / args.id / "receipt.json").read_text())
            output = request(grant["url"], grant["token"], "/complete", {"id": args.id, "result": result})
        else:
            token = (args.state / "admin.token").read_text().strip()
            if args.command == "project":
                repo = args.repo.expanduser().resolve()
                revision = git(repo, "rev-parse", "--verify", "--end-of-options", args.revision + "^{commit}").strip()
                output = request(args.url, token, "/projects", {"name": args.name, "repo": str(repo), "revision": revision})
            elif args.command == "submit":
                output = request(args.url, token, "/jobs", {"project": args.project,
                                 "prompt": args.prompt_file.read_text(), "mode": args.mode})
            elif args.command == "grant":
                if args.out.exists():
                    raise ValueError("Grant file already exists. Choose a new path.")
                output = request(args.url, token, "/grants", {"project": args.project, "donor": args.donor,
                                 "jobs": args.jobs, "task_seconds": args.task_seconds})
                private_write(args.out, json.dumps({**output, "url": args.url}, indent=2) + "\n")
                output = {"id": output["id"], "saved": str(args.out), "project": args.project}
            elif args.command == "revoke":
                output = request(args.url, token, "/revoke", {"id": args.id})
            else:
                output = request(args.url, token, "/status" if args.command == "status" else "/jobs/" + args.id)
        print(json.dumps(output, indent=2))
    except (OSError, ValueError, subprocess.SubprocessError, URLError) as error:
        parser.exit(1, f"Error: {error}\n")
    except KeyboardInterrupt:
        parser.exit(130, "Stopped. Interrupted jobs expire without automatic retry.\n")
