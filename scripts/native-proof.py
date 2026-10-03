#!/usr/bin/env python3
"""Private, offline, real-native proof; deliberately not a production adapter."""

import argparse
import base64
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import selectors
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time


VERSION = "codex-cli 0.160.0"
MODEL = "gpt-6.1-sol"
LOCAL_MODEL = "synthetic-local-exact"
KEY = "sk-synthetic-native-proof-never-valid"
FEATURES = (
    "apps", "plugins", "hooks", "codex_hooks", "plugin_hooks", "multi_agent",
    "multi_agent_v2", "shell_snapshot", "shell_snapshot_v2",
)
LIMIT = 4 * 1024 * 1024


class Unsupported(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Unsupported(message)


def config(values):
    return [arg for key, value in values.items() for arg in ("-c", f"{key}={value}")]


def quoted(value):
    # JSON string quoting is also valid TOML basic string quoting for these paths.
    return json.dumps(str(value))


def metadata(result):
    """Retain only documented nonsecret fields; unfamiliar shapes fail closed."""
    # This pinned runtime also emits workspaceRouting. Never consume its value.
    require(isinstance(result, dict) and set(result) <= {"account", "requiresOpenaiAuth", "workspaceRouting"},
            "Unknown account/read result schema; field names=" +
            repr(sorted(result) if isinstance(result, dict) else type(result).__name__))
    required = result.get("requiresOpenaiAuth")
    require(type(required) is bool, "Missing/unknown authentication-required field")
    account = result.get("account")
    if account is None:
        return {"type": None, "requiresOpenaiAuth": required}
    require(isinstance(account, dict), "Unknown account schema")
    kind = account.get("type")
    fields = {"apiKey": {"type"}, "chatgpt": {"type", "email", "planType"}}
    require(kind in fields and set(account) == fields[kind], "Unknown account type/schema")
    return {"type": kind, "requiresOpenaiAuth": required}


def api_gate(account):
    require(account == {"type": "apiKey", "requiresOpenaiAuth": True},
            "API-only selection refused before execution")


class Owned:
    """Every invocation owns a PID namespace, including setsid/double-fork children.

    Killing its namespace init collects detached children without enumerating host
    processes or killing a pre-existing server. The mount of / is NOT a filesystem
    sandbox: native permissions restrict repository commands separately.
    """

    def __init__(self, args, env, cwd, *, system=None, native=False):
        wrapper = ["/usr/bin/bwrap", "--die-with-parent", "--new-session",
                   "--bind", "/", "/", "--unshare-pid", "--as-pid-1", "--proc", "/proc",
                   "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/tokate-home"]
        if system is not None:
            wrapper += ["--ro-bind", str(system), "/etc/codex"]
        wrapper += ["--chdir", str(cwd), "--", *args]
        self.process = subprocess.Popen(wrapper, env=env, cwd=cwd, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        start_new_session=True)
        self.closed = False

    def close(self):
        if self.closed:
            return
        self.closed = True
        # Only the invocation's own process group and namespace are terminated.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()

    def run(self, data=b"", seconds=10):
        try:
            out, err = self.process.communicate(data, timeout=seconds)
            require(len(out) <= LIMIT and len(err) <= LIMIT, "Native output exceeds proof limit")
            return self.process.returncode, out.decode(), err.decode()
        finally:
            self.close()


class Fixture(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.requests = []
        self.metadata_requests = []
        self.failures = []
        self.mode = "complete"
        self.actions = []
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.server_port}/v1"

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=5)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reject(self):
        self.server.failures.append(self.command + " " + self.path)
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path in ("/v1/models?client_version=0.160.0", "/v1/api/codex/accounts/check"):
            # Native background catalogue/workspace discovery is not inference.
            # Explicit synthetic 404s keep the unsupported routing behavior visible.
            self.server.metadata_requests.append(self.path)
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.reject()

    do_PUT = reject
    do_DELETE = reject

    def do_POST(self):
        if self.path != "/v1/responses":
            self.reject()
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= LIMIT:
            self.reject()
            return
        request = json.loads(self.rfile.read(size))
        self.server.requests.append({"path": self.path, "body": request,
                                     "headers": dict(self.headers)})
        mode = self.server.mode
        if mode in ("http-error", "model-error", "auth-error"):
            self.send_response({"http-error": 503, "model-error": 404, "auth-error": 401}[mode])
            body = b'{"error":{"message":"synthetic refusal","type":"invalid_request_error"}}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        if mode == "hang":
            time.sleep(3)
            return
        if mode == "broken-stream":
            self.close_connection = True
            return
        count = len(self.server.requests)
        item = (self.server.actions.pop(0) if self.server.actions else
                {"type": "message", "id": f"msg_{count}", "role": "assistant",
                 "status": "completed", "content": [
                     {"type": "output_text", "text": "synthetic completion", "annotations": []}]})
        response = {"id": f"resp_{count}", "object": "response", "model": request["model"],
                    "status": "completed", "output": [item],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        events = [
            {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": response},
        ]
        try:
            for event in events:
                self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True


class Proof:
    def __init__(self, binary, root):
        self.binary = binary
        self.root = root
        self.fixture = Fixture()
        self.system = root / "system"
        self.system.mkdir(mode=0o700)
        self.counter = 0
        self.records = []
        self.unsupported = []

    def record(self, name, **evidence):
        self.records.append({"check": name, **evidence})
        print("PASS " + name + (" " + json.dumps(evidence, sort_keys=True) if evidence else ""), flush=True)

    def blocked(self, message):
        self.unsupported.append(message)
        print("UNSUPPORTED " + message, flush=True)

    def home(self, kind="missing"):
        self.counter += 1
        root = self.root / f"case-{self.counter}"
        root.mkdir(mode=0o700)
        for name in ("home", "native", "checkout"):
            (root / name).mkdir(mode=0o700)
        (root / "checkout/.git").mkdir(mode=0o700)
        self.private(root / "checkout/.git/config", "synthetic protected git sentinel")
        auth = None
        if kind == "api":
            auth = {"auth_mode": "apikey", "OPENAI_API_KEY": KEY}
        elif kind == "chatgpt":
            def jwt(claims):
                encode = lambda x: base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip("=")
                return encode({"alg": "none"}) + "." + encode(claims) + ".synthetic"
            token = jwt({"email": "fixture@example.invalid", "exp": 4102444800,
                         "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account",
                                                        "chatgpt_plan_type": "plus"}})
            auth = {"auth_mode": "chatgpt", "OPENAI_API_KEY": None,
                    "tokens": {"id_token": token, "access_token": token,
                               "refresh_token": "synthetic-never-refresh", "account_id": "synthetic-account"},
                    "last_refresh": "2026-10-03T00:00:00Z"}
        if auth:
            self.private(root / "native/auth.json", json.dumps(auth))
        return root

    @staticmethod
    def private(path, text):
        path.write_text(text)
        path.chmod(0o600)

    def env(self, root):
        return {"PATH": "/usr/bin:/bin", "HOME": str(root / "home"),
                "CODEX_HOME": str(root / "native"), "LANG": "C.UTF-8"}

    def process(self, root, args, **kwargs):
        require(not any((root / "checkout/.codex" / name).exists()
                        for name in ("config.toml", "hooks.json", "plugins")),
                "Repository Codex configuration refused before native startup")
        return Owned([str(self.binary), *args], self.env(root), root / "checkout",
                     system=self.system, **kwargs)

    def run(self, root, args, data=b"", seconds=10):
        return self.process(root, args).run(data, seconds)

    def suppression(self):
        values = {"cli_auth_credentials_store": '"file"', "web_search": '"disabled"',
                  "allow_login_shell": "false", "skills.include_instructions": "false",
                  "features.skip_host_skill_discovery": "true", "analytics.enabled": "false",
                  "feedback.enabled": "false"}
        values.update({"features." + f: "false" for f in FEATURES})
        return values

    def provider(self, kind):
        # 0.160.0 reserves built-in IDs; use a named Responses fixture requiring
        # native OpenAI authentication rather than silently overriding openai.
        name = "api-fixture" if kind == "api" else "fixture"
        prefix = "model_providers." + name + "."
        values = {"model_provider": quoted(name), prefix + "name": quoted("private synthetic fixture"),
                  prefix + "base_url": quoted(self.fixture.endpoint), prefix + "wire_api": '"responses"',
                  prefix + "requires_openai_auth": "true" if kind == "api" else "false",
                  prefix + "request_max_retries": "0", prefix + "stream_max_retries": "0",
                  prefix + "stream_idle_timeout_ms": "1000"}
        return values

    def permissions(self, root):
        checkout = root / "checkout"
        filesystem = {":root": "deny", ":minimal": "read", "/tmp": "write",
                      str(checkout): "write", str(checkout / ".git"): "deny", str(self.binary): "read"}
        table = "{ " + ", ".join(quoted(k) + " = " + quoted(v) for k, v in filesystem.items()) + " }"
        return {"default_permissions": '"tokate"', "permissions.tokate.filesystem": table,
                "permissions.tokate.network.enabled": "false", "approval_policy": '"never"',
                "shell_environment_policy.inherit": '"none"',
                "shell_environment_policy.set": '{ PATH = "/usr/bin:/bin", HOME = "/tmp/tokate-home", TMPDIR = "/tmp/tokate-home" }'}

    def exec_args(self, root, kind="local", model=MODEL, effort=None, extra=None):
        values = {**self.suppression(), **self.permissions(root), **self.provider(kind)}
        if effort is not None:
            values["model_reasoning_effort"] = quoted(effort)
        values.update(extra or {})
        return ["exec", "--strict-config", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                "--json", "--color", "never", "--skip-git-repo-check", "--cd", str(root / "checkout"),
                "--model", model, *config(values), "-"]

    def account(self, root, kind="api", extra=None):
        values = {**self.suppression(), **self.provider(kind),
                  "chatgpt_base_url": quoted(self.fixture.endpoint), **(extra or {})}
        owned = self.process(root, ["app-server", "--strict-config", "--stdio", *config(values)])
        process = owned.process
        selector = selectors.DefaultSelector()
        buffers = {"out": b"", "err": b""}
        for stream, name in ((process.stdout, "out"), (process.stderr, "err")):
            selector.register(stream, selectors.EVENT_READ, name)
        deadline = time.monotonic() + 10
        total = 0

        def send(value):
            process.stdin.write((json.dumps(value) + "\n").encode())
            process.stdin.flush()

        def receive(expected):
            nonlocal total
            while time.monotonic() < deadline:
                for key, _ in selector.select(max(0, deadline - time.monotonic())):
                    chunk = os.read(key.fd, 8192)
                    require(bool(chunk), "Metadata probe exited before account response: " +
                            buffers["err"].decode(errors="replace")[-1800:])
                    total += len(chunk)
                    require(total <= LIMIT, "Metadata probe output limit exceeded")
                    name = key.data
                    buffers[name] += chunk
                    if name == "err":
                        continue
                    while b"\n" in buffers[name]:
                        line, buffers[name] = buffers[name].split(b"\n", 1)
                        value = json.loads(line)
                        require("method" not in value or "id" not in value,
                                "Unexpected server request; refusing helpers/authentication")
                        if value.get("id") == expected:
                            require("error" not in value and "result" in value,
                                    "Metadata request refused: " + json.dumps(value.get("error")))
                            return value["result"]
            raise Unsupported("Metadata probe deadline exceeded: " +
                              buffers["err"].decode(errors="replace")[-1800:])

        try:
            send({"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "tokate_native_proof", "version": "1"},
                "capabilities": {"experimentalApi": False}}})
            receive(1)  # Discard initialization metadata, including native home/platform.
            send({"method": "initialized", "params": {}})
            send({"id": 2, "method": "account/read", "params": {"refreshToken": False}})
            return metadata(receive(2))
        finally:
            selector.close()
            owned.close()

    def readiness(self):
        root = self.home()
        code, out, _ = self.run(root, ["--version"])
        require(code == 0 and out.strip() == VERSION, "Unsupported native version; expected " + VERSION)
        interfaces = {"exec": ["--strict-config", "--ignore-user-config", "--ignore-rules", "--model", "--profile"],
                      "app-server": ["--strict-config", "--stdio"],
                      "sandbox": ["--permission-profile", "--include-managed-config"]}
        for command, flags in interfaces.items():
            code, out, _ = self.run(root, [command, "--help"])
            require(code == 0 and all(flag in out for flag in flags), "Missing native interface: " + command)
        code, out, _ = self.run(root, ["debug", "models", "--bundled"])
        require(code == 0, "Offline native catalogue unavailable")
        models = json.loads(out)["models"]
        selected = [x for x in models if x.get("slug") == MODEL and x.get("supported_in_api") is True]
        require(len(selected) == 1, "Requested synthetic API model is not in native API catalogue")
        self.efforts = [x["effort"] for x in selected[0]["supported_reasoning_levels"]]
        require("high" in self.efforts, "Native API effort high is unavailable")
        self.record("native readiness", version=VERSION, sha256=hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                    interfaces=list(interfaces) + ["debug models --bundled"], requested_model=MODEL,
                    native_api_efforts=self.efforts)

    def accounts(self):
        for kind in ("api", "chatgpt", "missing", "local"):
            root = self.home(kind)
            before = len(self.fixture.requests)
            try:
                result = self.account(root, "local" if kind == "local" else "api")
            except Unsupported as error:
                # Native 0.160.0 performs workspace discovery even with refreshToken:false.
                require(kind == "chatgpt" and "workspace routing discovery failed" in str(error), str(error))
                self.blocked("ChatGPT account/read refreshToken:false requires workspace routing discovery; "
                             "synthetic offline metadata is refused, so no production metadata gate is established")
                require(len(self.fixture.requests) == before, "ChatGPT metadata spent inference")
                continue
            expected = {"type": {"api": "apiKey", "chatgpt": "chatgpt"}.get(kind),
                        "requiresOpenaiAuth": kind != "local"}
            require(result == expected, "Native account fixture did not identify " + kind)
            require(len(self.fixture.requests) == before, "Account metadata made an inference request")
            if kind != "api":
                try:
                    api_gate(result)
                except Unsupported:
                    pass
                else:
                    raise Unsupported("API-only gate accepted " + kind)
            else:
                api_gate(result)
            self.record("account/read " + kind, **result)
        for result in ({}, {"requiresOpenaiAuth": "true"},
                       {"account": {"type": "future"}, "requiresOpenaiAuth": True},
                       {"account": {"type": "apiKey", "token": "synthetic"}, "requiresOpenaiAuth": True}):
            try:
                metadata(result)
            except Unsupported:
                continue
            raise Unsupported("Unknown account schema did not fail closed")
        self.record("API-only refusal and unknown metadata fail closed; no execution")

    def mismatch(self):
        root = self.home("chatgpt")
        original = (root / "native/auth.json").read_bytes()
        # This destructive native restriction is tested ONLY on our disposable home.
        result = self.account(root, extra={"forced_login_method": '"api"'})
        require(result["type"] is None, "Forced API mismatch retained ChatGPT login")
        result, requests = self.execute(root, "api", "high", {"forced_login_method": '"api"'})
        require(result[0] != 0 and not requests, "Forced API mismatch was not refused before inference")
        auth = root / "native/auth.json"
        if auth.exists() and auth.read_bytes() == original:
            self.blocked("forced_login_method=api hides/refuses a disposable ChatGPT mismatch but leaves "
                         "its auth file unchanged; documented persistent logout was not observed")
        elif auth.exists():
            require(json.loads(auth.read_text()).get("tokens") is None,
                    "Native mismatch modified but retained disposable ChatGPT tokens")
        self.record("disposable forced_login_method=api mismatch refused before inference")

    def execute(self, root, kind="local", effort=None, extra=None, model=MODEL, seconds=10):
        start = len(self.fixture.requests)
        result = self.run(root, self.exec_args(root, kind, model, effort, extra),
                          b"Complete the synthetic fixture task. Use only the fixture's tool instructions.", seconds)
        return result, self.fixture.requests[start:]

    def wire(self):
        for kind, effort in (("api", "high"), ("local", None)):
            root = self.home(kind)
            if kind == "api":
                api_gate(self.account(root))
            model = MODEL if kind == "api" else LOCAL_MODEL
            self.selection_gate(kind, model, effort)
            result, requests = self.execute(root, kind, effort, model=model)
            require(result[0] == 0, "Native " + kind + " exec failed: " + result[2][-1800:])
            require(len(requests) == 1, "Unexpected native completion request count")
            request = requests[0]
            self.native_tools = {tool.get("name", tool.get("function", {}).get("name")): tool
                                 for tool in request["body"].get("tools", [])}
            require(request["path"] == "/v1/responses" and request["body"]["model"] == model,
                    "Endpoint/model selection changed")
            headers = {k.lower(): v for k, v in request["headers"].items()}
            if kind == "api":
                require(headers.get("authorization") == "Bearer " + KEY, "Native file API auth was not used")
                require(request["body"].get("reasoning", {}).get("effort") == "high", "API effort changed")
            else:
                require("authorization" not in headers and "x-api-key" not in headers,
                        "No-auth fixture received authentication")
                require("effort" not in request["body"].get("reasoning", {}),
                        "Absent local effort was replaced by a native default")
                require(not (root / "native/auth.json").exists(), "No-auth path created credentials")
            events = [json.loads(line) for line in result[1].splitlines() if line.strip()]
            require(any(e.get("type") == "turn.completed" for e in events), "No native completed turn")
            self.record("native " + kind + " synthetic wire", requested_provider="api-fixture" if kind == "api" else "fixture",
                        endpoint="private loopback /v1/responses", requested_model=model,
                        native_reported_model=request["body"]["model"], requested_effort=effort,
                        wire_effort=request["body"].get("reasoning", {}).get("effort"), requests=len(requests))

    def selection_gate(self, kind, model, effort):
        if kind == "api":
            require(model == MODEL and effort in self.efforts, "Unverified API model/effort; no execution")
        else:
            require(model == LOCAL_MODEL and effort is None,
                    "Local selection has no independently supplied effort capabilities; no execution")

    def startup(self):
        root = self.home("api")
        marker = root / "unexpected-helper"
        helper = root / "helper.sh"
        self.private(helper, "#!/bin/sh\ntouch " + shlex.quote(str(marker)) + "\n")
        helper.chmod(0o700)
        subprocess.run([str(helper)], env=self.env(root), check=True)
        require(marker.exists(), "Startup helper positive control failed")
        marker.unlink()
        hooks = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": str(helper)}]}]}}
        for directory in (root / "native", root / "home/.codex"):
            directory.mkdir(mode=0o700, exist_ok=True)
            self.private(directory / "hooks.json", json.dumps(hooks))
        self.private(root / "native/config.toml",
                     'model = "synthetic-unselected"\nmodel_provider = "ollama"\n'
                     '[features]\nhooks = true\nplugins = true\n'
                     '[mcp_servers.proof]\ncommand = ' + quoted(helper) + '\n')
        require(self.account(root)["type"] == "apiKey", "Startup account probe lost API identity")
        result, requests = self.execute(root, "api", "high")
        require(result[0] == 0 and len(requests) == 1 and not marker.exists(),
                "Startup ran a user hook/plugin/helper or changed the fixture route")
        (root / "checkout/.codex").mkdir(exist_ok=True)
        self.private(root / "checkout/.codex/config.toml", '[mcp_servers.proof]\ncommand = ' + quoted(helper))
        start = len(self.fixture.requests)
        try:
            self.execute(root, "api", "high")
        except Unsupported as error:
            require("Repository Codex configuration refused" in str(error), str(error))
        else:
            raise Unsupported("Repository startup configuration was accepted")
        require(len(self.fixture.requests) == start and not marker.exists(), "Repository startup ran a helper")
        self.record("generated user hooks/helpers suppressed; repository configuration refused before startup")
        self.blocked("app-server has no --ignore-user-config interface; generated fixture startup is measured, "
                     "but arbitrary production home startup suppression is unsupported")

    def profiles(self):
        root = self.home("api")
        self.private(root / "native/proof.config.toml", 'model_reasoning_effort = "medium"\n')
        args = self.exec_args(root, "api")
        args[-1:-1] = ["--profile", "proof"]
        start = len(self.fixture.requests)
        code, _, err = self.run(root, args, b"Complete the synthetic fixture task.")
        requests = self.fixture.requests[start:]
        require(code == 0 and len(requests) == 1, "Native named profile failed: " + err[-1800:])
        headers = {k.lower(): v for k, v in requests[0]["headers"].items()}
        require(headers.get("authorization") == "Bearer " + KEY, "Named profile changed authentication home")
        effort = requests[0]["body"].get("reasoning", {}).get("effort")
        if effort != "medium":
            self.blocked("--ignore-user-config also suppresses named-profile configuration in this runtime; "
                         "authentication remains in selected CODEX_HOME")
        self.record("named profile retains native API authentication home", observed_effort=effort)
        # Explicit model identity must survive a recorded migration mapping.
        result, requests = self.execute(root, "api", "high", {
            "notice.model_migrations": "{ " + quoted(MODEL) + ' = "synthetic-replacement" }'})
        require(result[0] == 0 and len(requests) == 1 and requests[0]["body"]["model"] == MODEL,
                "Native model migration silently changed explicit requested identity")
        self.record("explicit model survives synthetic migration notice; no fallback")

    def managed(self):
        root = self.home("api")
        requirement = self.system / "requirements.toml"
        self.private(requirement, 'allowed_approval_policies = ["on-request"]\n')
        try:
            result, requests = self.execute(root, "api", "high")
            if result[0] != 0 and not requests:
                self.record("managed approval conflict refused before inference")
            else:
                require(len(requests) == 1, "Unexpected requests under generated managed requirement")
                self.blocked("managed approval requirement can replace approval_policy=never instead of "
                             "refusing before inference; mixed/managed production configuration is unsupported")
        finally:
            requirement.unlink()
        self.blocked("No nonsecret effective endpoint/provider/model override gate has been established; "
                     "mixed and managed provider/model overrides remain unsupported without config inspection")

    def cleanup(self):
        for mode in ("normal", "deadline", "cancel"):
            root = self.home()
            checkout = root / "checkout"
            sock = "\0tokate-proof-owned-" + root.name
            ready = checkout / "ready"
            child = ("import os,socket,time; os.fork() and os._exit(0); os.setsid(); "
                     "os.fork() and os._exit(0); s=socket.socket(socket.AF_UNIX); "
                     "s.bind(" + repr(str(sock)) + "); s.listen(); "
                     "open(" + repr(str(ready)) + ",'w').write('ready'); time.sleep(60)")
            parent = ("import subprocess,time,pathlib; subprocess.Popen(['/usr/bin/python3','-c'," +
                      repr(child) + "]); p=pathlib.Path(" + repr(str(ready)) + "); "
                      "\nwhile not p.exists(): time.sleep(.01)\n" +
                      ("time.sleep(.05)" if mode == "normal" else "time.sleep(60)"))
            owned = Owned(["/usr/bin/python3", "-c", parent], self.env(root), checkout)
            clock = time.monotonic()
            try:
                if mode == "cancel":
                    while not ready.exists() and time.monotonic() - clock < 2:
                        time.sleep(.01)
                    require(ready.exists(), "Cancellation detached fixture did not start")
                    owned.close()
                elif mode == "deadline":
                    try:
                        owned.run(seconds=.3)
                    except subprocess.TimeoutExpired:
                        pass
                    else:
                        raise Unsupported("Owned deadline did not fire")
                else:
                    require(owned.run()[0] == 0, "Owned normal completion failed")
                require(ready.exists() and time.monotonic() - clock < 3, "Detached cleanup did not finish promptly")
                # Namespace-init death is asynchronous after the bwrap monitor
                # exits. Bound observation of kernel descendant teardown too.
                collected = time.monotonic() + 1
                while True:
                    probe = socket.socket(socket.AF_UNIX)
                    try:
                        probe.connect(str(sock))
                    except OSError:
                        break
                    finally:
                        probe.close()
                    require(time.monotonic() < collected, "Detached owned process survived " + mode)
                    time.sleep(.01)
                with socket.create_connection(("127.0.0.1", self.fixture.server_port), timeout=1):
                    pass
                self.record("owned detached descendants cleaned on " + mode + "; existing fixture server alive")
            finally:
                owned.close()

    def refusals(self):
        for kind, model, effort in (("api", MODEL, "impossible"), ("api", "unknown-model", "high"),
                                    ("local", LOCAL_MODEL, "high"), ("local", "unknown-model", None)):
            start = len(self.fixture.requests)
            try:
                self.selection_gate(kind, model, effort)
            except Unsupported:
                pass
            else:
                raise Unsupported("Nonsecret selection gate accepted unverified capabilities")
            require(len(self.fixture.requests) == start, "Selection gate spent inference")
        self.record("nonsecret API/local capability gate refuses unsupported model and effort before execution")
        for label, extra in (("unsupported effort", {"model_reasoning_effort": '"impossible"'}),
                             ("unknown setting", {"tokate_unknown_setting": "true"}),
                             ("unknown provider setting", {"model_providers.fixture.unknown_setting": "true"})):
            root = self.home()
            result, requests = self.execute(root, extra=extra)
            if result[0] != 0 and not requests:
                self.record("native " + label + " refusal before inference")
            else:
                require(len(requests) == 1, "Unexpected request count testing " + label)
                self.blocked("Native CLI override " + label + " is not refused by --strict-config; "
                             "only the proof's fixed/nonsecret selection gate is supported")
        for mode in ("model-error", "auth-error", "http-error", "broken-stream"):
            root = self.home("api")
            self.fixture.mode = mode
            requested_model = "synthetic-unavailable" if mode == "model-error" else MODEL
            result, requests = self.execute(root, "api", "high", model=requested_model)
            require(result[0] != 0, "Synthetic " + mode + " unexpectedly completed")
            require(len(requests) == 1, "Zero native retry budget was not honored: " + mode)
            require(requests[0]["body"]["model"] == requested_model, "Native silently substituted a model")
            self.record("native " + mode + " bounded refusal", requests=len(requests),
                        request_max_retries=0, stream_max_retries=0, stream_idle_timeout_ms=1000)
        self.fixture.mode = "complete"
        root = self.home()
        result, requests = self.execute(root, model=LOCAL_MODEL, extra={
            "model_providers.fixture.env_key": '"TOKATE_SYNTHETIC_MISSING_KEY"'})
        require(result[0] != 0 and not requests, "Missing provider environment key was not refused")
        self.record("native missing provider environment-key authentication refused before inference")

    def boundary(self):
        root = self.home("local")
        checkout = root / "checkout"
        protected = root / "protected.txt"
        self.private(protected, "synthetic protected sentinel")
        self.private(checkout / ".git/config", "synthetic protected git sentinel")
        (root / "protected-auth").mkdir(mode=0o700)
        auth = root / "protected-auth/auth.json"
        self.private(auth, json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": KEY}))
        before = auth.read_bytes()  # Generated synthetic fixture only; never a selected/user home.
        script = """import pathlib, socket, sys
for name in sys.argv[1:]:
    p = pathlib.Path(name)
    try:
        p.read_bytes()
    except (PermissionError, FileNotFoundError):
        pass
    else:
        raise SystemExit('protected read succeeded')
    try:
        p.write_text('unexpected mutation')
    except (PermissionError, FileNotFoundError):
        pass
    else:
        print('write succeeded in native view: ' + str(p))
try:
    s = socket.socket(); s.settimeout(0.5)
    s.connect(('127.0.0.1', int(sys.argv[-1])))
except OSError:
    pass
else:
    raise SystemExit('repository networking reached fixture')
pathlib.Path('boundary-ok').write_text('ok')
"""
        # Port is separate from file arguments in the generated helper.
        script = script.replace("sys.argv[1:]", "sys.argv[1:-1]")
        helper = checkout / "helper.py"
        self.private(helper, script)
        args = ["sandbox", "-P", "tokate", "--include-managed-config", "-C", str(checkout),
                *config({**self.suppression(), **self.permissions(root)}), "--", "/usr/bin/env", "-i",
                "PATH=/usr/bin:/bin", "HOME=/tmp/tokate-home", "TMPDIR=/tmp/tokate-home",
                "/usr/bin/python3", str(helper), str(auth), str(protected), str(checkout / ".git/config"),
                str(self.fixture.server_port)]
        code, _, err = self.run(root, args)
        require(code == 0 and (checkout / "boundary-ok").exists(), "Native command boundary failed: " + err[-1800:])
        require(auth.read_bytes() == before and protected.read_text() == "synthetic protected sentinel",
                "Protected synthetic files changed")
        self.record("native sandbox file/shell/helper and network denial")
        (checkout / "boundary-ok").unlink()
        shell = next((name for name in ("exec_command", "shell_command", "shell")
                      if name in self.native_tools), None)
        require(shell is not None,
                "Required native shell/edit tools missing: " + repr(list(self.native_tools)))
        command = shlex.join(["/usr/bin/python3", str(helper), str(auth), str(protected),
                              str(checkout / ".git/config"), str(self.fixture.server_port)])
        arguments = ({"cmd": command, "yield_time_ms": 1000} if shell == "exec_command" else
                     {"command": command} if shell == "shell_command" else
                     {"command": ["/bin/sh", "-c", command], "workdir": str(checkout)})
        patch = "*** Begin Patch\n*** Delete File: " + str(auth) + "\n*** End Patch"
        patch_command = "apply_patch <<'TOKATE_PATCH'\n" + patch + "\nTOKATE_PATCH"
        patch_arguments = ({"cmd": patch_command, "yield_time_ms": 1000} if shell == "exec_command" else
                           {"command": patch_command} if shell == "shell_command" else
                           {"command": ["/bin/sh", "-c", patch_command], "workdir": str(checkout)})
        patch_call = ({"type": "custom_tool_call", "id": "ct_patch", "call_id": "call_patch",
                       "name": "apply_patch", "input": patch} if "apply_patch" in self.native_tools else
                      {"type": "function_call", "id": "fc_patch", "call_id": "call_patch",
                       "name": shell, "arguments": json.dumps(patch_arguments)})
        self.fixture.actions = [
            {"type": "function_call", "id": "fc_shell", "call_id": "call_shell",
             "name": shell, "arguments": json.dumps(arguments)},
            patch_call,
        ]
        result, requests = self.execute(root, model=LOCAL_MODEL)
        require(result[0] == 0 and len(requests) == 3 and not self.fixture.actions,
                "Native shell/edit sequence failed: " + result[2][-1800:])
        require((checkout / "boundary-ok").exists(), "Native exec did not run the file/network helper")
        if "command not found" in result[1] or "apply_patch: not found" in result[1]:
            self.blocked("Native patch helper is unavailable under the accepted shell environment; "
                         "protected files survive, but native edit execution is not proven")
        require(auth.exists() and auth.read_bytes() == before and
                protected.read_text() == "synthetic protected sentinel" and
                (checkout / ".git/config").read_text() == "synthetic protected git sentinel",
                "Native edit/helper changed protected authentication or files")
        self.record("codex exec native shell/helper and apply_patch preserve protected sentinels")

    def all(self, check_only=False):
        self.readiness()
        if check_only:
            return
        self.accounts()
        self.mismatch()
        self.wire()
        self.refusals()
        self.startup()
        self.profiles()
        self.managed()
        self.boundary()
        self.cleanup()
        require(not self.fixture.failures, "Unexpected fixture requests: " + repr(self.fixture.failures))
        self.record("only Responses and synthetic refused catalogue/workspace metadata routes observed; no pull/start/login/refresh",
                    metadata_requests=len(self.fixture.metadata_requests))
        print("RESULT deterministic native regressions passed; unsupported production controls=" +
              str(len(self.unsupported)), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", help="Explicit installed native executable; no installation or startup")
    parser.add_argument("--check", action="store_true", help="Narrow synthetic host readiness only; no inference")
    parser.add_argument("--inside", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    binary = Path(args.codex or shutil.which("codex") or "")
    require(binary.is_absolute() and binary.is_file(), "Native Codex missing: supply --codex /absolute/path")
    binary = binary.resolve(strict=True)
    if args.inside:
        proof = Proof(binary, args.inside)
        try:
            proof.all(args.check)
        finally:
            proof.fixture.close()
        return
    require(sys.platform == "linux" and Path("/usr/bin/bwrap").is_file(), "Linux bubblewrap is required")
    # Fixtures live outside /tmp, which is replaced by each native invocation.
    with tempfile.TemporaryDirectory(prefix=".native-proof-", dir=Path(__file__).resolve().parent.parent) as name:
        root = Path(name)
        root.chmod(0o700)
        command = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", "--bind", "/", "/",
                   "--unshare-net", "--unshare-pid", "--proc", "/proc", "--dev", "/dev",
                   "--tmpfs", "/tmp", "--tmpfs", "/etc", "--dir", "/etc/codex", "--",
                   "/usr/bin/python3", str(Path(__file__).resolve()), "--codex", str(binary), "--inside", str(root)]
        if args.check:
            command.append("--check")
        # No inherited secrets, proxy variables, login/keyring context or environment dump.
        process = subprocess.Popen(command, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                   start_new_session=True)
        try:
            code = process.wait(timeout=180)
            require(code == 0, "Native proof failed; no retry was attempted")
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


if __name__ == "__main__":
    try:
        main()
    except (Unsupported, subprocess.TimeoutExpired, OSError, ValueError) as error:
        print("BLOCKED " + str(error), file=sys.stderr)
        sys.exit(1)
