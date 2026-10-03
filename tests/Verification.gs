package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import Tokate

internal class VerificationChecks {
    shared {
        internal func All() {
            RuntimeFiles()
            Alternatives()
            Layouts()
            FailClosed()
            Cleanup()
        }

        internal func RuntimeFiles() {
            for mode in[]string{"replace", "unlink", "oversize"} {
                using let temp = Temp()
                let checkout = Path.Combine(temp.Root, "checkout")
                let storage = Path.Combine(temp.Root, "runtime-tmp")
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                Directory.CreateDirectory(Path.Combine(checkout, "scripts"))
                Directory.CreateDirectory(storage)
                let source = Path.Combine(checkout, "dns-source")
                if mode == "oversize" {
                    File.WriteAllBytes(source, [4 * 1024 * 1024 + 1]byte)
                } else {
                    File.WriteAllText(source, "synthetic-runtime-dns\n")
                }
                let binary = Path.Combine(checkout, "runtime-tests")
                File.Copy(Environment.ProcessPath ?? throw Exception("Missing test executable"), binary)
                File.SetUnixFileMode(binary, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
                File.WriteAllText(
                    Path.Combine(checkout, "scripts/verify.sh"),
                    "set -eu\n" +
                        "test \"$$(cat /etc/resolv.conf)\" = synthetic-runtime-dns\n" +
                        "test \"$$(stat -c '%a %h' /etc/resolv.conf)\" = '600 1'\n" +
                        "if printf tampered >> /etc/resolv.conf; then exit 1; fi\n" +
                        "bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --ro-bind /etc/resolv.conf /etc/resolv.conf -- /bin/sh -c 'test \"$$(cat /etc/resolv.conf)\" = synthetic-runtime-dns'\n" +
                        "touch nested-verified\n"
                )
                let args = List[string]{"--die-with-parent", "--unshare-user", "--unshare-pid"}
                for path in[]string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"} {
                    if Directory.Exists(path) {
                        args.AddRange([]string{"--ro-bind", path, path})
                    }
                }
                if File.Exists("/etc/ld.so.cache") {
                    args.AddRange([]string{"--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"})
                }
                args.AddRange(
                    []string{
                        "--proc",
                        "/proc",
                        "--dev",
                        "/dev",
                        "--tmpfs",
                        "/tmp",
                        "--bind",
                        temp.Root,
                        temp.Root,
                        "--ro-bind",
                        source,
                        "/etc/resolv.conf",
                        "--setenv",
                        "TMPDIR",
                        storage,
                        "--",
                        binary,
                        "--runtime-files-parent",
                        checkout,
                        mode
                    }
                )
                let result = Check.Run("/usr/bin/bwrap", args.ToArray(), temp.Env)
                Check.Success(result)
                Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "Runtime copies leaked from parent")
            }
            Console.WriteLine(
                "PASS runtime copies survive source replacement/unlink, nested mounts, failure and timeout; oversized input fails closed"
            )
        }

        internal func RuntimeFilesParent(checkout string, mode string) {
            let storage = Environment.GetEnvironmentVariable("TMPDIR") ?? throw Exception("Missing runtime storage")
            let source = Path.Combine(checkout, "dns-source")
            if mode == "oversize" {
                var refused bool
                try {
                    Verification.Run(checkout, []string{"/bin/sh", "-c", "touch runtime-code-ran"}, false, 5)
                } catch (error Exception) {
                    Check.Contains(error.Message, "Cannot prepare verification runtime file /etc/resolv.conf")
                    Check.Contains(error.Message, "4 MiB runtime-file limit")
                    refused = true
                }
                Check.That(refused, "Oversized runtime file was accepted")
                Check.That(!File.Exists(Path.Combine(checkout, "runtime-code-ran")), "Code ran with oversized input")
            } else {
                Check.That(
                    Commands.Checked("/usr/bin/stat", []string{"-c", "%h", "/etc/resolv.conf"}) == "1",
                    "Synthetic DNS source was not linked"
                )
                if mode == "replace" {
                    File.WriteAllText(source + "-next", "synthetic-replacement-dns\n")
                    File.Move(source + "-next", source, true)
                    Check.That(File.ReadAllText(source) == "synthetic-replacement-dns\n", "DNS replacement failed")
                } else {
                    File.Delete(source)
                }
                Check.That(File.ReadAllText("/etc/resolv.conf") == "synthetic-runtime-dns\n", "Parent DNS changed")
                Check.That(
                    Commands.Checked("/usr/bin/stat", []string{"-c", "%h", "/etc/resolv.conf"}) == "0",
                    "Synthetic DNS mount did not become unlinked"
                )
                let broken = Commands.Run(
                    "/usr/bin/bwrap",
                    []string{
                        "--ro-bind",
                        "/",
                        "/",
                        "--ro-bind",
                        "/etc/resolv.conf",
                        "/etc/resolv.conf",
                        "--",
                        "/bin/true"
                    }
                )
                Check.That(broken.Code != 0, "Direct bind unexpectedly accepted an unlinked source")
                Check.Contains(broken.Error, "Can't bind mount /etc/resolv.conf on /etc/resolv.conf")
                Check.Contains(broken.Error, "No such file or directory")
                for outcome in[]string{"success", "failure", "timeout"} {
                    File.Delete(Path.Combine(checkout, "nested-verified"))
                    File.Delete(Path.Combine(checkout, "heartbeat"))
                    let script = "set -eu\n" +
                        "test \"$$(cat /etc/resolv.conf)\" = synthetic-runtime-dns\n" +
                        "test \"$$(stat -c '%a %h' /etc/resolv.conf)\" = '600 1'\n" +
                        "printf synthetic-later-dns > dns-source-next && mv dns-source-next dns-source && rm dns-source\n" +
                        "./runtime-tests --verify-checkout \"$$PWD\"\n" +
                        "test -f nested-verified\n" +
                        "setsid /bin/sh -c 'while :; do echo beat >> heartbeat; sleep 0.05; done' </dev/null >/dev/null 2>&1 &\n" +
                        "while [ ! -s heartbeat ]; do sleep 0.01; done\n" +
                        (
                        outcome == "timeout" ? "sleep 120\n":
                        (outcome == "failure" ? "printf synthetic-verifier-failure >&2; exit 23\n": "exit 0\n")
                    )
                    var timedOut bool
                    try {
                        let result = Verification.Run(
                            checkout,
                            []string{"/bin/sh", "-c", script},
                            false,
                            outcome == "timeout" ? 3: 15
                        )
                        Check.That(outcome != "timeout", "Verification did not time out")
                        Check.That(result.Code == (outcome == "failure" ? 23: 0), result.Output + result.Error)
                        if outcome == "failure" {
                            Check.Contains(result.Error, "synthetic-verifier-failure")
                        }
                    } catch (error Exception) {
                        Check.That(outcome == "timeout", mode + "/" + outcome + ": " + error.Message)
                        Check.Contains(error.Message, "Runtime limit reached")
                        Check.That(!error.Message.Contains("Cannot clean verification runtime files"), error.Message)
                        timedOut = true
                    }
                    Check.That(timedOut == (outcome == "timeout"), "Incorrect runtime timeout result")
                    Check.That(
                        File.Exists(Path.Combine(checkout, "nested-verified")),
                        "Nested verification did not run"
                    )
                    Check.That(
                        Directory.GetFileSystemEntries(storage).Length == 0,
                        "Runtime copies leaked: " + mode + "/" + outcome + ": " + String.Join(
                            ", ",
                            Directory.GetFileSystemEntries(storage)
                        )
                    )
                    let heartbeat = Path.Combine(checkout, "heartbeat")
                    let length = FileInfo(heartbeat).Length
                    select {
                        case <- after(TimeSpan.FromMilliseconds(200.0)) { }
                    }
                    Check.That(FileInfo(heartbeat).Length == length, "Runtime descendant survived: " + outcome)
                }
            }
            Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "Runtime copies leaked after preparation")
        }

        internal func Alternatives() {
            using let temp = Temp()
            let checkout = Path.Combine(temp.Root, "checkout")
            let alternatives = Path.Combine(temp.Root, "alternatives")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            Directory.CreateDirectory(Path.Combine(checkout, "scripts"))
            Directory.CreateDirectory(alternatives)
            File.CreateSymbolicLink(Path.Combine(alternatives, "awk"), "/usr/bin/awk-real")
            let secret = Path.Combine(temp.Root, "private")
            File.WriteAllText(secret, "synthetic system configuration")
            File.WriteAllText(
                Path.Combine(checkout, "scripts/verify.sh"),
                "set -eu\n/usr/bin/awk 'BEGIN { print \"standard-tool-started\" }'\n" +
                    "test ! -e /etc/private\nif : > /etc/alternatives/unwanted; then exit 1; fi\n"
            )
            let result = Check.Run(
                "/usr/bin/bwrap",
                []string{
                    "--die-with-parent",
                    "--unshare-user",
                    "--unshare-pid",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    "--tmpfs",
                    "/tmp",
                    "--bind",
                    checkout,
                    checkout,
                    "--tmpfs",
                    "/etc",
                    "--ro-bind",
                    alternatives,
                    "/etc/alternatives",
                    "--ro-bind",
                    secret,
                    "/etc/private",
                    "--tmpfs",
                    "/usr/bin",
                    "--ro-bind",
                    "/usr/bin/bash",
                    "/usr/bin/bash",
                    "--symlink",
                    "bash",
                    "/usr/bin/sh",
                    "--ro-bind",
                    "/usr/bin/bwrap",
                    "/usr/bin/bwrap",
                    "--ro-bind",
                    "/usr/bin/setsid",
                    "/usr/bin/setsid",
                    "--ro-bind",
                    "/usr/bin/awk",
                    "/usr/bin/awk-real",
                    "--symlink",
                    "/etc/alternatives/awk",
                    "/usr/bin/awk",
                    "--",
                    Environment.ProcessPath ?? throw Exception("Missing test executable"),
                    "--verify-checkout",
                    checkout
                },
                temp.Env
            )
            Check.Contains(Check.Success(result), "standard-tool-started")
            Check.That(File.ReadAllText(secret) == "synthetic system configuration", "System sentinel changed")
            Console.WriteLine("PASS verification starts system alternatives without exposing unrelated configuration")
        }

        private func Refused(checkout string, expected string) {
            var refused bool
            try {
                Verification.Run(checkout, []string{"/bin/sh", "-c", "touch repository-code-ran"}, false, 5)
            } catch (error Exception) {
                Check.Contains(error.Message, expected)
                refused = true
            }
            Check.That(refused, "Unsafe layout was accepted")
            Check.That(
                !File.Exists(Path.Combine(checkout, "repository-code-ran")),
                "Repository code ran before layout refusal"
            )
        }

        internal func Layouts() {
            Refused("/tmp/tokate-home", "Unsupported verification checkout layout")
            Refused("/tmp/tokate-home/checkout", "Unsupported verification checkout layout")
            for mode in[]string{"checkout-link", "git-link", "git-file", "git-child-link", "alternates", "commondir"} {
                using let temp = Temp()
                let checkout = Path.Combine(temp.Root, "checkout")
                let git = Path.Combine(checkout, ".git")
                Directory.CreateDirectory(Path.Combine(git, "objects/info"))
                let sentinel = Path.Combine(temp.Root, "private")
                File.WriteAllText(sentinel, "synthetic private configuration")
                switch mode {
                    case "checkout-link" {
                        let link = Path.Combine(temp.Root, "linked")
                        Directory.CreateSymbolicLink(link, checkout)
                        Refused(link, "without checkout/Git symlinks")
                    }
                    case "git-link" {
                        Directory.Move(git, git + "-real")
                        Directory.CreateSymbolicLink(git, git + "-real")
                        Refused(checkout, "without checkout/Git symlinks")
                    }
                    case "git-file" {
                        Directory.Delete(git, true)
                        File.WriteAllText(git, "gitdir: " + sentinel)
                        Refused(checkout, "real directories")
                    }
                    case "git-child-link" {
                        File.CreateSymbolicLink(Path.Combine(git, "config"), sentinel + "-missing")
                        Refused(checkout, "Git symlinks")
                    }
                    case "alternates" {
                        File.WriteAllText(Path.Combine(git, "objects/info/alternates"), temp.Root)
                        Refused(checkout, "self-contained Git metadata")
                    }
                    case "commondir" {
                        File.WriteAllText(Path.Combine(git, "commondir"), temp.Root)
                        Refused(checkout, "self-contained Git metadata")
                    }
                }
                Check.That(
                    File.ReadAllText(sentinel) == "synthetic private configuration",
                    "Unsafe layout changed private data"
                )
            }
            Console.WriteLine("PASS verification refuses unsafe checkout and Git layouts before repository code")
        }

        internal func Cleanup() {
            for timeout in[]bool{false, true} {
                using let temp = Temp()
                let checkout = Path.Combine(temp.Root, "checkout")
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                let script = "set -eu\n" +
                    "setsid /bin/sh -c 'i=0; while [ $$i -lt 100 ]; do echo beat >> heartbeat; i=$$((i+1)); sleep 0.05; done' </dev/null >/dev/null 2>&1 &\n" +
                    "while [ ! -s heartbeat ]; do sleep 0.01; done\n" +
                    (timeout ? "sleep 120\n": "exit 0\n")
                var timedOut bool
                try {
                    let result = Verification.Run(checkout, []string{"/bin/sh", "-c", script}, false, timeout ? 1: 5)
                    Check.That(result.Code == 0, result.Error)
                } catch (error Exception) {
                    Check.That(timeout, error.Message)
                    Check.Contains(error.Message, "Runtime limit reached")
                    timedOut = true
                }
                Check.That(timedOut == timeout, "Incorrect verification timeout result")
                let heartbeat = Path.Combine(checkout, "heartbeat")
                Check.That(File.Exists(heartbeat), "Detached descendant never started")
                let length = FileInfo(heartbeat).Length
                select {
                    case <- after(TimeSpan.FromMilliseconds(400.0)) { }
                }
                Check.That(FileInfo(heartbeat).Length == length, "Detached verifier descendant survived cleanup")
            }
            Console.WriteLine("PASS verification cleans detached descendants on normal exit and timeout")
        }

        internal func FailClosed() {
            using let temp = Temp()
            let checkout = Path.Combine(temp.Root, "checkout")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            Directory.CreateDirectory(Path.Combine(checkout, "scripts"))
            Directory.CreateDirectory(Path.Combine(temp.Root, "empty"))
            let storage = Path.Combine(temp.Root, "runtime-tmp")
            Directory.CreateDirectory(storage)
            temp.Env["TMPDIR"] = storage
            File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "touch repository-code-ran\n")
            let binary = Environment.ProcessPath ?? throw Exception("Missing test executable")
            for missing in[]bool{true, false} {
                let source = missing ? Path.Combine(temp.Root, "empty"): "/dev/null"
                let target = missing ? "/usr/bin": "/usr/bin/bwrap"
                let result = Check.Run(
                    "/usr/bin/bwrap",
                    []string{
                        "--die-with-parent",
                        "--ro-bind",
                        "/",
                        "/",
                        "--ro-bind",
                        source,
                        target,
                        "--bind",
                        checkout,
                        checkout,
                        "--bind",
                        storage,
                        storage,
                        "--",
                        binary,
                        "--verify-checkout",
                        checkout
                    },
                    temp.Env
                )
                Check.That(result.Code != 0, "Verification accepted missing or unusable bubblewrap")
                if missing {
                    Check.Contains(result.Error, "Independent verification requires Linux and /usr/bin/bwrap")
                } else {
                    Check.Contains(result.Error, "/usr/bin/bwrap")
                }
                Check.That(
                    !File.Exists(Path.Combine(checkout, "repository-code-ran")),
                    "Verification fell back to host execution"
                )
                Check.That(
                    Directory.GetFileSystemEntries(storage).Length == 0,
                    "Runtime copies leaked on launch failure"
                )
            }
            Console.WriteLine("PASS verification fails closed with missing or unusable bubblewrap")
        }
    }
}
