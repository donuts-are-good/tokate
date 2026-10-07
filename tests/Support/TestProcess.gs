package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text

internal class TestProcess {
    shared {
        private func NodeExecutable(path string) bool -> File.Exists(path) &&
            (
            File.GetUnixFileMode(path) & (
                UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute
            )
        ) != 0

        internal func Node() string {
            let bundled = Path.Combine(Path.GetDirectoryName(Environment.ProcessPath) ?? "", "node")
            if NodeExecutable(bundled) {
                return bundled
            }
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if Path.IsPathFullyQualified(entry) && NodeExecutable(Path.Combine(entry, "node")) {
                    return Path.Combine(entry, "node")
                }
            }
            throw Exception("Pi continuation requires installed Node on PATH")
        }

        internal func ChildIdentity(child Process) string {
            let name = FileInfo("/proc/self/ns/pid").LinkTarget ?? throw Exception("Missing child PID namespace")
            return name + " " + child.Id.ToString()
        }

        internal func ResolveHostPid(identity string) string {
            let parts = identity.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries)
            Check.That(
                parts.Length == 2 && parts[0].StartsWith("pid:[") && parts[0].EndsWith("]"),
                "Invalid child PID identity"
            )
            Check.That(
                Int64.Parse(parts[0].Substring(5, parts[0].Length - 6)) > 0 && Int32.Parse(parts[1]) > 0,
                "Invalid child PID identity"
            )
            for task in Directory.EnumerateDirectories("/proc") {
                var status string?
                try {
                    status = Status(Path.Combine(task, "status"))
                } catch (error UnauthorizedAccessException) {
                    continue
                } catch (error IOException) {
                    continue
                }
                if status == nil {
                    continue
                }
                for line in status.Split('\n') {
                    if !line.StartsWith("NSpid:") {
                        continue
                    }
                    let fields = line.Split([]char{' ', '\t'}, StringSplitOptions.RemoveEmptyEntries)
                    if fields.Length > 2 && fields[^1] == parts[1] {
                        try {
                            if FileInfo(Path.Combine(task, "ns/pid")).LinkTarget == parts[0] {
                                return Path.GetFileName(task)
                            }
                        } catch (error UnauthorizedAccessException) { } catch (error IOException) { }
                    }
                }
            }
            return ""
        }

        internal func Fields(stat string)[]string -> stat.Substring(stat.LastIndexOf(')') + 2).Split(
            ' ',
            StringSplitOptions.RemoveEmptyEntries
        )

        internal func Status(path string) string? {
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

        internal func Collected(identity string, message string) {
            let pid = ResolveHostPid(identity)
            let stat = pid == "" ? nil: Status("/proc/" + pid + "/stat")
            Check.That(stat == nil || Fields(stat)[0] == "Z", message)
        }

        internal func HeartbeatStopped(path string, milliseconds int32, message string) {
            let length = FileInfo(path).Length
            select {
                case <- after(TimeSpan.FromMilliseconds(milliseconds)) { }
            }
            Check.That(FileInfo(path).Length == length, message)
        }

        internal func Read(reader StreamReader, result Chan[string]) {
            result <- reader.ReadToEnd()
        }

        internal func Run(
            exe string,
            args[]string,
            env Dictionary[string, string],
            input string? = nil,
            cwd string = "",
            seconds int32 = 120
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
            using let outputReader = StreamReader(process.StandardOutput.BaseStream, UTF8Encoding(false), false)
            let output = Chan[string](1)
            let error = Chan[string](1)
            go Read(outputReader, output)
            go Read(process.StandardError, error)
            let onCancel = ConsoleCancelEventHandler(
                (sender Object?, event ConsoleCancelEventArgs) -> {
                    event.Cancel = true
                    try {
                        process.Kill(true)
                    } catch (error InvalidOperationException) { }
                }
            )
            Console.CancelKeyPress += onCancel
            try {
                if input != nil {
                    process.StandardInput.Write(input)
                }
                process.StandardInput.Close()
                if !process.WaitForExit(seconds * 1000) {
                    process.Kill(true)
                    process.WaitForExit()
                    throw Exception("Test process timed out: " + exe)
                }
                return Result{Code: process.ExitCode, Output: <-output, Error: <-error}
            } finally {
                Console.CancelKeyPress -= onCancel
            }
        }
    }
}
