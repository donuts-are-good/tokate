package Tokate

import System
import System.Diagnostics

internal class Installation {
    shared {
        internal func Run(command string) int32 {
            let info = ProcessStartInfo("/bin/sh")
            info.UseShellExecute = false
            info.RedirectStandardInput = true
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
            process.StandardInput.Write(Data.Resource("install.sh"))
            process.StandardInput.Close()
            process.WaitForExit()
            return process.ExitCode
        }
    }
}
