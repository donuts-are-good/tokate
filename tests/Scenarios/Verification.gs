package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json
import Tokate

internal class VerificationChecks {
    shared {
        internal func All() {
            RuntimeFiles()
            RuntimeCancellation()
            Alternatives()
            Layouts()
            FailClosed()
            Cleanup()
        }

        internal func RuntimeFiles() {
            for mode in[]string{"replace", "unlink", "oversize", "inside", "alias"} {
                using let temp = Temp()
                let checkout = Path.Combine(temp.Root, "checkout")
                let storage = Path.Combine(mode == "inside" || mode == "alias" ? checkout: temp.Root, "runtime-tmp")
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                Directory.CreateDirectory(Path.Combine(checkout, "scripts"))
                Directory.CreateDirectory(storage)
                let temporary = mode == "alias" ? Directory.CreateSymbolicLink(
                    Path.Combine(temp.Root, "runtime-alias"),
                    storage
                )
                    .FullName: storage
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
                        temporary,
                        "--",
                        binary,
                        "--runtime-files-parent",
                        checkout,
                        mode
                    }
                )
                let result = TestProcess.Run("/usr/bin/bwrap", args.ToArray(), temp.Env)
                Check.Success(result)
                Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "Runtime copies leaked from parent")
            }
            Console.WriteLine(
                "PASS runtime copies survive source replacement/unlink, nested mounts, failure and timeout; oversized input and writable aliases fail closed"
            )
        }

        internal func RuntimeFilesParent(checkout string, mode string) {
            let storage = Environment.GetEnvironmentVariable("TMPDIR") ?? throw Exception("Missing runtime storage")
            let source = Path.Combine(checkout, "dns-source")
            if mode == "inside" || mode == "alias" {
                var refused bool
                try {
                    Verification.Run(checkout, []string{"/bin/sh", "-c", "touch runtime-code-ran"}, false, 5)
                } catch (error Exception) {
                    Check.Contains(
                        error.Message,
                        mode == "inside" ? "runtime storage must be outside the checkout": "directories without checkout/Git symlinks"
                    )
                    refused = true
                }
                Check.That(refused, "Writable runtime-file alias was accepted")
                Check.That(
                    !File.Exists(Path.Combine(checkout, "runtime-code-ran")),
                    "Code ran with writable runtime storage"
                )
            } else if mode == "oversize" {
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
                Check.Contains(broken.Error, "Can't bind mount")
                Check.Contains(broken.Error, "/etc/resolv.conf")
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
                    TestProcess.HeartbeatStopped(
                        Path.Combine(checkout, "heartbeat"),
                        200,
                        "Runtime descendant survived: " + outcome
                    )
                }
            }
            Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "Runtime copies leaked after preparation")
        }

        internal func RuntimeCancellation() {
            using let temp = Temp()
            let checkout = Path.Combine(temp.Root, "checkout")
            let storage = Path.Combine(temp.Root, "runtime-tmp")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            Directory.CreateDirectory(Path.Combine(checkout, "scripts"))
            Directory.CreateDirectory(storage)
            let evidence = Path.Combine(temp.Root, "evidence")
            Directory.CreateDirectory(evidence)
            temp.Env["TMPDIR"] = storage
            File.Copy(
                Environment.ProcessPath ?? throw Exception("Missing test executable"),
                Path.Combine(temp.Root, "runtime-tests")
            )
            File.WriteAllText(
                Path.Combine(checkout, "scripts/verify.sh"),
                "set -eu\n" +
                    "setsid /bin/sh -c 'while :; do echo beat >> heartbeat; sleep 0.05; done' </dev/null >/dev/null 2>&1 &\n" +
                    "while [ ! -s heartbeat ]; do sleep 0.01; done\n" +
                    "printf synthetic-cancelled-output; printf synthetic-cancelled-error >&2\n" +
                    "touch ready\n" +
                    "sleep 120\n"
            )
            let info = ProcessStartInfo("/usr/bin/script")
            info.WorkingDirectory = temp.Root
            info.UseShellExecute = false
            info.RedirectStandardInput = true
            info.RedirectStandardOutput = true
            info.RedirectStandardError = true
            info.Environment.Clear()
            for entry in temp.Env {
                info.Environment[entry.Key] = entry.Value
            }
            for arg in[]string{
                "-q",
                "-e",
                "-c",
                "test -t 0; echo $$$$ > verifier.pid; exec ./runtime-tests --verify-captured checkout evidence",
                "/dev/null"
            } {
                info.ArgumentList.Add(arg)
            }
            using let terminal = Process.Start(info) ?? throw Exception("Cannot start verification terminal")
            try {
                terminal.StandardInput.Close()
                let ready = Path.Combine(checkout, "ready")
                for i in 0 ... 1000 {
                    if File.Exists(ready) {
                        break
                    }
                    select {
                        case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                    }
                }
                Check.That(File.Exists(ready), "Foreground verifier did not become ready")
                Check.That(Directory.GetFileSystemEntries(storage).Length > 0, "Runtime copies were not created")
                let pid = int32.Parse(File.ReadAllText(Path.Combine(temp.Root, "verifier.pid")).Trim())
                Check.Success(TestProcess.Run("/usr/bin/kill", []string{"-INT", pid.ToString()}, temp.Env))
                Check.That(terminal.WaitForExit(5000), "Verification cancellation did not stop the terminal")
                let output = terminal.StandardOutput.ReadToEnd() + terminal.StandardError.ReadToEnd()
                Check.That(terminal.ExitCode != 0, output)
                Check.Contains(output, "cancelled")
                Check.That(!output.Contains("synthetic-cancelled"), "Cancelled verifier output escaped")
                let checks = J.Items(J.Parse(File.ReadAllText(Path.Combine(evidence, "verification.json"))))
                Check.That(
                    checks.Count == 1 && J.Get(checks[0], "exit_code").ValueKind == JsonValueKind.Undefined,
                    "Cancelled verification fabricated success"
                )
                Check.That(J.Text(checks[0], "state") == "interrupted", "Cancelled verification lost active phase")
                Check.That(J.Text(checks[0], "output") == "synthetic-cancelled-output", "Cancelled stdout lost")
                Check.That(J.Text(checks[0], "error") == "synthetic-cancelled-error", "Cancelled stderr lost")
                Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "Runtime copies leaked on cancellation")
                TestProcess.HeartbeatStopped(
                    Path.Combine(checkout, "heartbeat"),
                    200,
                    "Runtime descendant survived cancellation"
                )
            } finally {
                if !terminal.HasExited {
                    terminal.Kill(true)
                    terminal.WaitForExit()
                }
            }
            Console.WriteLine("PASS foreground verification cancellation removes runtime copies and stops descendants")
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
            let result = TestProcess.Run(
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
                let evidence = Path.Combine(temp.Root, "evidence")
                Directory.CreateDirectory(evidence)
                let results = List[Object]()
                let script = "set -eu\n" +
                    "test ! -e '" +
                    evidence +
                    "'\n" +
                    "printf synthetic-verifier-output; printf synthetic-verifier-error >&2\n" +
                    "setsid /bin/sh -c 'i=0; while [ $$i -lt 100 ]; do echo beat >> heartbeat; i=$$((i+1)); sleep 0.05; done' </dev/null >/dev/null 2>&1 &\n" +
                    "while [ ! -s heartbeat ]; do sleep 0.01; done\n" +
                    (timeout ? "sleep 120\n": "exit 0\n")
                var timedOut bool
                try {
                    Verification.Check(evidence, results, J.Parse("[\"/bin/true\"]"), checkout, false, 5)
                    let command = J.Parse(J.Write([]string{"/bin/sh", "-c", script}))
                    let result = Verification.Check(evidence, results, command, checkout, false, timeout ? 1: 5)
                    Check.That(result.Code == 0, result.Error)
                } catch (error CommandInterrupted) {
                    Check.That(timeout, error.Message)
                    Check.Contains(error.Message, "Runtime limit reached")
                    Check.That(error.Result.Code == nil, "Timeout fabricated an exit code")
                    Check.That(error.Result.Output == "synthetic-verifier-output", "Verifier stdout lost")
                    Check.That(error.Result.Error == "synthetic-verifier-error", "Verifier stderr lost")
                    timedOut = true
                }
                Check.That(timedOut == timeout, "Incorrect verification timeout result")
                let checks = J.Items(J.Parse(File.ReadAllText(Path.Combine(evidence, "verification.json"))))
                Check.That(checks.Count == 2 && J.Number(checks[0], "exit_code") == 0, "Prior passed check lost")
                let check = checks[1]
                Check.That(J.Text(check, "state") == (timeout ? "interrupted": "completed"), "Active phase lost")
                let kind = timeout ? JsonValueKind.Undefined: JsonValueKind.Number
                Check.That(J.Get(check, "exit_code").ValueKind == kind, "Invalid terminal exit code")
                Check.That(
                    File.ReadAllText(
                        Path.Combine(evidence, J.Text(check, "output_file"))
                    ) == "synthetic-verifier-output",
                    "Raw verifier prefix lost"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(evidence, J.Text(check, "error_file"))) == "synthetic-verifier-error",
                    "Raw verifier stderr lost"
                )
                Check.That(
                    !J.Bool(check, "output_truncated") && !J.Bool(check, "error_truncated"),
                    "Truncation flags changed"
                )
                let heartbeat = Path.Combine(checkout, "heartbeat")
                Check.That(File.Exists(heartbeat), "Detached descendant never started")
                TestProcess.HeartbeatStopped(heartbeat, 400, "Detached verifier descendant survived cleanup")
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
                let result = TestProcess.Run(
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
