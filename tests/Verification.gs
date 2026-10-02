package TokateTests

import System
import System.IO
import System.Threading
import Tokate

internal class VerificationChecks {
    shared {
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
            for mode in[]string{
                "checkout-link",
                "git-link",
                "git-file",
                "git-child-link",
                "scratch-link",
                "alternates",
                "commondir"
            } {
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
                    case "scratch-link" {
                        Directory.CreateSymbolicLink(Path.Combine(checkout, ".tokate-scratch"), temp.Root)
                        Refused(checkout, "scratch directory")
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
            Console.WriteLine(
                "PASS verification refuses unsafe checkout, Git and scratch layouts before repository code"
            )
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
                Thread.Sleep(400)
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
            }
            Console.WriteLine("PASS verification fails closed with missing or unusable bubblewrap")
        }
    }
}
