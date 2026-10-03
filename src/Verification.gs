package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO

internal class Verification {
    shared {
        private func DirectoryPath(path string) string {
            let absolute = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path))
            var current = Path.GetPathRoot(absolute) ?? "/"
            for part in absolute.Substring(current.Length).Split(Path.DirectorySeparatorChar) {
                current = Path.Combine(current, part)
                if FileInfo(current).LinkTarget != nil || !Directory.Exists(current) {
                    throw Exception("Verification requires real directories without checkout/Git symlinks: " + current)
                }
            }
            return absolute
        }

        private func GitDirectory(path string) {
            for entry in Directory.EnumerateFileSystemEntries(path) {
                if FileInfo(entry).LinkTarget != nil {
                    throw Exception("Verification refuses Git symlinks: " + entry)
                }
                if Directory.Exists(entry) {
                    GitDirectory(entry)
                }
            }
        }

        internal func Validate(directory string) string {
            let absolute = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory))
            if absolute == "/tmp/tokate-home" || absolute.StartsWith("/tmp/tokate-home/") {
                throw Exception("Unsupported verification checkout layout: " + absolute)
            }
            let checkout = DirectoryPath(directory)
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
            let git = DirectoryPath(Path.Combine(checkout, ".git"))
            GitDirectory(git)
            for file in[]string{"commondir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts"} {
                if File.Exists(Path.Combine(git, file)) || Directory.Exists(Path.Combine(git, file)) {
                    throw Exception("Verification requires self-contained Git metadata: " + file)
                }
            }
            return checkout
        }

        internal func Candidate(directory string) string {
            let checkout = Validate(directory)
            for entry in Commands.Git(checkout, "ls-files", "-v", "-z").Split('\0') {
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
                throw Exception(
                    (original != "" ? original + "\n": "") +
                        "Cannot clean verification runtime files at " +
                        storage +
                        ": " +
                        error.Message,
                    failure ?? error
                )
            }
        }

        internal func Run(directory string, command[]string, network bool, seconds int32) CommandResult {
            if !OperatingSystem.IsLinux() || !File.Exists("/usr/bin/bwrap") {
                throw Exception(
                    "Independent verification requires Linux and /usr/bin/bwrap; no host fallback is supported"
                )
            }
            let checkout = Validate(directory)
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
            let cancellation = Chan[bool](1)
            let onCancel = ConsoleCancelEventHandler(
                (sender Object?, event ConsoleCancelEventArgs) -> {
                    event.Cancel = true
                    select {
                        case cancellation <- true { }
                        default { }
                    }
                }
            )
            Console.CancelKeyPress += onCancel
            try {
                let storage = RuntimeStorage()
                var result CommandResult
                try {
                    let runtimeStorage = DirectoryPath(storage.FullName)
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
                            "--ro-bind",
                            git,
                            git,
                            "--chdir",
                            checkout,
                            "--"
                        }
                    )
                    args.AddRange(command)
                    result = Commands.Run(
                        "/usr/bin/bwrap",
                        args.ToArray(),
                        checkout,
                        seconds: seconds,
                        isolated: true,
                        cancellation: cancellation
                    )
                } catch (error Exception) {
                    CleanupRuntime(storage.FullName, error)
                    throw error
                }
                var failure Exception? = nil
                if result.Code != 0 {
                    failure = Exception(
                        "Verification command exited " + result.Code.ToString() + ": " + result.Error + result.Output
                    )
                }
                CleanupRuntime(storage.FullName, failure)
                select {
                    case <- cancellation {
                        throw Exception("Verification cancelled")
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
