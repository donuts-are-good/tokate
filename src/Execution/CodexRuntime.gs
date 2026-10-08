package Tokate

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices
import System.Text
import System.Text.Json

@DllImport("libc", EntryPoint: "statx", SetLastError: true)
func RuntimeMetadataStat(directory int32, path string, flags int32, mask uint32, buffer[]byte) int32;

@DllImport("libc", EntryPoint: "open", SetLastError: true)
func RuntimeMetadataOpen(path string, flags int32) int32;

internal class CodexRuntime {
    shared {
        internal func Capabilities(path string = "") Dictionary[string, HashSet[string]] {
            let executable = CodexRuntime.Resolve(path)
            let home = Path.Combine(Path.GetTempPath(), "tokate-models-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(home, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            try {
                let prefix = List[string]{
                    "-i",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "HOME=" + home,
                    "CODEX_HOME=" + home,
                    executable
                }
                let help = List[string](prefix)
                help.AddRange([]string{"exec", "--help"})
                let controls = Commands.Run("/usr/bin/env", help.ToArray(), home, seconds: 10, isolated: true)
                for flag in[]string{"--model", "--config", "--ignore-user-config", "--strict-config"} {
                    if controls.Code != 0 || !controls.Output.Contains(flag) {
                        throw Exception(
                            "Native Codex does not expose the required explicit controls; no compatible pair"
                        )
                    }
                }
                let catalog = List[string](prefix)
                catalog.AddRange([]string{"debug", "models", "--bundled"})
                let result = Commands.Run("/usr/bin/env", catalog.ToArray(), home, seconds: 10, isolated: true)
                if result.Code != 0 {
                    throw Exception("Cannot verify offline Codex model/effort capabilities; availability is unknown")
                }
                let models = Dictionary[string, HashSet[string]](StringComparer.Ordinal)
                let value = RequestData.Parse(result.Output, 4 * 1024 * 1024)
                for model in J.Items(J.Get(value, "models")) {
                    let efforts = HashSet[string](StringComparer.Ordinal)
                    for level in J.Items(J.Get(model, "supported_reasoning_levels")) {
                        efforts.Add(J.Text(level, "effort"))
                    }
                    models[J.Text(model, "slug")] = efforts
                }
                return models
            } finally {
                Directory.Delete(home, true)
            }
        }

        private func FileKind(path string, kind int32) {
            let status = [256]byte
            if RuntimeMetadataStat(-100, path, 256, 1, status) != 0 ||
                (BitConverter.ToUInt32(status, 0) & 1) == 0 ||
                (BitConverter.ToUInt16(status, 28) & 61440) != kind {
                throw Exception("Managed runtime requires regular files and unlinked metadata directories")
            }
        }

        private func Metadata(path string) JsonElement {
            var current = path
            var kind int32 = 32768
            while current != "" {
                FileKind(current, kind)
                current = Path.GetDirectoryName(current) ?? ""
                kind = 16384
            }
            let descriptor = RuntimeMetadataOpen(path, 131072 | 2048 | 524288)
            if descriptor < 0 {
                throw Exception("Cannot safely open package metadata")
            }
            using let handle = SafeFileHandle(IntPtr(descriptor), true)
            using let file = FileStream(handle, FileAccess.Read)
            if !file.CanSeek {
                throw Exception("Package metadata must be a regular file")
            }
            using let reader = BinaryReader(file)
            let bytes = reader.ReadBytes(65537)
            if bytes.Length > 65536 {
                throw Exception("Package metadata exceeds its byte limit")
            }
            return RequestData.Parse(Encoding.UTF8.GetString(bytes), 65536)
        }

        private func Native(path string) bool {
            FileKind(path, 32768)
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

        internal func Resolve(path string = "") string {
            let selected = LocalPaths.Harness("codex", path)
            if selected == "" {
                throw CliFailure("missing_tools", "Install Codex and add codex to PATH.")
            }
            try {
                let executable = LocalPaths.CanonicalPath(selected)
                if Native(executable) {
                    return executable
                }
                let bin = Path.GetDirectoryName(executable) ?? ""
                let root = Path.GetDirectoryName(bin) ?? ""
                if Path.GetFileName(executable) != "codex.js" || Path.GetFileName(bin) != "bin" {
                    throw Exception("Unsupported launcher")
                }
                let manifest = Metadata(Path.Combine(root, "package.json"))
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
                let metadata = Metadata(Path.Combine(platform, "package.json"))
                if J.Text(metadata, "name") != "@openai/codex" || J.Text(metadata, "version") != version +
                    "-linux-x64" {
                    throw Exception("Unsupported platform package")
                }
                let native = LocalPaths.CanonicalPath(
                    Path.Combine(platform, "vendor/x86_64-unknown-linux-musl/bin/codex")
                )
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
