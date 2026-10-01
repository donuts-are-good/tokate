import json
import os
import re
import secrets
import subprocess
import time
from pathlib import Path
from urllib.parse import quote, urlencode

from .worker import check_login, execute, git


APPROVED = "compute:approved"


class GitHub:
    def __init__(self, executable="gh"):
        self.executable = executable

    def command(self, *args, data=None, allowed=(0,)):
        result = subprocess.run([self.executable, *args], input=data, text=True,
                                capture_output=True, timeout=60,
                                env={**os.environ, "GH_PROMPT_DISABLED": "1"})
        if result.returncode not in allowed:
            raise ValueError(result.stderr.strip() or result.stdout.strip() or "GitHub request failed")
        return result

    def api(self, path, body=None, method=None, missing=False):
        args = ["api", "--hostname", "github.com", "--method", method or ("POST" if body is not None else "GET"), path]
        if body is not None:
            args += ["--input", "-"]
        result = self.command(*args, data=json.dumps(body) if body is not None else None, allowed=(0, 1))
        if result.returncode:
            if missing and "HTTP 404" in result.stderr:
                return None
            raise ValueError(result.stderr.strip() or "GitHub request failed")
        return json.loads(result.stdout) if result.stdout.strip() else None


def repository(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise ValueError("Use a GitHub repository in OWNER/REPO form")
    return value


def issue_path(repo, number):
    return f"repos/{repository(repo)}/issues/{int(number)}"


def open_issue(client, repo, number):
    issue = client.api(issue_path(repo, number))
    if issue["state"] != "open" or "pull_request" in issue:
        raise ValueError("Choose an open issue, not a pull request")
    return issue


def authorized_issue(client, repo, number, login):
    issue = open_issue(client, repo, number)
    if APPROVED not in [label["name"] for label in issue["labels"]]:
        raise ValueError(f"Issue #{number} needs the {APPROVED} label from a maintainer")
    if login.lower() not in [a["login"].lower() for a in issue["assignees"]]:
        raise ValueError(f"Issue #{number} is not assigned to the signed-in donor {login}")
    return issue


def approve(args):
    client = GitHub(args.gh)
    repo = repository(args.repo)
    info = client.api(f"repos/{repo}")
    if not info.get("permissions", {}).get("push"):
        raise ValueError("Approving donor work requires repository write permission")
    open_issue(client, repo, args.issue)
    donor = client.api("user")["login"] if args.donor == "@me" else args.donor
    if not re.fullmatch(r"[A-Za-z0-9-]+", donor):
        raise ValueError("Use a GitHub username for the donor")
    label_path = f"repos/{repo}/labels/{quote(APPROVED, safe='')}"
    if client.api(label_path, missing=True) is None:
        client.api(f"repos/{repo}/labels", {"name": APPROVED, "color": "0e8a16",
                                          "description": "Maintainer approved for an assigned compute donor"})
    assigned = client.api(issue_path(repo, args.issue) + "/assignees", {"assignees": [donor]})
    if donor.lower() not in [a["login"].lower() for a in assigned["assignees"]]:
        raise ValueError("GitHub did not assign this donor. Check their repository eligibility.")
    client.api(issue_path(repo, args.issue) + "/labels", {"labels": [APPROVED]})
    return {"issue": assigned["html_url"], "donor": donor, "approval": APPROVED}


def save_run(directory, run):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = directory / "github.json.tmp"
    temporary.write_text(json.dumps(run, indent=2) + "\n")
    temporary.replace(directory / "github.json")


def find_pr(client, run):
    query = urlencode({"state": "all", "head": run["head_repo"].split("/")[0] + ":" + run["branch"],
                       "base": run["base_branch"]})
    pulls = client.api(f"repos/{run['repo']}/pulls?{query}")
    return pulls[0] if pulls else None


def work(args):
    client = GitHub(args.gh)
    repo = repository(args.repo)
    viewer = client.api("user")
    issue = authorized_issue(client, repo, args.issue, viewer["login"])
    info = client.api(f"repos/{repo}")
    head_repo = repository(args.fork or repo)
    head = info if head_repo == repo else client.api(f"repos/{head_repo}")
    if not head.get("permissions", {}).get("push"):
        raise ValueError("No push access. Create a fork and pass --fork YOUR_LOGIN/REPO")
    if head_repo != repo and head.get("parent", {}).get("full_name", "").lower() != repo.lower():
        raise ValueError("The head repository must be a fork of the selected upstream")
    check_login(args.codex)
    base = info["default_branch"]
    revision = client.api(f"repos/{repo}/commits/{quote(base, safe='')}")["sha"]
    run = {"repo": repo, "issue": args.issue, "issue_url": issue["html_url"],
           "issue_title": issue["title"], "issue_body": issue.get("body") or "",
           "donor": viewer["login"], "donor_id": viewer["id"], "head_repo": head_repo,
           "base_branch": base, "revision": revision, "branch": f"compute-donor/issue-{args.issue}",
           "model": args.model, "reasoning_effort": args.effort, "network": args.allow_network,
           "claimed": False, "commit": None, "pr_url": None, "pr_number": None}
    if find_pr(client, run):
        raise ValueError("This issue already has a donor PR. Inspect it before starting another run.")
    directory = args.runs.resolve() / f"github-{repo.replace('/', '-')}-{args.issue}-{secrets.token_hex(4)}"
    save_run(directory, run)
    client.api(f"repos/{head_repo}/git/refs", {"ref": "refs/heads/" + run["branch"], "sha": revision})
    run["claimed"] = True
    save_run(directory, run)
    prompt = (f"Implement GitHub issue {issue['html_url']} in this checkout.\n"
              f"Title: {issue['title']}\n\n{issue.get('body') or ''}\n\n"
              "Follow the repository's documented conventions and verification procedure. "
              "Run the applicable checks and fix failures introduced by your changes. "
              "Use a clean package cache under an ignored artifacts directory if cached dependencies "
              "conflict with lock files. Keep package versions unchanged for this PR. "
              "Report what changed, tests actually run, and any unresolved blockers. "
              "The caller will publish the PR. Do not commit, push, release, or merge anything.")
    if args.instructions_file:
        prompt += "\n\nAdditional maintainer instructions:\n" + args.instructions_file.read_text()
    job = {"revision": revision, "seconds": args.seconds, "mode": "workspace-write", "prompt": prompt}
    print(f"Claimed {run['issue_url']} for {run['donor']}; model={args.model}; run={directory}", flush=True)
    result = execute(job, f"https://github.com/{repo}.git", directory, args.codex,
                     args.model, args.effort, args.allow_network)
    if result["status"] != "completed":
        raise ValueError(f"{result['status']}: {result['error']}. Artifacts: {directory}")
    if not result["patch"]:
        raise ValueError(f"No changes returned; no PR created. Read {directory / 'report.md'}")
    return publish(directory, client)


def publish(directory, client):
    directory = directory.resolve()
    run = json.loads((directory / "github.json").read_text())
    repository(run["repo"])
    repository(run["head_repo"])
    viewer = client.api("user")
    if viewer["login"].lower() != run["donor"].lower():
        raise ValueError("Publish using the GitHub account that claimed this run")
    existing = find_pr(client, run)
    marker = f"<!-- compute-donor:{directory.name} -->"
    if existing:
        if marker not in (existing.get("body") or ""):
            raise ValueError("Another run already owns this donor PR")
        run["pr_url"], run["pr_number"] = existing["html_url"], existing["number"]
        save_run(directory, run)
        return {"pr": run["pr_url"], "run": str(directory), "state": existing["state"]}
    issue = authorized_issue(client, run["repo"], run["issue"], run["donor"])
    if issue["title"] != run["issue_title"] or (issue.get("body") or "") != run["issue_body"]:
        raise ValueError("Issue changed during the run. Review the saved patch before publishing.")
    result = json.loads((directory / "receipt.json").read_text())
    if result["status"] != "completed" or not result["patch"]:
        raise ValueError("Only completed runs with a patch can open a PR")
    checkout = directory / "checkout"
    if not run["commit"]:
        if git(checkout, "rev-parse", "HEAD").strip() != run["revision"]:
            raise ValueError("Checkout HEAD changed during execution; inspect it before publishing")
        git(checkout, "add", "-A")
        git(checkout, "diff", "--cached", "--check")
        git(checkout, "switch", "-c", run["branch"])
        git(checkout, "-c", "user.name=" + run["donor"],
            "-c", f"user.email={run['donor_id']}+{run['donor']}@users.noreply.github.com",
            "-c", "commit.gpgsign=false", "commit", "-m", run["issue_title"])
        run["commit"] = git(checkout, "rev-parse", "HEAD").strip()
        save_run(directory, run)
    if git(checkout, "rev-parse", "HEAD").strip() != run["commit"] or git(checkout, "status", "--porcelain").strip():
        raise ValueError("The saved donor commit or checkout changed; inspect before publishing")
    remote = client.api(f"repos/{run['head_repo']}/git/ref/heads/{run['branch']}")["object"]["sha"]
    if remote not in (run["revision"], run["commit"]):
        raise ValueError("The remote donor branch changed; refusing to overwrite it")
    git(checkout, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
        "push", f"https://github.com/{run['head_repo']}.git", f"HEAD:refs/heads/{run['branch']}", timeout=60)
    body = (f"Fixes #{run['issue']}\n\n{result['report']}\n\n"
            f"Donated by `{run['donor']}` using `{run['model']}`. "
            f"Agent runtime: {result['seconds']} seconds.\n\n"
            f"Usage reported by Codex: `{json.dumps(result['usage'], sort_keys=True)}`.\n\n"
            "GitHub CI is authoritative for this PR's checks. Maintainer review and merge are required.\n\n" + marker)
    (directory / "pr-body.md").write_text(body + "\n")
    pull = client.api(f"repos/{run['repo']}/pulls", {"title": run["issue_title"], "body": body,
                      "head": run["head_repo"].split("/")[0] + ":" + run["branch"],
                      "base": run["base_branch"], "maintainer_can_modify": True})
    run["pr_url"], run["pr_number"] = pull["html_url"], pull["number"]
    save_run(directory, run)
    return {"pr": run["pr_url"], "run": str(directory), "head": run["commit"], "checks": "pending"}


def checks(args):
    client = GitHub(args.gh)
    directory = args.run.resolve()
    run = json.loads((directory / "github.json").read_text())
    if not run["pr_number"]:
        raise ValueError("This run has no published PR")
    deadline = time.monotonic() + args.timeout
    previous = None
    while True:
        pull = client.api(f"repos/{run['repo']}/pulls/{run['pr_number']}")
        if pull["head"]["sha"] != run["commit"]:
            raise ValueError("PR head changed; these checks would not verify the saved donor commit")
        response = client.command("pr", "checks", str(run["pr_number"]), "--repo", run["repo"],
                                  "--json", "name,state,bucket,link,workflow", allowed=(0, 1, 8))
        if response.returncode == 1 and not response.stdout.strip().startswith("["):
            if "no checks reported" not in response.stderr.lower():
                raise ValueError(response.stderr.strip() or "Could not read PR checks")
            rows = []
        else:
            rows = json.loads(response.stdout)
        buckets = {r["bucket"] for r in rows}
        status = "failed" if buckets & {"fail", "cancel"} else (
            "passed" if rows and "pass" in buckets and buckets <= {"pass", "skipping"} else "pending")
        output = {"pr": run["pr_url"], "head": run["commit"], "status": status, "checks": rows}
        (directory / "checks.json").write_text(json.dumps(output, indent=2) + "\n")
        if status != previous:
            print(f"CI {status}: {run['pr_url']}", flush=True)
            previous = status
        if status == "failed":
            raise ValueError(f"PR checks failed. Details: {directory / 'checks.json'}")
        if status == "passed" or not args.watch or time.monotonic() >= deadline:
            return output
        time.sleep(min(10, max(0, deadline - time.monotonic())))


def configure(commands, positive):
    parser = commands.add_parser("github", help="Approve upstream issues, donate work, and open PRs")
    parser.add_argument("--gh", default="gh")
    sub = parser.add_subparsers(dest="github_command", required=True)
    approval = sub.add_parser("approve", help="Label an issue and assign its donor")
    approval.add_argument("--repo", required=True, type=repository)
    approval.add_argument("--issue", required=True, type=positive)
    approval.add_argument("--donor", required=True)
    worker = sub.add_parser("work", help="Claim an approved issue, run Codex, and open a PR")
    worker.add_argument("--repo", required=True, type=repository)
    worker.add_argument("--issue", required=True, type=positive)
    worker.add_argument("--fork", type=repository)
    worker.add_argument("--model", required=True)
    worker.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max", "ultra"])
    worker.add_argument("--seconds", type=positive, default=1800)
    worker.add_argument("--codex", default="codex")
    worker.add_argument("--runs", type=Path, default=Path(".runs"))
    worker.add_argument("--allow-network", action="store_true")
    worker.add_argument("--instructions-file", type=Path)
    upload = sub.add_parser("publish", help="Retry publication of a saved donor run")
    upload.add_argument("--run", type=Path, required=True)
    status = sub.add_parser("checks", help="Inspect CI for the saved donor commit")
    status.add_argument("--run", type=Path, required=True)
    status.add_argument("--watch", action="store_true")
    status.add_argument("--timeout", type=positive, default=1200)


def dispatch(args):
    if args.github_command == "approve":
        return approve(args)
    if args.github_command == "work":
        return work(args)
    if args.github_command == "publish":
        return publish(args.run, GitHub(args.gh))
    return checks(args)
