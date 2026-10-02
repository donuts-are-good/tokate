package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class Result {
    internal var Code int32
    internal var Output string = ""
    internal var Error string = ""
}

internal class Check {
    shared {
        internal func That(value bool, message string) {
            if !value {
                throw Exception(message)
            }
        }

        internal func Contains(text string, expected string) -> That(
            text.Contains(expected),
            "Missing: " + expected + "\n" + text
        )

        internal func Json(text string) JsonNode -> JsonNode.Parse(text) ?? throw Exception("Missing JSON")

        internal func Text(value JsonNode?) string -> value?.ToString() ?? ""

        internal func Map(values ...Object?) JsonNode {
            let result = JsonObject()
            for i in 0 ... values.Length / 2 {
                let key = values[i * 2]?.ToString() ?? ""
                switch values[i * 2 + 1] {
                    case text is string {
                        result[key] = JsonValue.Create(text)
                    }
                    case flag is bool {
                        result[key] = JsonValue.Create(flag)
                    }
                    case number is int32 {
                        result[key] = JsonValue.Create(number)
                    }
                    case node is JsonNode {
                        result[key] = node.DeepClone()
                    }
                    case nil {
                        result[key] = nil
                    }
                    default {
                        throw Exception("Unsupported fixture JSON value")
                    }
                }
            }
            return result
        }

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
            go Check.Read(process.StandardOutput, output)
            go Check.Read(process.StandardError, error)
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

        internal func Success(result Result) string {
            That(result.Code == 0, result.Output + result.Error)
            return result.Output.Trim()
        }
    }
}

internal class Temp : IDisposable {
    internal let Root string = Path.Combine(
        Environment.GetEnvironmentVariable("TOKATE_TEST_ROOT") ?? "/var/tmp",
        "tokate-e2e-" + Guid.NewGuid().ToString("N")
    )
    internal let Env Dictionary[string, string] = Dictionary[string, string]()

    internal init() {
        Directory.CreateDirectory(Root)
        Directory.CreateDirectory(Path.Combine(Root, "bin"))
        Directory.CreateDirectory(Path.Combine(Root, "home"))
        Env["PATH"] = Path.Combine(Root, "bin") + ":/usr/bin:/bin"
        Env["HOME"] = Path.Combine(Root, "home")
        Env["SHELL"] = "/bin/bash"
        Env["LANG"] = "C.UTF-8"
    }

    internal func Tool(name string) {
        let target = Path.Combine(Root, "bin", name)
        File.Copy(Environment.ProcessPath ?? throw Exception("Missing test executable"), target)
        File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
    }

    public func Dispose() -> Directory.Delete(Root, true)
}
