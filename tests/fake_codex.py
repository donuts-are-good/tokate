#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
from pathlib import Path

if sys.argv[1:] == ["login", "status"]:
    print("Logged in using ChatGPT", file=sys.stderr)
    sys.exit(0)

assert "OPENAI_API_KEY" not in os.environ
assert "CODEX_API_KEY" not in os.environ
assert "DONOR_SECRET" not in os.environ
assert "--ignore-user-config" in sys.argv
assert 'approval_policy="never"' in sys.argv
assert "--ephemeral" in sys.argv
assert "--sandbox" in sys.argv
prompt = sys.stdin.read()
checkout = Path(sys.argv[sys.argv.index("--cd") + 1])
output = Path(sys.argv[sys.argv.index("--output-last-message") + 1])
if "TIMEOUT" in prompt or "BACKGROUND" in prompt:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    (output.parent / "child.pid").write_text(str(child.pid))
if "TIMEOUT" in prompt:
    time.sleep(300)
if "FAIL" in prompt:
    print(json.dumps({"type": "turn.failed", "error": {"message": "Fixture usage limit"}}))
    sys.exit(1)
assert (checkout / "README.md").read_text() == "Committed content\n"
assert not (checkout / "private.txt").exists()
if "EDIT" in prompt:
    (checkout / "README.md").write_text("Improved content\n")
    (checkout / "NEW.txt").write_text("New file\n")
output.write_text("Fixture report\n")
print(json.dumps({"type": "turn.completed", "usage": {
    "input_tokens": 20, "cached_input_tokens": 10, "output_tokens": 5}}))
