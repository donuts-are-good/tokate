package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text

internal class CommandResult {
    internal var Code int32
    internal var Output string = ""
    internal var Error string = ""
    internal var Truncated bool
    internal var ReadFailed bool
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

internal class Commands {
    shared {
        internal func Read(reader StreamReader, output Chan[string], result CommandResult) {
            try {
                let text = StringBuilder()
                let buffer = [8192]char
                var count int32
                while (count = reader.Read(buffer, 0, buffer.Length)) > 0 {
                    if text.Length + count <= 32 * 1024 * 1024 {
                        text.Append(buffer, 0, count)
                    } else {
                        result.Truncated = true
                    }
                }
                output <- text.ToString()
            } catch (error Exception) {
                result.ReadFailed = true
                output <- error.Message
            }
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

        private func Wait(process Process, completed Chan[Exception?]) {
            var failure Exception? = nil
            try {
                process.WaitForExit()
            } catch (error Exception) {
                failure = error
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
            strictOutput bool = false
        ) CommandResult {
            let info = ProcessStartInfo(isolated ? "/usr/bin/setsid": "setsid")
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
            info.Environment["GH_HOST"] = "github.com"
            info.Environment["GH_PROMPT_DISABLED"] = "1"
            info.Environment["GIT_TERMINAL_PROMPT"] = "0"
            info.Environment["GIT_CONFIG_NOSYSTEM"] = "1"
            info.Environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
            info.Environment["GIT_NO_REPLACE_OBJECTS"] = "1"
            info.Environment["GIT_GRAFT_FILE"] = "/dev/null"
            if let signal = cancellation {
                select {
                    case <- signal {
                        throw Exception("Command cancelled: " + exe)
                    }
                    default { }
                }
            }
            let allowance = TimeSpan.FromMilliseconds(milliseconds > 0 ? milliseconds: seconds * 1000)
            let clock = Stopwatch.StartNew()
            using let process = Process.Start(info) ?? throw Exception("Cannot start " + exe)
            using let outputReader = strictOutput ? StreamReader(
                process.StandardOutput.BaseStream,
                UTF8Encoding(false, true),
                false
            ): process.StandardOutput
            using let deadline = after(
                TimeSpan.FromMilliseconds(Math.Max(0.0, (allowance - clock.Elapsed).TotalMilliseconds))
            )
            let stdin = Chan[Exception?](1)
            let stdout = Chan[string](1)
            let stderr = Chan[string](1)
            let exited = Chan[Exception?](1)
            let cancelled = cancellation ?? Chan[bool](1)
            go Commands.Write(process.StandardInput, input, stdin)
            let result = CommandResult()
            go Commands.Read(outputReader, stdout, result)
            go Commands.Read(process.StandardError, stderr, result)
            go Commands.Wait(process, exited)
            let callback = CommandCancellation(process, cancellation)
            let onCancel = ConsoleCancelEventHandler(callback.OnCancel)
            Console.CancelKeyPress += onCancel
            var inputDone bool
            var outputDone bool
            var errorDone bool
            var exitDone bool
            try {
                while !inputDone || !outputDone || !errorDone || !exitDone {
                    if clock.Elapsed >= allowance {
                        throw Exception("Runtime limit reached for " + exe)
                    }
                    var failure Exception? = nil
                    select {
                        case let error = <- stdin {
                            inputDone = true
                            failure = error
                        }
                        case let output = <- stdout {
                            outputDone = true
                            result.Output = output
                        }
                        case let error = <- stderr {
                            errorDone = true
                            result.Error = error
                        }
                        case let error = <- exited {
                            exitDone = true
                            KillGroup(-process.Id, 9)
                            failure = error
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
                    if clock.Elapsed >= allowance {
                        throw Exception("Runtime limit reached for " + exe)
                    }
                    if let error = failure {
                        throw error
                    }
                }
                result.Code = process.ExitCode
            } finally {
                Console.CancelKeyPress -= onCancel
                callback.Stop()
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
                if !inputDone {
                    <-stdin
                }
                if !outputDone {
                    <-stdout
                }
                if !errorDone {
                    <-stderr
                }
            }
            select {
                case <- cancelled {
                    throw Exception("Command cancelled: " + exe)
                }
                default { }
            }
            if clock.Elapsed >= allowance {
                throw Exception("Runtime limit reached for " + exe)
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

        internal func GitResult(cwd string, args[]string, raw bool = false) CommandResult {
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
                strictOutput: raw
            )
        }

        internal func Git(cwd string, args ...string) string {
            let result = GitResult(cwd, args)
            if result.Code != 0 {
                throw Exception("git failed: " + result.Error + result.Output)
            }
            return result.Output.Trim()
        }

        internal func GitRaw(cwd string, args[]string) string {
            let result = GitResult(cwd, args, true)
            if result.Code != 0 || result.Truncated || result.ReadFailed || Encoding.UTF8.GetByteCount(
                result.Output
            ) > 32 * 1024 * 1024 {
                throw Exception("Cannot read complete Git path evidence: " + result.Error)
            }
            return result.Output
        }
    }
}
