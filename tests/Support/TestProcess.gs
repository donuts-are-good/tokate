package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO

internal class TestProcess {
    shared {
        internal func Read(reader StreamReader, result Chan[string]) {
            result <- reader.ReadToEnd()
        }

        internal func Run(
            exe string,
            args[]string,
            env Dictionary[string, string],
            input string? = nil,
            cwd string = ""
        ) Result {
            let info = ProcessStartInfo(exe)
            info.UseShellExecute = false
            info.RedirectStandardInput = true
            info.RedirectStandardOutput = true
            info.RedirectStandardError = true
            info.Environment.Clear()
            for entry in env {
                info.Environment[entry.Key] = entry.Value
            }
            for arg in args {
                info.ArgumentList.Add(arg)
            }
            if cwd != "" {
                info.WorkingDirectory = cwd
            }
            using let process = Process.Start(info) ?? throw Exception("Cannot start " + exe)
            let output = Chan[string](1)
            let error = Chan[string](1)
            go Read(process.StandardOutput, output)
            go Read(process.StandardError, error)
            if input != nil {
                process.StandardInput.Write(input)
            }
            process.StandardInput.Close()
            if !process.WaitForExit(120000) {
                process.Kill(true)
                process.WaitForExit()
                throw Exception("Test process timed out: " + exe)
            }
            return Result{Code: process.ExitCode, Output: <-output, Error: <-error}
        }
    }
}
