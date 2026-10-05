package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class Verification {
    shared {
        internal func Results(run Data, record JsonElement) int32 {
            let checks = J.Items(J.Get(run.Element(), "verification"))
            let commands = J.Items(J.Get(J.Get(record, "policy"), "verification"))
            if checks.Count == 0 || checks.Count != commands.Count {
                throw Exception("Missing independent verification results")
            }
            for i in 0 ... checks.Count {
                var code int32
                let check = checks[i]
                let exitCode = J.Get(check, "exit_code")
                let state = J.Text(check, "state")
                if (state != "" && state != "completed") ||
                    exitCode.ValueKind != JsonValueKind.Number ||
                    !exitCode.TryGetInt32(out code) || code != 0 {
                    throw Exception("Owner verification did not pass")
                }
                if J.Write(J.Get(check, "command")) != J.Write(commands[i]) {
                    throw Exception("Owner verification did not pass")
                }
            }
            return checks.Count
        }

        internal func Doctor() bool {
            let root = Path.Combine("/tmp", "tokate-doctor-verification-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            let checkout = Path.Combine(root, "checkout")
            try {
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                File.WriteAllText(Path.Combine(checkout, ".git/config"), "private")
                let sentinel = Path.Combine(root, "private-probe")
                File.WriteAllText(sentinel, "private")
                let global = Path.Combine(Directory.GetCurrentDirectory(), "global.json")
                if FileInfo(global).LinkTarget != nil {
                    throw CliFailure(
                        "verification_failed",
                        "Repository global.json must be a regular file, not a symbolic link."
                    )
                }
                let pinned = File.Exists(global)
                if pinned {
                    File.Copy(global, Path.Combine(checkout, "global.json"))
                }
                let result = Run(
                    checkout,
                    []string{
                        "/bin/sh",
                        "-c",
                        "test ! -r \"$1\" && test -r .git/config && ! touch .git/tokate-probe && test \"$$HOME\" = /tmp/tokate-home && test \"$$TMPDIR\" = \"$$HOME\" && probe=$$(mktemp .tokate-probe.XXXXXX) && rm \"$$probe\" && touch /tmp/tokate-probe && cache=$$(mktemp \"$$HOME/tokate-probe.XXXXXX\") && test -z \"$$(find . -samefile \"$$cache\")\"",
                        "probe",
                        sentinel
                    },
                    false,
                    30
                )
                if result.Code != 0 || result.Truncated || result.ReadFailed {
                    throw Exception("Independent verification sandbox probe failed")
                }
                if pinned {
                    try {
                        let toolchain = Run(checkout, []string{"dotnet", "msbuild", "-nologo", "-version"}, false, 30)
                        if toolchain.Code != 0 || toolchain.Truncated || toolchain.ReadFailed {
                            throw Exception("Pinned SDK startup failed")
                        }
                    } catch (error Exception) {
                        throw CliFailure(
                            "missing_tools",
                            "Pinned SDK/MSBuild startup failed. Install the global.json SDK in a standard system path; home-directory tools are unavailable."
                        )
                    }
                }
                return pinned
            } finally {
                Directory.Delete(root, true)
            }
        }

        private func GitDirectory(path string, budget RuntimeBudget? = nil) {
            for entry in Directory.EnumerateFileSystemEntries(path) {
                budget?.Remaining()
                if FileInfo(entry).LinkTarget != nil {
                    throw Exception("Verification refuses Git symlinks: " + entry)
                }
                if Directory.Exists(entry) {
                    GitDirectory(entry, budget)
                }
            }
        }

        internal func Validate(directory string, budget RuntimeBudget? = nil) string {
            let absolute = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory))
            if absolute == "/tmp/tokate-home" || absolute.StartsWith("/tmp/tokate-home/") {
                throw Exception("Unsupported verification checkout layout: " + absolute)
            }
            let checkout = LocalPaths.DirectoryPath(directory)
            for root in[]string{"/home", "/run", "/var", "/tmp"} {
                if checkout == root {
                    throw Exception("Unsupported verification checkout layout: " + checkout)
                }
            }
            for root in[]string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc", "/sys"} {
                if checkout == "/" || checkout == root || checkout.StartsWith(root + "/") {
                    throw Exception("Unsupported verification checkout layout: " + checkout)
                }
            }
            let git = LocalPaths.DirectoryPath(Path.Combine(checkout, ".git"))
            GitDirectory(git, budget)
            for file in[]string{"commondir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts"} {
                if File.Exists(Path.Combine(git, file)) || Directory.Exists(Path.Combine(git, file)) {
                    throw Exception("Verification requires self-contained Git metadata: " + file)
                }
            }
            return checkout
        }

        internal func Candidate(directory string, budget RuntimeBudget? = nil) string {
            let checkout = Validate(directory, budget)
            let evidence = budget?.Git(checkout, "ls-files", "-v", "-z") ?? Commands.Git(
                checkout,
                "ls-files",
                "-v",
                "-z"
            )
            for entry in evidence.Split('\0') {
                if entry != "" && (Char.IsLower(entry[0]) || entry[0] == 'S') {
                    throw Exception(
                        "Candidate index contains assume-unchanged or skip-worktree flags; inspect before continuing"
                    )
                }
            }
            return checkout
        }

        private func RuntimeFile(path string, storage string) string {
            try {
                using let source = File.Open(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete
                )
                let limit = 4 * 1024 * 1024
                if source.Length > limit {
                    throw Exception("Exceeds the 4 MiB runtime-file limit")
                }
                let copy = Path.Combine(storage, Path.GetFileName(path))
                using let target = FileStream(
                    copy,
                    FileStreamOptions{
                        Mode: FileMode.CreateNew,
                        Access: FileAccess.Write,
                        Share: FileShare.None,
                        UnixCreateMode: UnixFileMode.UserRead | UnixFileMode.UserWrite
                    }
                )
                let buffer = [8192]byte
                var length int32
                var count int32
                while (count = source.Read(buffer, 0, Math.Min(buffer.Length, limit - length + 1))) > 0 {
                    if count > limit - length {
                        throw Exception("Exceeds the 4 MiB runtime-file limit")
                    }
                    target.Write(buffer, 0, count)
                    length += count
                }
                return copy
            } catch (error Exception) {
                throw Exception("Cannot prepare verification runtime file " + path + ": " + error.Message, error)
            }
        }

        private func RuntimeStorage() DirectoryInfo {
            try {
                return Directory.CreateTempSubdirectory("tokate-verification-")
            } catch (error Exception) {
                throw Exception(
                    "Cannot prepare private verification runtime storage in " + Path.GetTempPath() +
                        ": " +
                        error.Message,
                    error
                )
            }
        }

        private func CleanupRuntime(storage string, failure Exception? = nil) {
            try {
                Directory.Delete(storage, true)
            } catch (error Exception) {
                let original = failure?.Message ?? ""
                let cleanup = Exception(
                    (original != "" ? original + "\n": "") +
                        "Cannot clean verification runtime files at " +
                        storage +
                        ": " +
                        error.Message,
                    failure ?? error
                )
                if failure is CommandInterrupted interrupted {
                    throw CommandInterrupted(cleanup, interrupted.Result)
                }
                if failure is CommandInputInterrupted interruptedInput {
                    throw CommandInputInterrupted(IOException(cleanup.Message, cleanup), interruptedInput.Result)
                }
                throw cleanup
            }
        }

        internal func Check(
            storage string,
            results List[Object],
            command JsonElement,
            directory string,
            network bool,
            seconds int32,
            budget RuntimeBudget? = nil
        ) CommandResult {
            let checkout = LocalPaths.DirectoryPath(directory)
            let root = LocalPaths.DirectoryPath(storage)
            if root == checkout || root.StartsWith(checkout + "/") {
                throw Exception("Verification evidence must be outside the checkout")
            }
            let attempt = Path.Combine(root, "verification-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(
                attempt,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            let outputPath = Path.Combine(attempt, "stdout.log")
            let errorPath = Path.Combine(attempt, "stderr.log")
            let check = J.Map(
                "command",
                command,
                "state",
                "running",
                "output_file",
                Path.GetRelativePath(root, outputPath),
                "error_file",
                Path.GetRelativePath(root, errorPath)
            )
            results.Add(check)
            let record = Path.Combine(root, "verification.json")
            File.WriteAllText(record, J.Write(results))
            try {
                if seconds < 1 {
                    throw Exception("Runtime budget exhausted before verification")
                }
                let words = List[string]()
                for word in J.Items(command) {
                    words.Add(word.GetString() ?? "")
                }
                let result = Run(checkout, words.ToArray(), network, seconds, outputPath, errorPath, budget)
                check["state"] = "completed"
                check["exit_code"] = result.Code
                Evidence(check, result)
                File.WriteAllText(record, J.Write(results))
                return result
            } catch (error Exception) {
                check.Remove("exit_code")
                check["state"] = "failed"
                check["failure"] = error.Message
                if error is CommandInterrupted interrupted {
                    check["state"] = "interrupted"
                    Evidence(check, interrupted.Result)
                }
                if error is CommandInputInterrupted interruptedInput {
                    check["state"] = "interrupted"
                    Evidence(check, interruptedInput.Result)
                }
                File.WriteAllText(record, J.Write(results))
                throw error
            }
        }

        private func Evidence(check Dictionary[string, Object?], result CommandResult) {
            check["output"] = result.Output
            check["error"] = result.Error
            check["output_truncated"] = result.OutputTruncated
            check["error_truncated"] = result.ErrorTruncated
        }

        internal func Run(
            directory string,
            command[]string,
            network bool,
            seconds int32,
            outputPath string = "",
            errorPath string = "",
            budget RuntimeBudget? = nil,
            nativeExecutable string = "",
            input string? = nil,
            cancellation Chan[bool]? = nil
        ) CommandResult {
            if !OperatingSystem.IsLinux() || !File.Exists("/usr/bin/bwrap") {
                throw Exception(
                    "Independent verification requires Linux and /usr/bin/bwrap; no host fallback is supported"
                )
            }
            let checkout = Validate(directory, budget)
            for path in[]string{outputPath, errorPath} {
                if path != "" {
                    let parent = LocalPaths.DirectoryPath(Path.GetDirectoryName(Path.GetFullPath(path)) ?? "/")
                    if parent == checkout || parent.StartsWith(checkout + "/") {
                        throw Exception("Verification evidence must be outside the checkout")
                    }
                    for visible in[]string{
                        "/usr",
                        "/bin",
                        "/sbin",
                        "/lib",
                        "/lib64",
                        "/etc/alternatives",
                        "/proc",
                        "/dev"
                    } {
                        if parent == visible || parent.StartsWith(visible + "/") {
                            throw Exception("Verification evidence must be outside sandbox runtime mounts")
                        }
                    }
                }
            }
            let git = Path.Combine(checkout, ".git")
            let args = List[string]{
                "--die-with-parent",
                "--new-session",
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--cap-drop",
                "ALL",
                "--clearenv",
                "--setenv",
                "PATH",
                "/usr/local/bin:/usr/bin:/bin",
                "--setenv",
                "HOME",
                "/tmp/tokate-home",
                "--setenv",
                "TMPDIR",
                "/tmp/tokate-home",
                "--setenv",
                "LANG",
                "C.UTF-8",
                "--setenv",
                "GIT_NO_REPLACE_OBJECTS",
                "1",
                "--setenv",
                "GIT_GRAFT_FILE",
                "/dev/null"
            }
            if !network {
                args.Add("--unshare-net")
            }
            for path in[]string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"} {
                if Directory.Exists(path) {
                    args.AddRange([]string{"--ro-bind", path, path})
                }
            }
            if nativeExecutable != "" {
                args.AddRange([]string{"--ro-bind", nativeExecutable, "/opt/tokate-claude"})
                for entry in ClaudeNative.Environment() {
                    args.AddRange([]string{"--setenv", entry.Key, entry.Value})
                }
            }
            let signal = cancellation ?? Chan[bool](1)
            let onCancel = ConsoleCancelEventHandler(
                (sender Object?, event ConsoleCancelEventArgs) -> {
                    event.Cancel = true
                    select {
                        case signal <- true { }
                        default { }
                    }
                }
            )
            Console.CancelKeyPress += onCancel
            try {
                let storage = RuntimeStorage()
                var result CommandResult
                try {
                    let runtimeStorage = LocalPaths.DirectoryPath(storage.FullName)
                    if runtimeStorage == checkout || runtimeStorage.StartsWith(checkout + "/") {
                        throw Exception("Verification runtime storage must be outside the checkout: " + runtimeStorage)
                    }
                    for path in[]string{
                        "/etc/ld.so.cache",
                        "/etc/nsswitch.conf",
                        "/etc/hosts",
                        "/etc/resolv.conf",
                        "/etc/ssl/certs/ca-certificates.crt",
                        "/etc/ssl/cert.pem",
                        "/etc/pki/tls/certs/ca-bundle.crt"
                    } {
                        if File.Exists(path) {
                            args.AddRange([]string{"--ro-bind", RuntimeFile(path, storage.FullName), path})
                        }
                    }
                    args.AddRange(
                        []string{
                            "--proc",
                            "/proc",
                            "--dev",
                            "/dev",
                            "--tmpfs",
                            "/tmp",
                            "--dir",
                            "/tmp/tokate-home",
                            "--dir",
                            "/var",
                            "--tmpfs",
                            "/var/tmp",
                            "--bind",
                            checkout,
                            checkout,
                            "--chdir",
                            checkout
                        }
                    )
                    if nativeExecutable == "" {
                        args.AddRange([]string{"--ro-bind", git, git})
                    } else {
                        args.AddRange([]string{"--tmpfs", git})
                    }
                    args.Add("--")
                    args.AddRange(command)
                    result = Commands.Run(
                        "/usr/bin/bwrap",
                        args.ToArray(),
                        checkout,
                        seconds: seconds,
                        isolated: true,
                        cancellation: signal,
                        outputPath: outputPath,
                        errorPath: errorPath,
                        budget: budget,
                        input: input
                    )
                } catch (error Exception) {
                    CleanupRuntime(storage.FullName, error)
                    throw error
                }
                var failure Exception? = nil
                if result.Code != 0 {
                    failure = Exception("Verification command exited " + result.Code.ToString())
                }
                try {
                    CleanupRuntime(storage.FullName, failure)
                } catch (error Exception) {
                    result.Code = nil
                    throw CommandInterrupted(error, result)
                }
                select {
                    case <- signal {
                        result.Code = nil
                        throw CommandInterrupted(Exception("Verification cancelled"), result)
                    }
                    default { }
                }
                return result
            } finally {
                Console.CancelKeyPress -= onCancel
            }
        }
    }
}
