package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO
import Tokate

internal class ProcessChecks {
    shared {
        internal func All() {
            Success()
            InputDeadline()
            Cancellation()
            Failures()
            OutputLimit()
        }

        private func Collected(root string) {
            for name in[]string{"parent.pid", "child.pid"} {
                let path = Path.Combine(root, name)
                Check.That(File.Exists(path), "Process fixture did not start: " + name)
                let status = "/proc/" + File.ReadAllText(path).Trim() + "/stat"
                try {
                    Check.That(File.ReadAllText(status).Split(' ')[2] == "Z", "Process survived cleanup: " + name)
                } catch (error FileNotFoundException) { } catch (error DirectoryNotFoundException) { }
            }
        }

        private func Script(delay string, consume string) string ->
        "echo $$$$ > parent.pid; sleep 120 & echo $$! > child.pid; sleep " + delay + "; " + consume

        private func Success() {
            using let temp = Temp()
            let result = Commands.Run(
                "/bin/sh",
                []string{"-c", Script("0.05", "wc -c; printf synthetic-stderr >&2")},
                temp.Root,
                String('x', 1024 * 1024),
                milliseconds: 5000
            )
            Check.That(result.Code == 0, "Piped input failed")
            Check.That(result.Output.Trim() == "1048576", "Piped input was incomplete")
            Check.That(result.Error == "synthetic-stderr", "Standard error was not collected")
            Collected(temp.Root)
            Console.WriteLine("PASS subprocess delivers 1 MiB through real pipes and collects output and descendants")
        }

        private func InputDeadline() {
            using let temp = Temp()
            let clock = Stopwatch.StartNew()
            var limited bool
            try {
                Commands.Run(
                    "/bin/sh",
                    []string{"-c", Script("2", "cat >/dev/null")},
                    temp.Root,
                    String('x', 1024 * 1024),
                    milliseconds: 100
                )
            } catch (error Exception) {
                Check.That(error.Message == "Runtime limit reached for /bin/sh", error.ToString())
                limited = true
            }
            Check.That(
                limited,
                "Blocked stdin escaped the subprocess deadline after " + clock.ElapsedMilliseconds.ToString() + " ms"
            )
            Check.That(clock.ElapsedMilliseconds < 1500, "Blocked stdin cleanup exceeded the delayed reader's start")
            Collected(temp.Root)
            Console.WriteLine("PASS blocked 1 MiB stdin reaches its 100 ms deadline and collects descendants")
        }

        private func Cancel(signal Chan[bool]) {
            select {
                case <- after(TimeSpan.FromMilliseconds(100.0)) { }
            }
            signal <- true
        }

        private func Cancellation() {
            using let temp = Temp()
            let signal = Chan[bool](1)
            go ProcessChecks.Cancel(signal)
            let clock = Stopwatch.StartNew()
            var cancelled bool
            try {
                Commands.Run(
                    "/bin/sh",
                    []string{"-c", Script("120", "cat >/dev/null")},
                    temp.Root,
                    String('x', 1024 * 1024),
                    milliseconds: 5000,
                    cancellation: signal
                )
            } catch (error Exception) {
                Check.That(error.Message == "Command cancelled: /bin/sh", error.ToString())
                cancelled = true
            }
            Check.That(cancelled && clock.ElapsedMilliseconds < 1500, "Cancellation did not stop blocked stdin")
            Collected(temp.Root)
            signal <- true
            cancelled = false
            try {
                Commands.Run("/bin/sh", []string{"-c", "touch unexpected-start"}, temp.Root, cancellation: signal)
            } catch (error Exception) {
                Check.That(error.Message == "Command cancelled: /bin/sh", error.ToString())
                cancelled = true
            }
            Check.That(
                cancelled && !File.Exists(Path.Combine(temp.Root, "unexpected-start")),
                "Pre-cancelled command started"
            )
            Console.WriteLine(
                "PASS blocked-input and pre-start cancellation retain their exception and collect descendants"
            )
        }

        private func Failures() {
            let result = Commands.Run("/bin/sh", []string{"-c", "printf synthetic-error >&2; exit 23"})
            Check.That(result.Code == 23 && result.Error == "synthetic-error", "Command exit failure changed")
            var broken bool
            try {
                Commands.Run(
                    "/bin/sh",
                    []string{"-c", "exec 0<&-; sleep 0.1"},
                    input: String('x', 1024 * 1024),
                    milliseconds: 5000
                )
            } catch (error IOException) {
                broken = true
            }
            Check.That(broken, "Stdin failure lost its IOException")
            Console.WriteLine("PASS subprocess exit failures and stdin IOExceptions retain their meanings")
        }

        private func OutputLimit() {
            let result = Commands.Run(
                "/bin/sh",
                []string{"-c", "head -c 34603008 /dev/zero; head -c 34603008 /dev/zero >&2"},
                milliseconds: 5000
            )
            Check.That(result.Code == 0, "Bounded output process failed")
            for text in[]string{result.Output, result.Error} {
                Check.That(
                    text.Length >= 32 * 1024 * 1024 && text.Length < 32 * 1024 * 1024 + 8192,
                    "Output limit changed"
                )
            }
            Console.WriteLine("PASS subprocess drains both output pipes while retaining the existing output limits")
        }
    }
}
