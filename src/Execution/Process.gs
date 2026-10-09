package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text
import System.Text.Json

internal class CommandResult {
    internal var Code int32?
    internal var Output string = ""
    internal var Error string = ""
    internal var Truncated bool
    internal var ReadFailed bool
    internal var OutputTruncated bool
    internal var ErrorTruncated bool
}

internal class CommandOutput {
    internal var Text string = ""
    internal var Truncated bool
    internal var Failure Exception?
}

internal class CommandLines {
    private let Line StringBuilder = StringBuilder()
    private let Observe Action[string]
    private var Oversize bool

    internal init(observe Action[string]) {
        Observe = observe
    }

    internal func Flush() {
        if !Oversize && Line.Length > 0 {
            try {
                Observe.Invoke(Line.ToString())
            } catch (error Exception) { }
        }
        Line.Clear()
        Oversize = false
    }

    internal func Add(buffer[]char, count int32) {
        for i in 0 ... count {
            if buffer[i] == '\n' {
                Flush()
            } else if Line.Length < 65536 {
                Line.Append(buffer[i])
            } else {
                Oversize = true
            }
        }
    }
}

internal class CommandInterrupted : Exception {
    internal let Result CommandResult

    internal init(error Exception, result CommandResult) : base(error.Message, error) {
        Result = result
    }
}

internal class CommandInputInterrupted : IOException {
    internal let Result CommandResult

    internal init(error IOException, result CommandResult) : base(error.Message, error) {
        Result = result
    }
}

@DllImport("libc", EntryPoint: "kill")
func KillGroup(pid int32, signal int32) int32;

internal class CommandCancellation {
    private let Process Process
    private let Signal Chan[bool]?
    private let Lifetime Chan[bool] = Chan[bool](1)

    internal init(process Process, signal Chan[bool]?) {
        Process = process
        Signal = signal
        Lifetime <- true
    }

    internal func Cancel() {
        let active = <-Lifetime
        try {
            if !active {
                return
            }
            if let signal = Signal {
                select {
                    case signal <- true { }
                    default { }
                }
            }
            KillGroup(-Process.Id, 9)
        } finally {
            Lifetime <- active
        }
    }

    internal func OnCancel(sender Object?, event ConsoleCancelEventArgs) {
        if Signal != nil {
            event.Cancel = true
        }
        Cancel()
    }

    internal func Stop() {
        <-Lifetime
        Lifetime <- false
    }
}

internal class RuntimeBudget {
    private let Timer Stopwatch
    private let Seconds int32

    internal init(timer Stopwatch, seconds int32) {
        Timer = timer
        Seconds = seconds
    }

    internal func Expired() bool -> Seconds > 0 && Timer.Elapsed.TotalSeconds >= Seconds

    internal func Left() string -> Seconds == 0 ? "unlimited": Math.Max(
        0,
        Math.Ceiling(Seconds - Timer.Elapsed.TotalSeconds)
    )
        .ToString() + "s"

    internal func Status() string -> Math.Floor(Timer.Elapsed.TotalSeconds).ToString() +
        "s elapsed, " +
        (Seconds == 0 ? "no time limit": Left() + " remaining")

    internal func Remaining() int32 {
        if Seconds == 0 {
            return -1
        }
        let remaining = Math.Floor(Seconds * 1000.0 - Timer.Elapsed.TotalMilliseconds)
        if remaining < 1 {
            throw Exception("Runtime allowance exhausted")
        }
        return Convert.ToInt32(remaining)
    }

    internal func Git(checkout string, args ...string) string ->
    Commands.GitOutput(Commands.GitResult(checkout, args, budget: this))

    shared {
        internal func ReadSeconds(args Args, fallback string = "") int32 -> args.Get("unlimited") == "true" ?
        args.Number("verification-reserve"): args.Number("seconds", fallback)

        internal func Reserve(args Args, seconds int32) int32 {
            let reserve = args.Get("verification-reserve") == "" ? 0: args.Number("verification-reserve")
            if args.Get("unlimited") == "true" {
                if reserve < 1 || reserve != seconds {
                    throw Exception("Unlimited coding requires a separate positive verification budget")
                }
            } else if reserve >= seconds {
                throw Exception("--verification-reserve must be strictly smaller than the total budget")
            }
            return reserve
        }

        internal func Validate(run Data) {
            let unlimited = J.Get(run.Element(), "unlimited")
            if unlimited.ValueKind != JsonValueKind.Undefined &&
                unlimited.ValueKind != JsonValueKind.True &&
                unlimited.ValueKind != JsonValueKind.False {
                throw Exception("Invalid saved unlimited coding choice")
            }
            if run.Flag("unlimited") &&
                (
                run.Number("version") != 2 || run.Text("source") != "tokate" || run.Number(
                    "verification_reserve"
                ) < 1 ||
                    run.Number("verification_reserve") != run.Number("seconds")
            ) {
                throw Exception("Unlimited coding requires managed v2 work and a separate positive verification budget")
            }
            let field = J.Get(run.Element(), "verification_reserve")
            var reserve int32
            if field.ValueKind != JsonValueKind.Undefined &&
                (
                field.ValueKind != JsonValueKind.Number || !field.TryGetInt32(out reserve) ||
                    reserve < 1 ||
                    (run.Flag("unlimited") ? reserve != run.Number("seconds"): reserve >= run.Number("seconds"))
            ) {
                throw Exception("Invalid saved verification reserve")
            }
        }

        internal func Description(run Data) string {
            let total = run.Number("seconds")
            let reserve = run.Number("verification_reserve")
            if run.Flag("unlimited") {
                return "unlimited coding time; independent verification budget " + reserve.ToString() + "s"
            }
            return "total allowance " + total.ToString() + "s, coding allowance " + (total - reserve).ToString() +
                "s, verification reserve " +
                reserve.ToString() + "s"
        }
    }
}

internal class Commands {
    shared {
        internal func InterruptedResult(error Exception) CommandResult? -> switch error {
            case interrupted is CommandInterrupted: interrupted.Result
            case interrupted is CommandInputInterrupted: interrupted.Result
            default: nil
        }

        internal func Capture(path string) FileStream? {
            if path == "" {
                return nil
            }
            LocalPaths.DirectoryPath(Path.GetDirectoryName(Path.GetFullPath(path)) ?? "/")
            return FileStream(
                path,
                FileStreamOptions{
                    Mode: FileMode.CreateNew,
                    Access: FileAccess.Write,
                    Share: FileShare.Read,
                    BufferSize: 1,
                    UnixCreateMode: UnixFileMode.UserRead | UnixFileMode.UserWrite
                }
            )
        }

        internal func Read(
            reader StreamReader,
            output Chan[CommandOutput],
            failed Chan[Exception],
            capture FileStream? = nil,
            observe Action[string]? = nil
        ) {
            let result = CommandOutput()
            let text = StringBuilder()
            var lines CommandLines? = nil
            if let observer = observe {
                lines = CommandLines(observer)
            }
            try {
                using let writer StreamWriter? = capture == nil ? nil: StreamWriter(
                    capture,
                    UTF8Encoding(false),
                    8192,
                    true
                )
                if writer != nil {
                    writer.AutoFlush = true
                }
                let buffer = [8192]char
                var count int32
                while (count = reader.Read(buffer, 0, buffer.Length)) > 0 {
                    var retained = result.Truncated ? 0: Math.Min(count, 32 * 1024 * 1024 - text.Length)
                    if retained > 0 && text.Length + retained == 32 * 1024 * 1024 && Char.IsHighSurrogate(
                        buffer[retained - 1]
                    ) {
                        retained -= 1
                    }
                    result.Truncated = result.Truncated || retained < count
                    if retained > 0 {
                        text.Append(buffer, 0, retained)
                        lines?.Add(buffer, retained)
                        if writer != nil && result.Failure == nil {
                            try {
                                writer.Write(buffer, 0, retained)
                            } catch (error Exception) {
                                result.Failure = error
                                failed <- error
                            }
                        }
                    }
                }
            } catch (error Exception) {
                result.Failure = error
                failed <- error
            }
            lines?.Flush()
            result.Text = text.ToString()
            output <- result
        }

        private func Collect(result CommandResult, output CommandOutput, error CommandOutput) {
            result.Output = output.Text
            result.Error = error.Text
            result.OutputTruncated = output.Truncated
            result.ErrorTruncated = error.Truncated
            result.Truncated = output.Truncated || error.Truncated
            result.ReadFailed = output.Failure != nil || error.Failure != nil
        }

        private func Write(writer StreamWriter, input string?, completed Chan[Exception?]) {
            var failure Exception? = nil
            try {
                if input != nil {
                    writer.Write(input)
                }
            } catch (error Exception) {
                failure = error
            } finally {
                try {
                    writer.Close()
                } catch (error Exception) {
                    if failure == nil {
                        failure = error
                    }
                }
            }
            completed <- failure
        }

        internal func Wait(info ProcessStartInfo, started Chan[Process?], completed Chan[Exception?]) {
            var process Process? = nil
            var failure Exception? = nil
            try {
                process = Process.Start(info) ?? throw Exception("Cannot start " + info.ArgumentList[0])
            } catch (error Exception) {
                failure = error
            }
            started <- process
            if let child = process {
                try {
                    child.WaitForExit()
                } catch (error Exception) {
                    failure = error
                }
            }
            completed <- failure
        }

        internal func Run(
            exe string,
            args[]string,
            cwd string = "",
            input string? = nil,
            seconds int32 = 60,
            harness bool = false,
            github bool = false,
            isolated bool = false,
            milliseconds int32 = 0,
            cancellation Chan[bool]? = nil,
            strictOutput bool = false,
            outputPath string = "",
            errorPath string = "",
            budget RuntimeBudget? = nil,
            pidNamespace bool = false,
            outputLine Action[string]? = nil,
            errorLine Action[string]? = nil
        ) CommandResult {
            let info = ProcessStartInfo(isolated ? LocalPaths.NeedSystemTool("setsid", cwd): "setsid")
            if !pidNamespace {
                let unshare = LocalPaths.SystemTool("unshare", cwd)
                let environment = LocalPaths.SystemTool("env", cwd)
                if !OperatingSystem.IsLinux() || !LocalPaths.Executable(unshare) || !LocalPaths.Executable(
                    environment
                ) {
                    throw CliFailure(
                        "missing_tools",
                        "Command cleanup requires Linux, unshare, and env",
                        summary: "PID namespace prerequisite is unavailable"
                    )
                }
                info.ArgumentList.Add(unshare)
                info.ArgumentList.Add("--map-current-user")
                info.ArgumentList.Add("--pid")
                info.ArgumentList.Add("--fork")
                info.ArgumentList.Add("--kill-child")
                info.ArgumentList.Add("--mount-proc")
                info.ArgumentList.Add("--")
                info.ArgumentList.Add(environment)
                info.ArgumentList.Add("-u")
                info.ArgumentList.Add("LC_ALL")
                info.ArgumentList.Add("--")
            }
            info.ArgumentList.Add(exe)
            info.UseShellExecute = false
            info.RedirectStandardOutput = true
            info.RedirectStandardError = true
            info.RedirectStandardInput = true
            if cwd != "" {
                info.WorkingDirectory = cwd
            }
            for arg in args {
                info.ArgumentList.Add(arg)
            }
            info.Environment.Clear()
            let requirements = List[string]{"PATH", "HOME", "LANG"}
            if harness {
                requirements.Add("CODEX_HOME")
            }
            if github {
                requirements.AddRange(
                    []string{
                        "GH_TOKEN",
                        "GITHUB_TOKEN",
                        "GH_CONFIG_DIR",
                        "XDG_CONFIG_HOME",
                        "DBUS_SESSION_BUS_ADDRESS",
                        "XDG_RUNTIME_DIR"
                    }
                )
            }
            for key in requirements {
                if isolated {
                    continue
                }
                if let value = Environment.GetEnvironmentVariable(key) {
                    info.Environment[key] = value
                }
            }
            if isolated {
                info.Environment["PATH"] = "/usr/local/bin:/usr/bin:/bin"
            }
            let certificates = LocalPaths.Certificates()
            if certificates != "" {
                info.Environment["SSL_CERT_FILE"] = certificates
                info.Environment["GIT_SSL_CAINFO"] = certificates
                info.Environment["CURL_CA_BUNDLE"] = certificates
            }
            info.Environment["GH_HOST"] = "github.com"
            info.Environment["GH_PROMPT_DISABLED"] = "1"
            info.Environment["GIT_TERMINAL_PROMPT"] = "0"
            info.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
            info.Environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
            info.Environment["GIT_NO_REPLACE_OBJECTS"] = "1"
            info.Environment["GIT_GRAFT_FILE"] = "/dev/null"
            if !pidNamespace {
                info.Environment["LC_ALL"] = "C"
            }
            if let signal = cancellation {
                select {
                    case <- signal {
                        throw Exception("Command cancelled: " + exe)
                    }
                    default { }
                }
            }
            using let outputCapture = Capture(outputPath)
            using let errorCapture = Capture(errorPath)
            let requested = milliseconds > 0 ? milliseconds: seconds * 1000
            let remaining = budget?.Remaining() ?? -1
            let limit = requested > 0 && remaining > 0 ? Math.Min(requested, remaining): Math.Max(requested, remaining)
            let allowance = TimeSpan.FromMilliseconds(limit > 0 ? limit: -1)
            let started = Chan[Process?](1)
            let exited = Chan[Exception?](1)
            let stdin = Chan[Exception?](1)
            let stdout = Chan[CommandOutput](1)
            let stderr = Chan[CommandOutput](1)
            let cancelled = cancellation ?? Chan[bool](1)
            let result = CommandResult()
            let failed = Chan[Exception](4)
            let clock = Stopwatch.StartNew()
            using let deadline = after(allowance)
            go Commands.Wait(info, started, exited)
            let launched = <-started
            if launched == nil {
                let failure = <-exited
                throw failure ?? Exception("Cannot start " + exe)
            }
            using let process = launched
            var outputReader StreamReader? = nil
            var callback CommandCancellation? = nil
            var onCancel ConsoleCancelEventHandler? = nil
            var inputStarted bool
            var outputStarted bool
            var errorStarted bool
            var ready bool
            var inputDone bool
            var outputDone bool
            var errorDone bool
            var exitDone bool
            var inputFailed bool
            var output = CommandOutput()
            var stderrOutput = CommandOutput()
            var terminal Exception? = nil
            try {
                let reader = strictOutput ? StreamReader(
                    process.StandardOutput.BaseStream,
                    UTF8Encoding(false, true),
                    false
                ): process.StandardOutput
                outputReader = reader
                let active = CommandCancellation(process, cancellation)
                callback = active
                let handler = ConsoleCancelEventHandler(active.OnCancel)
                Console.CancelKeyPress += handler
                onCancel = handler
                go Commands.Write(process.StandardInput, input, stdin)
                inputStarted = true
                go Commands.Read(reader, stdout, failed, outputCapture, outputLine)
                outputStarted = true
                go Commands.Read(process.StandardError, stderr, failed, errorCapture, errorLine)
                errorStarted = true
                ready = true
                while !inputDone || !outputDone || !errorDone || !exitDone {
                    if (limit > 0 && clock.Elapsed >= allowance) || (budget?.Expired() ?? false) {
                        throw Exception("Runtime limit reached for " + exe)
                    }
                    var failure Exception? = nil
                    select {
                        case let error = <- stdin {
                            inputDone = true
                            failure = error
                            inputFailed = error != nil
                        }
                        case let captured = <- stdout {
                            outputDone = true
                            output = captured
                            failure = captured.Failure
                        }
                        case let captured = <- stderr {
                            errorDone = true
                            stderrOutput = captured
                            failure = captured.Failure
                        }
                        case let error = <- exited {
                            exitDone = true
                            KillGroup(-process.Id, 9)
                            failure = error
                        }
                        case let error = <- failed {
                            throw error
                        }
                        case <- cancelled {
                            throw Exception("Command cancelled: " + exe)
                        }
                        case <- deadline {
                            throw Exception("Runtime limit reached for " + exe)
                        }
                    }
                    select {
                        case <- cancelled {
                            throw Exception("Command cancelled: " + exe)
                        }
                        default { }
                    }
                    if (limit > 0 && clock.Elapsed >= allowance) || (budget?.Expired() ?? false) {
                        throw Exception("Runtime limit reached for " + exe)
                    }
                    if let error = failure {
                        throw error
                    }
                }
                result.Code = process.ExitCode
            } catch (error Exception) {
                terminal = error
            } finally {
                if let handler = onCancel {
                    Console.CancelKeyPress -= handler
                }
                if let active = callback {
                    active.Stop()
                }
                KillGroup(-process.Id, 9)
                if !process.HasExited {
                    try {
                        process.Kill(true)
                    } catch (error InvalidOperationException) { }
                }
                process.WaitForExit()
                if !exitDone {
                    <-exited
                }
                if inputStarted && !inputDone {
                    <-stdin
                }
                if outputStarted && !outputDone {
                    output = <-stdout
                }
                if errorStarted && !errorDone {
                    stderrOutput = <-stderr
                }
                outputReader?.Dispose()
            }
            Collect(result, output, stderrOutput)
            if terminal == nil {
                select {
                    case <- cancelled {
                        terminal = Exception("Command cancelled: " + exe)
                    }
                    default { }
                }
                if (limit > 0 && clock.Elapsed >= allowance) || (budget?.Expired() ?? false) {
                    terminal = Exception("Runtime limit reached for " + exe)
                }
            }
            terminal = terminal ?? output.Failure ?? stderrOutput.Failure
            if let error = terminal {
                result.Code = nil
                if !ready {
                    throw error
                }
                if error is IOException io && inputFailed {
                    throw CommandInputInterrupted(io, result)
                }
                throw CommandInterrupted(error, result)
            }
            if !pidNamespace && result.Code != 0 {
                for prefix in[]string{"setsid: failed to execute ", "unshare: failed to execute "} {
                    if result.Error.StartsWith(prefix, StringComparison.Ordinal) {
                        throw CliFailure(
                            "missing_tools",
                            "A PID namespace command helper could not execute. Repair the helper, then run tokate doctor."
                        )
                    }
                }
                for prefix in[]string{
                    "unshare: unshare failed:",
                    "unshare: mount /proc failed:",
                    "unshare: mount proc on /proc failed:",
                    "unshare: write failed /proc/self/",
                    "unshare: failed to write /proc/self/",
                    "unshare: failed to open /proc/self/",
                    "unshare: setgroups failed:"
                } {
                    if result.Error.StartsWith(prefix, StringComparison.Ordinal) {
                        throw LinuxSandbox.NamespaceFailure()
                    }
                }
            }
            return result
        }

        internal func Checked(
            exe string,
            args[]string,
            cwd string = "",
            input string? = nil,
            seconds int32 = 60,
            harness bool = false,
            github bool = false
        ) string {
            let result = Run(exe, args, cwd, input, seconds, harness, github)
            if result.Code != 0 {
                throw CliFailure(
                    "command_failed",
                    exe + " failed: " + result.Error + result.Output,
                    summary: exe + " failed. Inspect private artifacts when available."
                )
            }
            return result.Output.Trim()
        }

        internal func GitResult(cwd string, args[]string, raw bool = false, budget RuntimeBudget? = nil) CommandResult {
            let all = List[string]{
                "--no-replace-objects",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.file.allow=never",
                "-c",
                "protocol.ext.allow=never"
            }
            all.AddRange(args)
            return Run(
                "git",
                all.ToArray(),
                cwd,
                github: Array.IndexOf(args, "credential.helper=!gh auth git-credential") >= 0,
                strictOutput: raw,
                budget: budget
            )
        }

        internal func Git(cwd string, args ...string) string -> GitOutput(GitResult(cwd, args))

        internal func GitOutput(result CommandResult) string {
            if result.Code != 0 {
                throw Exception("git failed: " + result.Error + result.Output)
            }
            return result.Output.Trim()
        }

        internal func GitRaw(cwd string, args[]string, budget RuntimeBudget? = nil) string {
            try {
                let result = GitResult(cwd, args, true, budget)
                if result.Code != 0 || result.Truncated || result.ReadFailed || Encoding.UTF8.GetByteCount(
                    result.Output
                ) > 32 * 1024 * 1024 {
                    throw Exception("Cannot read complete Git path evidence: " + result.Error)
                }
                return result.Output
            } catch (error CommandInterrupted) {
                if error.Result.ReadFailed && error.InnerException is DecoderFallbackException {
                    throw Exception("Cannot read complete Git path evidence", error)
                }
                throw error
            }
        }
    }
}
