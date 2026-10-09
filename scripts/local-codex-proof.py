import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--layout", choices=("nested", "sibling"), default="nested")
    parser.add_argument("--node", type=Path, default=Path("/usr/bin/node"))
    parser.add_argument("--tokate", type=Path, default=Path("artifacts/linux-x64/tokate"))
    parser.add_argument("--tests", type=Path, default=Path("artifacts/tests/tokate-tests"))
    options = parser.parse_args()
    prefix = options.prefix.resolve()
    package = prefix / (
        "lib/node_modules/@openai/codex" if options.layout == "nested" else "node_modules/@openai/codex"
    )
    metadata = json.loads((package / "package.json").read_text())
    if metadata["name"] != "@openai/codex" or not metadata.get("version"):
        raise RuntimeError("Proof requires an isolated, unmodified @openai/codex npm user prefix")
    print("Testing @openai/codex " + metadata["version"], flush=True)
    platform = (
        package / "node_modules/@openai/codex-linux-x64"
        if options.layout == "nested" else package.parent / "codex-linux-x64"
    )
    native = platform / "vendor/x86_64-unknown-linux-musl/bin/codex"
    if not native.is_file():
        raise RuntimeError("Proof requires the selected unmodified optional dependency layout; do not rearrange the installation")
    launcher = prefix / ("bin/codex" if options.layout == "nested" else "node_modules/.bin/codex")
    storage = Path.home() / ".cache/tokate-proofs"
    storage.mkdir(parents=True, exist_ok=True)
    if storage.resolve().is_relative_to(Path.cwd().resolve()):
        raise RuntimeError("The simulated donor home must be outside the checkout")
    with tempfile.TemporaryDirectory(prefix="local-codex-proof-", dir=storage) as directory:
        root = Path(directory)
        node = root / "home/.local/bin/node"
        node.parent.mkdir(parents=True)
        shutil.copy2(options.node.resolve(), node)
        standalone = root / "home/.local/share/codex/codex"
        standalone.parent.mkdir(parents=True)
        shutil.copy2(native, standalone)
        runs = root / "runs"
        runs.mkdir()
        environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(root / "home"),
            "LANG": "C.UTF-8",
            "TOKATE_BINARY": str(options.tokate.resolve()),
            "TOKATE_TEST_ROOT": str(runs),
            "TOKATE_PROOF_NODE": str(node),
            "TOKATE_PROOF_VERSION": "codex-cli " + metadata["version"],
        }
        command = [
            "/usr/bin/bwrap", "--die-with-parent", "--bind", "/", "/",
            "--dev", "/dev",
            "--tmpfs", "/tmp", "--dir", "/tmp/tokate-home",
            "--bind", str(runs), "/var/tmp", "--bind", str(Path.cwd()), str(Path.cwd()),
        ]
        for system_node in ("/usr/local/bin/node", "/usr/bin/node", "/bin/node"):
            if Path(system_node).exists():
                command += ["--ro-bind", "/dev/null", system_node]
        command += [
            "--", str(options.tests.resolve()), "--local-codex", str(launcher), str(native), str(standalone),
        ]
        subprocess.run(command, env=environment, check=True, timeout=180)


if __name__ == "__main__":
    main()
