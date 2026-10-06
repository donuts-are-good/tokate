package Tokate

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.Runtime.ExceptionServices

internal class Installation {
    shared {
        internal func Run(command string) int32 {
            let info = ProcessStartInfo("/bin/sh")
            info.UseShellExecute = false
            info.RedirectStandardInput = true
            info.RedirectStandardOutput = PublicOutput.Enabled
            info.RedirectStandardError = PublicOutput.Enabled
            info.ArgumentList.Add("-s")
            info.ArgumentList.Add("--")
            info.ArgumentList.Add(command)
            info.ArgumentList.Add(Environment.ProcessPath ?? "")
            info.Environment.Clear()
            for key in[]string{"HOME", "PATH", "SHELL", "LANG", "ZDOTDIR", "XDG_CONFIG_HOME", "TMPDIR"} {
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
                process.StandardInput.Write(ApplicationInfo.Resource("install.sh"))
                process.StandardInput.Close()
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
                    process.StandardInput.Close()
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
