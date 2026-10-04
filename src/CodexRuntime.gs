package Tokate

import System
import System.IO

internal class CodexRuntime {
    shared {
        private func Native(path string) bool {
            using let file = File.OpenRead(path)
            let header = [20]byte
            return file.Read(header, 0, header.Length) == header.Length &&
                header[0] == 127 &&
                header[1] == 69 &&
                header[2] == 76 &&
                header[3] == 70 &&
                header[4] == 2 &&
                header[5] == 1 &&
                header[18] == 62 &&
                header[19] == 0 &&
                (
                File.GetUnixFileMode(path) & (
                    UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute
                )
            ) != 0
        }

        internal func Resolve() string {
            let selected = Startup.Find("codex")
            if selected == "" {
                throw CliFailure("missing_tools", "Install Codex and add codex to PATH.")
            }
            try {
                let executable = Worker.CanonicalPath(selected)
                if Native(executable) {
                    return executable
                }
                let bin = Path.GetDirectoryName(executable) ?? ""
                let root = Path.GetDirectoryName(bin) ?? ""
                if Path.GetFileName(executable) != "codex.js" || Path.GetFileName(bin) != "bin" {
                    throw Exception("Unsupported launcher")
                }
                let manifest = RequestData.FileData(Path.Combine(root, "package.json"), 64 * 1024)
                let version = J.Text(manifest, "version")
                if J.Text(manifest, "name") != "@openai/codex" || J.Text(
                    J.Get(manifest, "bin"),
                    "codex"
                ) != "bin/codex.js" ||
                    version == "" ||
                    J.Text(J.Get(manifest, "optionalDependencies"), "@openai/codex-linux-x64") !=
                "npm:@openai/codex@" + version + "-linux-x64" {
                    throw Exception("Unsupported package metadata")
                }
                let nested = Path.Combine(root, "node_modules/@openai/codex-linux-x64")
                let sibling = Path.Combine(Path.GetDirectoryName(root) ?? "", "codex-linux-x64")
                let platform = Directory.Exists(nested) ? nested: sibling
                let metadata = RequestData.FileData(Path.Combine(platform, "package.json"), 64 * 1024)
                if J.Text(metadata, "name") != "@openai/codex" || J.Text(metadata, "version") != version +
                    "-linux-x64" {
                    throw Exception("Unsupported platform package")
                }
                let native = Worker.CanonicalPath(Path.Combine(platform, "vendor/x86_64-unknown-linux-musl/bin/codex"))
                if !Native(native) {
                    throw Exception("Missing native executable")
                }
                return native
            } catch (error Exception) {
                throw CliFailure(
                    "verification_failed",
                    "Unsupported managed Codex runtime layout: requires an executable Linux x64 native binary or @openai/codex bin/codex.js with its matching nested (or sibling) @openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex. No launcher is run to discover runtime files; no inference started."
                )
            }
        }
    }
}
