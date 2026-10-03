package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO

internal class SuiteChecks {
    shared {
        internal func All() {
            Success()
            FailureDrain()
            Cancellation()
            Unknown()
        }

        private func Prepare(temp Temp) string {
            let checkout = Path.Combine(temp.Root, "checkout")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            File.Copy(
                Environment.ProcessPath ?? throw Exception("Missing test executable"),
                Path.Combine(checkout, ".git/suite-tests")
            )
            return checkout
        }

        private func Nested(name string) string ->
        "setsid bwrap --unshare-user --unshare-pid --new-session --ro-bind / / " +
            "--bind \"$$PWD\" \"$$PWD\" --ro-bind \"$$PWD/.git\" \"$$PWD/.git\" --proc /proc -- " +
            "setsid /bin/sh -c 'while :; do echo beat >> " +
            name +
            "-heartbeat; sleep 0.05; done' </dev/null >/dev/null 2>&1 &\n" +
            "while [ ! -s " +
            name +
            "-heartbeat ]; do sleep 0.01; done\n" +
            "touch " +
            name +
            "-ready\n"

        private func Job(name string, script string, seconds int32) SuiteJob -> SuiteJob{
            Name: name,
            Command: []string{"/bin/sh", "-c", "set -eu\n" + script},
            Seconds: seconds
        }

        internal func Fixture(checkout string, mode string = "cancel") {
            let first = mode == "success" ?
            "test ! -e /tmp/suite-private; touch /tmp/suite-private\n" +
                "test ! -e /var/tmp/suite-private; touch /var/tmp/suite-private\n" +
                "test -z \"$${TOKATE_DRIVER_SECRET-}$${GH_TOKEN-}$${CODEX_HOME-}\"\n" +
                "if touch .git/unwanted 2>/dev/null; then exit 1; fi\n" +
                "readlink /proc/self/ns/pid > first-namespace\n" +
                Nested("first") +
                "while [ ! -f peer-ready ]; do sleep 0.01; done\nprintf first-output\nprintf first-error >&2\n":
            Nested("first") +
                "while [ ! -f peer-ready ]; do sleep 0.01; done\n" +
                (
                mode == "failure" ? "printf synthetic-suite-failure >&2; exit 23\n":
                "printf first-before-stop; printf first-error-before-stop >&2; sleep 120\n"
            )
            let peer = mode == "success" ?
            "test ! -e /tmp/suite-private; touch /tmp/suite-private\n" +
                "test ! -e /var/tmp/suite-private; touch /var/tmp/suite-private\n" +
                "readlink /proc/self/ns/pid > peer-namespace\n" +
                Nested("peer") +
                "while [ ! -f first-ready ]; do sleep 0.01; done\nprintf peer-output\n":
            Nested("peer") +
                "while [ ! -f first-ready ]; do sleep 0.01; done\n" +
                "printf peer-before-stop; printf peer-error-before-stop >&2; sleep 120\n"
            let jobs = mode == "success" ? []SuiteJob{Job("first", first, 10), Job("peer", peer, 10)}:
            []SuiteJob{
                Job("first", first, mode == "timeout" ? 1: 10),
                Job("peer", peer, mode == "cancel" ? 10: 3),
                Job("unadmitted", "touch unexpected-admission\n", 5)
            }
            let report = SuiteReport()
            SuiteDriver(checkout, jobs).Run(report)
        }

        private func Still(checkout string) {
            let first = FileInfo(Path.Combine(checkout, "first-heartbeat")).Length
            let peer = FileInfo(Path.Combine(checkout, "peer-heartbeat")).Length
            select {
                case <- after(TimeSpan.FromMilliseconds(200.0)) { }
            }
            Check.That(
                FileInfo(Path.Combine(checkout, "first-heartbeat")).Length == first && FileInfo(
                    Path.Combine(checkout, "peer-heartbeat")
                ).Length == peer,
                "A nested setsid/bwrap suite descendant survived"
            )
            Check.That(!File.Exists(Path.Combine(checkout, "unexpected-admission")), "A job started after failure")
        }

        private func Success() {
            using let temp = Temp()
            let checkout = Prepare(temp)
            temp.Env["TOKATE_DRIVER_SECRET"] = "synthetic-driver-secret"
            temp.Env["GH_TOKEN"] = "synthetic-driver-token"
            temp.Env["CODEX_HOME"] = "synthetic-driver-home"
            let result = Check.Run(
                Path.Combine(checkout, ".git/suite-tests"),
                []string{"--suite-fixture", checkout, "success"},
                temp.Env
            )
            Check.Success(result)
            Check.Contains(result.Output, "first-output")
            Check.Contains(result.Output, "peer-output")
            Check.Contains(result.Error, "first-error")
            Check.That(
                File.ReadAllText(Path.Combine(checkout, "first-namespace")) !=
                File.ReadAllText(Path.Combine(checkout, "peer-namespace")),
                "Suite workers shared a PID namespace"
            )
            Still(checkout)
            Console.WriteLine(
                "PASS two suite workers preserve output, private namespaces, read-only data and nested cleanup"
            )
        }

        private func FailureDrain() {
            for mode in[]string{"failure", "timeout"} {
                using let temp = Temp()
                let checkout = Prepare(temp)
                let clock = Stopwatch.StartNew()
                let result = Check.Run(
                    Path.Combine(checkout, ".git/suite-tests"),
                    []string{"--suite-fixture", checkout, mode},
                    temp.Env
                )
                Check.That(result.Code != 0, "Suite failure became success")
                if mode == "failure" {
                    Check.Contains(result.Error, "synthetic-suite-failure")
                    Check.Contains(result.Error, "exit 23")
                }
                Check.Contains(result.Error, "Runtime limit reached")
                Check.Contains(result.Output, "peer-before-stop")
                Check.Contains(result.Error, "peer-error-before-stop")
                if mode == "timeout" {
                    Check.Contains(result.Output, "first-before-stop")
                    Check.Contains(result.Error, "first-error-before-stop")
                }
                Check.That(
                    clock.ElapsedMilliseconds >= 3000 && clock.ElapsedMilliseconds < 7000,
                    "Failure did not drain its peer under the explicit three-second bound"
                )
                Still(checkout)
            }
            Console.WriteLine(
                "PASS suite failure and timeout stop admission, drain the bounded peer and collect nested sessions"
            )
        }

        private func Cancellation() {
            using let temp = Temp()
            let checkout = Prepare(temp)
            let storage = Path.Combine(temp.Root, "runtime-tmp")
            Directory.CreateDirectory(storage)
            temp.Env["TMPDIR"] = storage
            let info = ProcessStartInfo("/usr/bin/script")
            info.WorkingDirectory = checkout
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
                "test -t 0; echo $$$$ > driver.pid; exec .git/suite-tests --suite-fixture \"$$PWD\"",
                "/dev/null"
            } {
                info.ArgumentList.Add(arg)
            }
            using let terminal = Process.Start(info) ?? throw Exception("Cannot start suite terminal")
            try {
                terminal.StandardInput.Close()
                for i in 0 ... 1000 {
                    if File.Exists(Path.Combine(checkout, "first-ready")) && File.Exists(
                        Path.Combine(checkout, "peer-ready")
                    ) {
                        break
                    }
                    select {
                        case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                    }
                }
                Check.That(
                    File.Exists(Path.Combine(checkout, "first-ready")) && File.Exists(
                        Path.Combine(checkout, "peer-ready")
                    ),
                    "Both suite workers did not become ready"
                )
                Check.That(Directory.GetDirectories(storage).Length == 2, "Both workers did not prepare runtime files")
                let pid = File.ReadAllText(Path.Combine(checkout, "driver.pid")).Trim()
                Check.Success(Check.Run("/usr/bin/kill", []string{"-INT", pid}, temp.Env))
                Check.That(terminal.WaitForExit(5000), "Ctrl+C did not collect both suite workers")
                let output = terminal.StandardOutput.ReadToEnd() + terminal.StandardError.ReadToEnd()
                Check.That(terminal.ExitCode != 0, "Ctrl+C became success")
                Check.Contains(output, "cancelled")
                Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "Suite runtime files leaked on Ctrl+C")
                Still(checkout)
            } finally {
                if !terminal.HasExited {
                    terminal.Kill(true)
                    terminal.WaitForExit()
                }
            }
            Console.WriteLine(
                "PASS foreground Ctrl+C stops both suite namespaces, nested sessions and further admission"
            )
        }

        private func Unknown() {
            using let temp = Temp()
            let binary = Environment.ProcessPath ?? throw Exception("Missing test executable")
            for selector in[]string{"--suite", "--flow", "--coordination", "--correction", "--amendments"} {
                let result = Check.Run(binary, []string{selector, "unknown-suite"}, temp.Env)
                Check.That(result.Code != 0, "Unknown selector succeeded: " + selector)
                Check.Contains(result.Error, "Unknown")
                Check.That(!result.Output.Contains("PASS "), "Unknown selector ran unrelated groups")
            }
            let malformed = Check.Run(binary, []string{"--suite"}, temp.Env)
            Check.That(malformed.Code != 0, "Malformed suite selector succeeded")
            Console.WriteLine("PASS unknown suite/group selectors and malformed arguments fail closed")
        }
    }
}
