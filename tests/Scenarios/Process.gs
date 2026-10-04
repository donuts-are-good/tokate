package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Runtime.InteropServices
import Tokate

@DllImport("libc", EntryPoint: "ptrace", SetLastError: true)
func TraceChild(request int32, pid int32, address int64, data int64) int64;

@DllImport("libc", EntryPoint: "waitpid", SetLastError: true)
func WaitTrace(pid int32, out status int32, options int32) int32;

internal class ProcessSurvived : Exception {
    internal init(name string, identity string, stat string) : base(
        "Process survived cleanup: " + name + "; starttime=" + identity + "; stat=" + stat.Trim()
    ) { }
}

internal class ProcessChecks {
    shared {
        private let Seize int32 = 0x4206
        private let Continue int32 = 7
        private let TraceExitOption int64 = 0x40
        private let ExitEvent int32 = 6
        private let WaitAll int32 = 0x40000000

        internal func All() {
            Success()
            ExitObservation()
            InputDeadline()
            Cancellation()
            CancellationLifetime()
            Failures()
            OutputLimit()
            CapturePrefix()
            ScalarCapture()
            ReaderFailure()
            CaptureWriteFailure()
            CaptureSafety()
            AbruptStop()
        }

        private func Collected(root string, observed Chan[bool]? = nil) {
            for name in[]string{"parent.pid", "child.pid"} {
                Collect(root, name, observed)
            }
        }

        private func Fields(stat string)[]string -> stat.Substring(stat.LastIndexOf(')') + 2).Split(
            ' ',
            StringSplitOptions.RemoveEmptyEntries
        )

        private func Status(path string) string? {
            try {
                return File.ReadAllText(path)
            } catch (error FileNotFoundException) { } catch (error DirectoryNotFoundException) { } catch (
                error IOException
            ) {
                if error.HResult != 3 {
                    rethrow
                }
            }
            return nil
        }

        private func Collect(root string, name string, observed Chan[bool]? = nil, milliseconds int32 = 1000) {
            let path = Path.Combine(root, name)
            Check.That(File.Exists(path), "Process fixture did not start: " + name)
            let identity = Fields(File.ReadAllText(path + ".stat"))[19]
            let status = "/proc/" + File.ReadAllText(path).Trim() + "/stat"
            let clock = Stopwatch.StartNew()
            while true {
                let stat = Status(status)
                if stat == nil {
                    return
                }
                let fields = Fields(stat)
                if fields[19] != identity || fields[0] == "Z" {
                    return
                }
                if let signal = observed {
                    select {
                        case signal <- true { }
                        default { }
                    }
                }
                if clock.ElapsedMilliseconds >= milliseconds {
                    throw ProcessSurvived(name, identity, stat)
                }
                select {
                    case <- after(TimeSpan.FromMilliseconds(5.0)) { }
                }
            }
        }

        private func Script(delay string, consume string, detached bool = false) string ->
        "printf synthetic-partial-output; printf synthetic-partial-error >&2; cat /proc/$$$$/stat > parent.pid.stat; echo $$$$ > parent.pid; /bin/sh -c 'cat /proc/$$$$/stat > child.pid.stat; echo $$$$ > child.pid; exec /usr/bin/sleep 120'" +
            (detached ? " >/dev/null 2>&1": "") +
            " & while test ! -s child.pid; do sleep 0.005; done; sleep " +
            delay +
            "; " +
            consume

        private func ExitCollected(root string, observed Chan[bool], completed Chan[Exception?]) {
            var failure Exception? = nil
            try {
                Collected(root, observed)
            } catch (error Exception) {
                failure = error
            }
            completed <- failure
        }

        private func TraceExit(root string, release Stream, exiting Chan[bool], completed Chan[Exception?]) {
            var failure Exception? = nil
            var pid int32
            var attached bool
            try {
                let ready = Path.Combine(root, "child.pid")
                let clock = Stopwatch.StartNew()
                while !File.Exists(ready) || File.ReadAllText(ready).Trim() == "" {
                    Check.That(clock.ElapsedMilliseconds < 5000, "Owned child did not become ready")
                    select {
                        case <- after(TimeSpan.FromMilliseconds(5.0)) { }
                    }
                }
                pid = Int32.Parse(File.ReadAllText(ready).Trim())
                var survived bool
                try {
                    Collect(root, "child.pid", milliseconds: 25)
                } catch (error ProcessSurvived) {
                    survived = true
                }
                Check.That(survived, "Live descendant was accepted as collected")
                Check.That(
                    TraceChild(Seize, pid, 0, TraceExitOption) == 0,
                    "Cannot trace owned child: " + Marshal.GetLastPInvokeError().ToString()
                )
                attached = true
                File.WriteAllText(Path.Combine(root, "release-parent"), "ready")
                var status int32
                Check.That(
                    WaitTrace(pid, out status, WaitAll) == pid && status >> 16 == ExitEvent,
                    "Child did not enter the irreversible exit event"
                )
                exiting <- true
                Check.That(release.ReadByte() == 1, "Exit event release was not delivered")
                Check.That(TraceChild(Continue, pid, 0, 0) == 0, "Cannot release owned exit event")
                Check.That(
                    WaitTrace(pid, out status, WaitAll) == pid && status == 9,
                    "Owned child did not complete SIGKILL exit"
                )
                attached = false
            } catch (error Exception) {
                failure = error
            } finally {
                if attached {
                    TraceChild(Continue, pid, 0, 9)
                    var status int32
                    while WaitTrace(pid, out status, WaitAll) == pid && (status & 0xff) == 0x7f {
                        TraceChild(Continue, pid, 0, 9)
                    }
                }
            }
            completed <- failure
        }

        private func Joined(results[]Chan[Exception?]) {
            var failure Exception? = nil
            for result in results {
                select {
                    case let error = <- result {
                        failure = failure ?? error
                    }
                    case <- after(TimeSpan.FromSeconds(5.0)) {
                        failure = failure ?? Exception("Owned exit collection did not finish")
                    }
                }
            }
            if failure != nil {
                throw failure
            }
        }

        private func ExitObservation() {
            using let temp = Temp()
            using let release = AnonymousPipeServerStream(PipeDirection.Out)
            using let gate = AnonymousPipeClientStream(PipeDirection.In, release.ClientSafePipeHandle)
            let exiting = Chan[bool](1)
            let traced = Chan[Exception?](1)
            let observed = Chan[bool](1)
            let collected = Chan[Exception?](1)
            var collectorStarted bool
            go ProcessChecks.TraceExit(temp.Root, gate, exiting, traced)
            try {
                let result = Commands.Run(
                    "/bin/sh",
                    []string{"-c", Script("0", "while test ! -f release-parent; do sleep 0.005; done", true)},
                    temp.Root,
                    milliseconds: 5000
                )
                Check.That(result.Code == 0, "Controlled parent exit failed")
                select {
                    case <- exiting { }
                    case <- after(TimeSpan.FromSeconds(5.0)) {
                        throw Exception("Owned child did not report its irreversible exit event")
                    }
                }
                let pid = File.ReadAllText(Path.Combine(temp.Root, "child.pid")).Trim()
                let stat = File.ReadAllText("/proc/" + pid + "/stat")
                Check.That(Fields(stat)[0] == "t", "Exit fixture did not expose the non-zombie snapshot")
                go ProcessChecks.ExitCollected(temp.Root, observed, collected)
                collectorStarted = true
                select {
                    case <- observed { }
                    case <- after(TimeSpan.FromSeconds(5.0)) {
                        throw Exception("Collector did not observe the exiting descendant")
                    }
                }
            } finally {
                File.WriteAllText(Path.Combine(temp.Root, "release-parent"), "ready")
                release.WriteByte(1)
                Joined(collectorStarted ? []Chan[Exception?]{traced, collected}: []Chan[Exception?]{traced})
            }
            Console.WriteLine("PASS descendant exit observations wait for completion and reject live survivors")
        }

        private func Success() {
            using let temp = Temp()
            let result = Commands.Run(
                "/bin/sh",
                []string{"-c", Script("0.05", "wc -c; printf synthetic-stderr >&2")},
                temp.Root,
                String('x', 1024 * 1024),
                milliseconds: 5000,
                outputPath: Path.Combine(temp.Root, "stdout.log"),
                errorPath: Path.Combine(temp.Root, "stderr.log")
            )
            Check.That(result.Code == 0, "Piped input failed")
            Check.That(result.Output.Trim() == "synthetic-partial-output1048576", "Piped input was incomplete")
            Check.That(result.Error == "synthetic-partial-errorsynthetic-stderr", "Standard error was not collected")
            Check.That(
                File.ReadAllText(Path.Combine(temp.Root, "stdout.log")) == result.Output,
                "Captured stdout changed"
            )
            Check.That(
                File.ReadAllText(Path.Combine(temp.Root, "stderr.log")) == result.Error,
                "Captured stderr changed"
            )
            Check.That(!result.OutputTruncated && !result.ErrorTruncated, "Normal output reported truncation")
            Check.That(
                File.GetUnixFileMode(Path.Combine(temp.Root, "stdout.log")) ==
                (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                "Capture file was not private"
            )
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
                    milliseconds: 100,
                    outputPath: Path.Combine(temp.Root, "stdout.log"),
                    errorPath: Path.Combine(temp.Root, "stderr.log")
                )
            } catch (error CommandInterrupted) {
                Partial(temp.Root, error.Result)
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
                    cancellation: signal,
                    outputPath: Path.Combine(temp.Root, "stdout.log"),
                    errorPath: Path.Combine(temp.Root, "stderr.log")
                )
            } catch (error CommandInterrupted) {
                Partial(temp.Root, error.Result)
                Check.That(error.Message == "Command cancelled: /bin/sh", error.ToString())
                cancelled = true
            }
            Check.That(cancelled && clock.ElapsedMilliseconds < 1500, "Cancellation did not stop blocked stdin")
            Collected(temp.Root)
            signal <- true
            cancelled = false
            try {
                Commands.Run(
                    "/bin/sh",
                    []string{"-c", "touch unexpected-start"},
                    temp.Root,
                    cancellation: signal,
                    outputPath: Path.Combine(temp.Root, "prestart.log")
                )
            } catch (error Exception) {
                Check.That(error.Message == "Command cancelled: /bin/sh", error.ToString())
                cancelled = true
            }
            Check.That(
                cancelled && !File.Exists(Path.Combine(temp.Root, "unexpected-start")),
                "Pre-cancelled command started"
            )
            Check.That(!File.Exists(Path.Combine(temp.Root, "prestart.log")), "Pre-cancelled capture started")
            Console.WriteLine(
                "PASS blocked-input and pre-start cancellation retain their exception and collect descendants"
            )
        }

        private func CancellationLifetime() {
            for supplied in[]bool{false, true} {
                using let temp = Temp()
                let info = ProcessStartInfo("/usr/bin/setsid")
                info.WorkingDirectory = temp.Root
                for arg in[]string{"/bin/sh", "-c", "echo $$$$ > ready; exec /usr/bin/sleep 120"} {
                    info.ArgumentList.Add(arg)
                }
                using let process = Process.Start(info) ?? throw Exception("Cannot start cancellation lifetime fixture")
                let signal = Chan[bool](1)
                let callback = CommandCancellation(process, supplied ? signal: nil)
                let retained = Action(callback.Cancel)
                var disposed bool
                try {
                    let ready = Path.Combine(temp.Root, "ready")
                    for i in 0 ... 500 {
                        if File.Exists(ready) && File.ReadAllText(ready).Trim() == process.Id.ToString() {
                            break
                        }
                        select {
                            case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                        }
                    }
                    Check.That(
                        File.Exists(ready) && File.ReadAllText(ready).Trim() == process.Id.ToString(),
                        "Cancellation lifetime fixture did not become a process group leader"
                    )
                    retained()
                    Check.That(process.WaitForExit(5000), "Live cancellation callback did not stop the subprocess")
                    Check.That(process.ExitCode != 0, "Live cancellation callback turned cancellation into success")
                    var signalled bool
                    select {
                        case let value = <- signal {
                            signalled = value
                        }
                        default { }
                    }
                    Check.That(signalled == supplied, "Live cancellation callback changed cancellation signalling")
                    callback.Stop()
                    process.Dispose()
                    disposed = true
                    retained()
                    select {
                        case <- signal {
                            throw Exception("Retired cancellation callback signalled after teardown")
                        }
                        default { }
                    }
                } finally {
                    callback.Stop()
                    if !disposed {
                        if !process.HasExited {
                            process.Kill(true)
                        }
                        process.WaitForExit()
                    }
                    process.Dispose()
                }
            }
            Console.WriteLine("PASS retained cancellation callbacks stay safe after subprocess disposal")
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
            } catch (error CommandInputInterrupted) {
                Check.That(error.Result.Code == nil, "Stdin failure fabricated an exit code")
                broken = true
            }
            Check.That(broken, "Stdin failure lost its IOException")
            Console.WriteLine("PASS subprocess exit failures and stdin IOExceptions retain their meanings")
        }

        private func OutputLimit() {
            using let temp = Temp()
            let result = Commands.Run(
                "/bin/sh",
                []string{"-c", "head -c 34603008 /dev/zero; head -c 34603008 /dev/zero >&2"},
                milliseconds: 5000,
                outputPath: Path.Combine(temp.Root, "stdout.log"),
                errorPath: Path.Combine(temp.Root, "stderr.log")
            )
            Check.That(result.Code == 0, "Bounded output process failed")
            for text in[]string{result.Output, result.Error} {
                Check.That(
                    text.Length >= 32 * 1024 * 1024 && text.Length < 32 * 1024 * 1024 + 8192,
                    "Output limit changed"
                )
            }
            Check.That(result.OutputTruncated && result.ErrorTruncated && result.Truncated, "Overflow was hidden")
            Check.That(
                FileInfo(Path.Combine(temp.Root, "stdout.log")).Length == result.Output.Length,
                "Output capture unbounded"
            )
            Check.That(
                FileInfo(Path.Combine(temp.Root, "stderr.log")).Length == result.Error.Length,
                "Error capture unbounded"
            )
            let unicode = Commands.Run(
                "/bin/sh",
                []string{"-c", "yes é | head -c 68157440; printf finite-error >&2"},
                milliseconds: 5000,
                outputPath: Path.Combine(temp.Root, "unicode.log")
            )
            Check.That(unicode.OutputTruncated && !unicode.ErrorTruncated, "Per-stream truncation was lost")
            Check.That(unicode.Output.Length <= 32 * 1024 * 1024, "Decoded-text limit was widened")
            Check.That(
                FileInfo(Path.Combine(temp.Root, "unicode.log")).Length > 32 * 1024 * 1024,
                "Capture used a byte limit instead of decoded text"
            )
            Console.WriteLine("PASS subprocess drains both output pipes while retaining the existing output limits")
        }

        private func Partial(root string, result CommandResult) {
            Check.That(result.Output == "synthetic-partial-output", "Interrupted stdout was discarded")
            Check.That(result.Error == "synthetic-partial-error", "Interrupted stderr was discarded")
            Check.That(!result.OutputTruncated && !result.ErrorTruncated, "Partial streams were mislabelled")
            Check.That(File.ReadAllText(Path.Combine(root, "stdout.log")) == result.Output, "Stdout prefix not flushed")
            Check.That(File.ReadAllText(Path.Combine(root, "stderr.log")) == result.Error, "Stderr prefix not flushed")
        }

        private func PrefixReady(root string, completed Chan[bool]) {
            for i in 0 ... 1000 {
                let output = Path.Combine(root, "stdout.log")
                let error = Path.Combine(root, "stderr.log")
                if File.Exists(output) && File.Exists(error) && FileInfo(output).Length == 32 * 1024 * 1024 - 3 &&
                    FileInfo(error).Length == 32 * 1024 * 1024 - 3 {
                    File.WriteAllText(Path.Combine(root, "ack"), "ready")
                    completed <- true
                    return
                }
                select {
                    case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                }
            }
            completed <- false
        }

        private func CapturePrefix() {
            using let temp = Temp()
            File.WriteAllText(Path.Combine(temp.Root, "overflow"), "ABC" + String('x', 8192))
            let acknowledged = Chan[bool](1)
            go ProcessChecks.PrefixReady(temp.Root, acknowledged)
            let result = Commands.Run(
                "/bin/sh",
                []string{
                    "-c",
                    "head -c 33554429 /dev/zero; head -c 33554429 /dev/zero >&2; while test ! -f ack; do sleep 0.01; done; cat overflow; cat overflow >&2; printf after-cap-marker; printf after-cap-marker >&2"
                },
                temp.Root,
                milliseconds: 15000,
                outputPath: Path.Combine(temp.Root, "stdout.log"),
                errorPath: Path.Combine(temp.Root, "stderr.log")
            )
            Check.That(<-acknowledged && result.Code == 0, "Controlled overflow did not drain both streams")
            for text in[]string{result.Output, result.Error} {
                Check.That(text.Length == 32 * 1024 * 1024 && text.EndsWith("ABC"), "Capture retained a gap or tail")
                Check.That(!text.Contains("after-cap-marker"), "Capture resumed after the cap")
            }
            Check.That(result.OutputTruncated && result.ErrorTruncated, "Prefix truncation was hidden")
            Check.That(
                File.ReadAllText(Path.Combine(temp.Root, "stdout.log")) == result.Output,
                "Stdout prefix differs"
            )
            Check.That(File.ReadAllText(Path.Combine(temp.Root, "stderr.log")) == result.Error, "Stderr prefix differs")
            Console.WriteLine("PASS acknowledged overflow retains one prefix and drains both streams")
        }

        private func ScalarCapture() {
            using let temp = Temp()
            let expected = String('x', 8191) + Char.ConvertFromUtf32(0x10400) + "tail"
            let bytes = System.Text.Encoding.UTF8.GetBytes(expected)
            using let proof = StreamReader(MemoryStream(bytes))
            let boundary = [8192]char
            Check.That(
                proof.Read(boundary, 0, boundary.Length) == boundary.Length && Char.IsHighSurrogate(boundary[8191]) &&
                    Char.IsLowSurrogate(Convert.ToChar(proof.Read())),
                "The real UTF-8 reader did not split the supplementary scalar"
            )
            using let reader = StreamReader(MemoryStream(bytes))
            using let capture = Commands.Capture(Path.Combine(temp.Root, "split.log"))
            let output = Chan[CommandOutput](1)
            let failures = Chan[Exception](4)
            Commands.Read(reader, output, failures, capture)
            let split = <-output
            Check.That(split.Failure == nil && split.Text == expected, "Split scalar changed retained text")
            Check.That(
                File.ReadAllText(Path.Combine(temp.Root, "split.log")) == expected,
                "Encoder corrupted split scalar"
            )
            let result = Commands.Run(
                "/bin/sh",
                []string{
                    "-c",
                    "head -c 33554431 /dev/zero; printf '\\360\\220\\220\\200after-cap-marker'; head -c 33554431 /dev/zero >&2; printf '\\360\\220\\220\\200after-cap-marker' >&2"
                },
                milliseconds: 5000,
                outputPath: Path.Combine(temp.Root, "stdout.log"),
                errorPath: Path.Combine(temp.Root, "stderr.log")
            )
            Check.That(
                result.Code == 0 && result.OutputTruncated && result.ErrorTruncated,
                "Scalar overflow did not drain"
            )
            for text in[]string{result.Output, result.Error} {
                Check.That(text.Length == 32 * 1024 * 1024 - 1 && text[text.Length - 1] == '\0', "Cap split a scalar")
                Check.That(!text.Contains("after-cap-marker"), "Scalar overflow retained later markers")
            }
            Check.That(
                File.ReadAllText(Path.Combine(temp.Root, "stdout.log")) == result.Output,
                "Scalar stdout differs"
            )
            Check.That(File.ReadAllText(Path.Combine(temp.Root, "stderr.log")) == result.Error, "Scalar stderr differs")
            Console.WriteLine("PASS real UTF-8 split and capped scalar captures preserve complete text prefixes")
        }

        private func ReaderFailure() {
            using let temp = Temp()
            var failed bool
            try {
                Commands.Run(
                    "/bin/sh",
                    []string{"-c", Script("0.05", "printf '\\377'; sleep 120")},
                    temp.Root,
                    milliseconds: 5000,
                    strictOutput: true,
                    outputPath: Path.Combine(temp.Root, "stdout.log")
                )
            } catch (error CommandInterrupted) {
                Check.That(error.Result.ReadFailed, "Reader failure became success")
                Check.Contains(error.Result.Error, "synthetic-partial-error")
                failed = true
            }
            Check.That(failed, "Invalid UTF-8 became successful strict output")
            Collected(temp.Root)
            using let reader = StreamReader(
                MemoryStream(System.Text.Encoding.UTF8.GetBytes("synthetic-capture-failure"))
            )
            using let full = FileStream(
                "/dev/full",
                FileStreamOptions{
                    Mode: FileMode.Open,
                    Access: FileAccess.Write,
                    Share: FileShare.ReadWrite,
                    BufferSize: 1
                }
            )
            let output = Chan[CommandOutput](1)
            let failures = Chan[Exception](4)
            Commands.Read(reader, output, failures, full)
            let result = <-output
            Check.That(
                result.Failure != nil && result.Text == "synthetic-capture-failure",
                "Capture write failure became success"
            )
            Console.WriteLine("PASS strict reader and capture-write failures retain evidence")
        }

        internal func LimitedCapture(root string) {
            var failed bool
            let clock = Stopwatch.StartNew()
            try {
                Commands.Run(
                    "/bin/sh",
                    []string{"-c", Script("0.05", "head -c 16384 /dev/zero; sleep 120")},
                    root,
                    milliseconds: 5000,
                    outputPath: Path.Combine(root, "limited.log")
                )
            } catch (error CommandInterrupted) {
                Check.That(
                    error.Result.Code == nil && error.Result.ReadFailed,
                    "Capture failure became completed output"
                )
                Check.Contains(error.Result.Output, "synthetic-partial-output")
                Check.Contains(error.Result.Error, "synthetic-partial-error")
                Check.That(clock.ElapsedMilliseconds < 2000, "Capture failure bypassed immediate cleanup")
                failed = true
            }
            Check.That(failed, "File-size limit did not fail capture")
            Collected(root)
        }

        private func CaptureWriteFailure() {
            using let temp = Temp()
            Check.Success(
                TestProcess.Run(
                    "/bin/bash",
                    []string{
                        "-c",
                        "trap '' XFSZ; ulimit -f 1; exec \"$1\" --capture-write-failure \"$2\"",
                        "fixture",
                        Environment.ProcessPath ?? throw Exception("Missing test executable"),
                        temp.Root
                    },
                    temp.Env
                )
            )
            Check.That(
                FileInfo(Path.Combine(temp.Root, "limited.log")).Length <= 1024,
                "File-size fixture widened its limit"
            )
            Console.WriteLine("PASS capture-write failure propagates after real subprocess and descendant cleanup")
        }

        private func CaptureSafety() {
            using let temp = Temp()
            let sentinel = Path.Combine(temp.Root, "sentinel")
            File.WriteAllText(sentinel, "original-evidence")
            let link = Path.Combine(temp.Root, "link")
            File.CreateSymbolicLink(link, sentinel)
            let dangling = Path.Combine(temp.Root, "dangling")
            File.CreateSymbolicLink(dangling, sentinel + "-missing")
            for path in[]string{sentinel, link, dangling, temp.Root} {
                var refused bool
                try {
                    Commands.Run("/bin/sh", []string{"-c", "touch unexpected-start"}, temp.Root, outputPath: path)
                } catch (error Exception) {
                    refused = true
                }
                Check.That(
                    refused && !File.Exists(Path.Combine(temp.Root, "unexpected-start")),
                    "Unsafe capture started"
                )
                Check.That(File.ReadAllText(sentinel) == "original-evidence", "Existing evidence replaced")
            }
            let alias = Path.Combine(temp.Root, "alias")
            Directory.CreateSymbolicLink(alias, Path.Combine(temp.Root, "bin"))
            var refused bool
            try {
                Commands.Run("/bin/true", []string{}, outputPath: Path.Combine(alias, "output"))
            } catch (error Exception) {
                refused = true
            }
            Check.That(refused, "Capture followed a parent link")
            Commands.Run("/bin/true", []string{}, temp.Root)
            Check.That(Directory.GetFiles(temp.Root, "*.log").Length == 0, "Unrelated commands captured by default")
            Console.WriteLine("PASS capture refuses links and existing evidence and is opt-in")
        }

        internal func Prefix(root string) {
            Commands.Run(
                "/bin/sh",
                []string{"-c", Script("120", "exit 0")},
                root,
                seconds: 180,
                outputPath: Path.Combine(root, "stdout.log"),
                errorPath: Path.Combine(root, "stderr.log")
            )
        }

        private func AbruptStop() {
            using let temp = Temp()
            let info = ProcessStartInfo(Environment.ProcessPath ?? throw Exception("Missing test executable"))
            info.ArgumentList.Add("--capture-prefix")
            info.ArgumentList.Add(temp.Root)
            using let process = Process.Start(info) ?? throw Exception("Cannot start abrupt capture fixture")
            try {
                let output = Path.Combine(temp.Root, "stdout.log")
                let error = Path.Combine(temp.Root, "stderr.log")
                var ready bool
                for i in 0 ... 500 {
                    if File.Exists(output) && File.ReadAllText(output) == "synthetic-partial-output" && File.Exists(
                        error
                    ) &&
                        File.ReadAllText(error) == "synthetic-partial-error" && File.Exists(
                        Path.Combine(temp.Root, "child.pid")
                    ) {
                        ready = true
                        break
                    }
                    select {
                        case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                    }
                }
                Check.That(ready, "Prefix was not flushed before abrupt stop")
                process.Kill()
                process.WaitForExit()
                Check.That(File.ReadAllText(output) == "synthetic-partial-output", "SIGKILL lost stdout prefix")
                Check.That(File.ReadAllText(error) == "synthetic-partial-error", "SIGKILL lost stderr prefix")
            } finally {
                if !process.HasExited {
                    process.Kill()
                    process.WaitForExit()
                }
                let pid = Path.Combine(temp.Root, "parent.pid")
                if File.Exists(pid) {
                    Commands.Run("/usr/bin/kill", []string{"-KILL", "--", "-" + File.ReadAllText(pid).Trim()})
                }
            }
            Console.WriteLine("PASS flushed prefixes survive abrupt runner termination without terminal-state claims")
        }
    }
}
