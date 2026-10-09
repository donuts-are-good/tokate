package Tokate

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.Runtime.ExceptionServices

internal class Installation {
    shared {
        internal func Run(command string) int32 -> Execute(
            "/bin/sh",
            []string{"-s", "--", command, Environment.ProcessPath ?? ""},
            ApplicationInfo.Resource("install.sh")
        )

        internal func Execute(executable string, args[]string, input string? = nil, capture bool = false) int32 {
            let info = ProcessStartInfo(executable)
            info.UseShellExecute = false
            info.RedirectStandardInput = input != nil
            info.RedirectStandardOutput = PublicOutput.Enabled || capture
            info.RedirectStandardError = PublicOutput.Enabled || capture
            for arg in args {
                info.ArgumentList.Add(arg)
            }
            info.Environment.Clear()
            for key in[]string{
                "HOME",
                "PATH",
                "SHELL",
                "LANG",
                "TERM",
                "ZDOTDIR",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "TMPDIR"
            } {
                if let value = Environment.GetEnvironmentVariable(key) {
                    info.Environment[key] = value
                }
            }
            let started = Chan[Process?](1)
            let exited = Chan[Exception?](1)
            let output = Chan[CommandOutput](1)
            let error = Chan[CommandOutput](1)
            let failed = Chan[Exception](4)
            go Commands.Wait(info, started, exited)
            let launched = <-started
            if launched == nil {
                throw <-exited ?? Exception("Cannot start the installer")
            }
            using let process = launched
            let cancel = ConsoleCancelEventHandler(
                (sender Object?, event ConsoleCancelEventArgs) -> {
                    event.Cancel = true
                    try {
                        if !process.HasExited {
                            process.Kill(true)
                        }
                    } catch (failure Exception) { }
                }
            )
            Console.CancelKeyPress += cancel
            var outputStarted bool
            var errorStarted bool
            var exitDone bool
            var terminal Exception? = nil
            var stdout = CommandOutput()
            var stderr = CommandOutput()
            try {
                if info.RedirectStandardOutput {
                    go Commands.Read(process.StandardOutput, output, failed)
                    outputStarted = true
                }
                if info.RedirectStandardError {
                    go Commands.Read(process.StandardError, error, failed)
                    errorStarted = true
                }
                if input != nil {
                    process.StandardInput.Write(input)
                    process.StandardInput.Close()
                }
                select {
                    case let failure = <- exited {
                        terminal = failure
                        exitDone = true
                    }
                    case let failure = <- failed {
                        throw failure
                    }
                }
            } catch (failure Exception) {
                terminal = failure
            } finally {
                Console.CancelKeyPress -= cancel
                try {
                    if !process.HasExited {
                        try {
                            process.Kill(true)
                        } catch (failure InvalidOperationException) { }
                    }
                    process.WaitForExit()
                } catch (failure Exception) {
                    terminal = terminal ?? failure
                }
                if !exitDone {
                    let failure = <-exited
                    terminal = terminal ?? failure
                }
                try {
                    if info.RedirectStandardInput {
                        process.StandardInput.Close()
                    }
                } catch (failure Exception) {
                    terminal = terminal ?? failure
                }
                if outputStarted {
                    stdout = <-output
                }
                if errorStarted {
                    stderr = <-error
                }
            }
            if let failure = terminal {
                ExceptionDispatchInfo.Capture(failure).Throw()
            }
            if outputStarted || errorStarted {
                if stdout.Failure != nil || stderr.Failure != nil {
                    throw CliFailure("command_failed", "Cannot read installer diagnostics")
                }
                PublicOutput.Truncated = PublicOutput.Truncated || stdout.Truncated || stderr.Truncated
                Console.Error.Write(PublicOutput.Prose(stdout.Text))
                Console.Error.Write(PublicOutput.Prose(stderr.Text))
            }
            return process.ExitCode
        }
    }
}
