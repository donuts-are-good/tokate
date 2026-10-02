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
}

@DllImport("libc", EntryPoint: "kill")
func KillGroup(pid int32, signal int32) int32;

internal class Commands {
    shared {
        internal func Read(reader StreamReader, output Chan[string]) {
            try {
                let text = StringBuilder()
                let buffer = [8192]char
                var count int32
                while (count = reader.Read(buffer, 0, buffer.Length)) > 0 {
                    if text.Length < 32 * 1024 * 1024 {
                        text.Append(buffer, 0, count)
                    }
                }
                output <- text.ToString()
            } catch (error Exception) {
                output <- error.Message
            }
        }

        internal func Run(
            exe string,
            args[]string,
            cwd string = "",
            input string? = nil,
            seconds int32 = 60,
            harness bool = false,
            github bool = false,
            isolated bool = false
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
            using let process = Process.Start(info) ?? throw Exception("Cannot start " + exe)
            let stdout = Chan[string](1)
            let stderr = Chan[string](1)
            go Commands.Read(process.StandardOutput, stdout)
            go Commands.Read(process.StandardError, stderr)
            let onCancel = ConsoleCancelEventHandler(
                (sender Object?, event ConsoleCancelEventArgs) -> {
                    KillGroup(-process.Id, 9)
                }
            )
            Console.CancelKeyPress += onCancel
            try {
                if input != nil {
                    process.StandardInput.Write(input)
                }
                process.StandardInput.Close()
                if !process.WaitForExit(seconds * 1000) {
                    KillGroup(-process.Id, 9)
                    process.WaitForExit()
                    throw Exception("Runtime limit reached for " + exe)
                }
                KillGroup(-process.Id, 9)
                let output = <-stdout
                let error = <-stderr
                return CommandResult{Code: process.ExitCode, Output: output, Error: error}
            } finally {
                Console.CancelKeyPress -= onCancel
                KillGroup(-process.Id, 9)
            }
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
                throw Exception(exe + " failed: " + result.Error + result.Output)
            }
            return result.Output.Trim()
        }

        internal func Git(cwd string, args ...string) string {
            let all = List[string]{
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
            return Checked(
                "git",
                all.ToArray(),
                cwd,
                github: Array.IndexOf(args, "credential.helper=!gh auth git-credential") >= 0
            )
        }
    }
}
