import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Rejected(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def require(condition, message, status=400):
    if not condition:
        raise Rejected(status, message)


def integer(value, minimum, maximum):
    require(type(value) is int and minimum <= value <= maximum,
            f"Expected an integer between {minimum} and {maximum}")
    return value


def string(value, maximum=10000):
    require(isinstance(value, str) and 0 < len(value.strip()) <= maximum,
            f"Expected nonempty text of at most {maximum} characters")
    return value


def private_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write(text)


class Queue:
    def __init__(self, state):
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        token_path = self.state / "admin.token"
        if not token_path.exists():
            private_write(token_path, secrets.token_urlsafe(32))
        self.admin_token = token_path.read_text().strip()
        if len(self.admin_token) < 32:
            raise ValueError("Invalid admin.token: expected a securely generated credential")
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    name TEXT PRIMARY KEY, repo TEXT NOT NULL, revision TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS grants (
                    id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(name),
                    donor TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
                    jobs_left INTEGER NOT NULL, task_seconds INTEGER NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(name),
                    prompt TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
                    created REAL NOT NULL, grant_id TEXT REFERENCES grants(id),
                    started REAL, deadline REAL, finished REAL, result TEXT
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.state / "queue.sqlite3", timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def dispatch(self, method, path, token, body):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if path in ("/claim", "/complete"):
                grant = db.execute("SELECT * FROM grants WHERE token_hash=? AND revoked=0",
                                   (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
                require(grant is not None, "Invalid or revoked donor grant", 401)
                if path == "/claim" and method == "POST":
                    return self.claim(db, grant, body)
                if path == "/complete" and method == "POST":
                    return self.complete(db, grant, body)
                raise Rejected(404, "Unknown endpoint")
            require(hmac.compare_digest(token, self.admin_token), "Admin token required", 401)
            self.expire(db)
            if method == "GET" and path == "/status":
                return {
                    "projects": [dict(r) for r in db.execute("SELECT * FROM projects")],
                    "grants": [dict(r) for r in db.execute(
                        "SELECT id,project,donor,jobs_left,task_seconds,revoked FROM grants")],
                    "jobs": [dict(r) for r in db.execute(
                        "SELECT id,project,mode,status,grant_id,created,started,finished FROM jobs ORDER BY created")],
                }
            if method == "GET" and path.startswith("/jobs/"):
                row = db.execute("SELECT * FROM jobs WHERE id=?", (path[6:],)).fetchone()
                require(row is not None, "Job not found", 404)
                job = dict(row)
                job["result"] = json.loads(job["result"]) if job["result"] else None
                return job
            require(method == "POST", "Unknown endpoint", 404)
            if path == "/projects":
                name = string(body.get("name"), 80)
                require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name), "Invalid project name")
                revision = string(body.get("revision"), 64)
                require(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision), "Use a full commit hash")
                db.execute("INSERT INTO projects VALUES (?,?,?)",
                           (name, string(body.get("repo"), 2000), revision))
                return {"project": name, "revision": revision}
            if path == "/jobs":
                project = self.project(db, body)
                mode = body.get("mode", "read-only")
                require(mode in ("read-only", "workspace-write"), "Invalid sandbox mode")
                job_id = secrets.token_hex(8)
                db.execute("INSERT INTO jobs(id,project,prompt,mode,status,created) VALUES (?,?,?,?,?,?)",
                           (job_id, project["name"], string(body.get("prompt")), mode, "queued", time.time()))
                return {"id": job_id, "status": "queued"}
            if path == "/grants":
                project = self.project(db, body)
                grant_id, token = secrets.token_hex(8), secrets.token_urlsafe(32)
                jobs = integer(body.get("jobs"), 1, 1000)
                seconds = integer(body.get("task_seconds"), 1, 3600)
                db.execute("INSERT INTO grants(id,project,donor,token_hash,jobs_left,task_seconds) VALUES (?,?,?,?,?,?)",
                           (grant_id, project["name"], string(body.get("donor"), 100),
                            hashlib.sha256(token.encode()).hexdigest(), jobs, seconds))
                return {"id": grant_id, "project": dict(project), "token": token,
                        "jobs": jobs, "task_seconds": seconds}
            if path == "/revoke":
                changed = db.execute("UPDATE grants SET revoked=1 WHERE id=?", (body.get("id"),)).rowcount
                require(changed, "Grant not found", 404)
                return {"revoked": body["id"]}
            raise Rejected(404, "Unknown endpoint")

    def project(self, db, body):
        row = db.execute("SELECT * FROM projects WHERE name=?", (body.get("project"),)).fetchone()
        require(row is not None, "Project not found", 404)
        return row

    def expire(self, db):
        db.execute("UPDATE jobs SET status='expired',finished=? WHERE status='running' AND deadline<?",
                   (time.time(), time.time()))

    def claim(self, db, grant, body):
        self.expire(db)
        mode = body.get("mode", "read-only")
        require(mode in ("read-only", "workspace-write"), "Invalid sandbox mode")
        seconds = min(integer(body.get("seconds"), 1, 3600), grant["task_seconds"])
        if grant["jobs_left"] <= 0:
            return {"job": None, "reason": "Grant exhausted"}
        active = db.execute("SELECT 1 FROM jobs WHERE grant_id=? AND status='running'", (grant["id"],)).fetchone()
        require(not active, "This grant already has a running job", 409)
        row = db.execute("""SELECT jobs.*,projects.repo,projects.revision FROM jobs
            JOIN projects ON projects.name=jobs.project WHERE project=? AND status='queued'
            AND (mode='read-only' OR mode=?) ORDER BY created LIMIT 1""", (grant["project"], mode)).fetchone()
        if row is None:
            return {"job": None, "reason": "No compatible queued jobs"}
        started = time.time()
        db.execute("UPDATE jobs SET status='running',grant_id=?,started=?,deadline=? WHERE id=?",
                   (grant["id"], started, started + seconds + 30, row["id"]))
        db.execute("UPDATE grants SET jobs_left=jobs_left-1 WHERE id=?", (grant["id"],))
        return {"job": {**dict(row), "status": "running", "seconds": seconds}}

    def complete(self, db, grant, body):
        job = db.execute("SELECT * FROM jobs WHERE id=? AND grant_id=?",
                         (body.get("id"), grant["id"])).fetchone()
        require(job is not None, "Job does not belong to this grant", 403)
        result = body.get("result")
        require(isinstance(result, dict), "Expected a result object")
        status = result.get("status")
        require(status in ("completed", "failed", "timed_out"), "Invalid result status")
        encoded = json.dumps(result)
        if job["result"] == encoded:
            return {"id": job["id"], "status": job["status"]}
        require(job["status"] == "running" and time.time() <= job["deadline"], "Job lease ended", 409)
        db.execute("UPDATE jobs SET status=?,finished=?,result=? WHERE id=?",
                   (status, time.time(), encoded, job["id"]))
        return {"id": job["id"], "status": status}


def server(state, host="127.0.0.1", port=8768):
    queue = Queue(state)

    class Handler(BaseHTTPRequestHandler):
        def handle_request(self):
            self.connection.settimeout(15)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                require(0 <= size <= 4_000_000, "Request too large", 413)
                body = json.loads(self.rfile.read(size)) if size else {}
                require(isinstance(body, dict), "Expected a JSON object")
                token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                result = queue.dispatch(self.command, self.path, token, body)
                status = 200
            except Rejected as error:
                status, result = error.status, {"error": str(error)}
            except (ValueError, TypeError):
                status, result = 400, {"error": "Invalid request"}
            except sqlite3.IntegrityError:
                status, result = 409, {"error": "Already exists or invalid project reference"}
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = handle_request
        do_POST = handle_request

        def log_message(self, *args):
            pass

    return ThreadingHTTPServer((host, port), Handler)
