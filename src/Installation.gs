package Tokate

import Gsharp.Concurrency
import System
import System.Diagnostics

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
            using let process = Process.Start(info) ?? throw Exception("Cannot start the installer")
            let output = Chan[CommandOutput](1)
            let error = Chan[CommandOutput](1)
            let failed = Chan[Exception](4)
            if PublicOutput.Enabled {
                go Commands.Read(process.StandardOutput, output, failed)
                go Commands.Read(process.StandardError, error, failed)
            }
            process.StandardInput.Write(Data.Resource("install.sh"))
            process.StandardInput.Close()
            process.WaitForExit()
            if PublicOutput.Enabled {
                let stdout = <-output
                let stderr = <-error
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
