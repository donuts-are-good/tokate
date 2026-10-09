package TokateDesktop

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text

class ProcessResult {
    var Output string = ""
    var Diagnostics string = ""
    var Error string = ""
    var ExitCode int32
}

@DllImport("libc", EntryPoint: "kill")
func SignalCommand(pid int32, signal int32) int32;

class ProcessRunner {
    shared {
        private let runningGate Object = Object()
        private let running HashSet[ProcessRunner] = HashSet[ProcessRunner]()
        private var closing bool

        func Shutdown() {
            let pending = List[ProcessRunner]()
            lock runningGate {
                closing = true
                pending.AddRange(running)
            }
            for runner in pending {
                runner.Stop()
            }
            let timer = Stopwatch.StartNew()
            for runner in pending {
                runner.FinishStop(Math.Max(0, 5000 - int32(timer.ElapsedMilliseconds)))
            }
        }
    }

    private let gate Object = Object()
    private let diagnostics StringBuilder = StringBuilder()
    private var active Process?
    private var stopped bool

    func RecentOutput() string {
        lock diagnostics {
            return diagnostics.ToString().Trim()
        }
    }

    func Stop() {
        lock gate {
            if stopped {
                return
            }
            stopped = true
            if let process = active {
                try {
                    if !process.HasExited {
                        if SignalCommand(-process.Id, 2) != 0 {
                            SignalCommand(process.Id, 2)
                        }
                    }
                } catch (error InvalidOperationException) { }
            }
        }
    }

    private func FinishStop(milliseconds int32) {
        lock gate {
            if let process = active {
                try {
                    if !process.HasExited && !process.WaitForExit(milliseconds) {
                        SignalCommand(process.Id, 9)
                    }
                    SignalCommand(-process.Id, 9)
                } catch (error InvalidOperationException) { }
            }
        }
    }

    func Run(start ProcessStartInfo, seconds int32 = 120) ProcessResult {
        let result = ProcessResult{}
        try {
            lock runningGate {
                if closing {
                    throw OperationCanceledException("Desktop is closing. Inspect saved state before trying again.")
                }
                running.Add(this)
            }
            start.UseShellExecute = false
            start.RedirectStandardInput = true
            start.RedirectStandardOutput = true
            start.RedirectStandardError = true
            start.CreateNoWindow = true
            start.ArgumentList.Insert(0, start.FileName)
            start.ArgumentList.Insert(0, "--")
            start.ArgumentList.Insert(0, "--wait")
            start.FileName = "/usr/bin/setsid"
            using let process = Process()
            process.StartInfo = start
            lock gate {
                if stopped {
                    throw OperationCanceledException("Command cancelled. Inspect saved state before trying again.")
                }
                process.Start()
                active = process
            }
            process.StandardInput.Close()
            let output = StringBuilder()
            let elapsed = Stopwatch.StartNew()
            var interruptedAt int64 = -1
            let exited = process.WaitForExitAsync()
            using let pulse = tick(TimeSpan.FromMilliseconds(100))
            scope {
                let stdout = process.StandardOutput
                let stderr = process.StandardError
                go ReadCommandStream(stdout, output)
                go ReadCommandStream(stderr, diagnostics, true)
                var finished = false
                while !finished {
                    select {
                        case await exited {
                            SignalCommand(-process.Id, 9)
                            finished = true
                        }
                        case <- pulse { }
                    }
                    if finished {
                        break
                    }
                    if seconds > 0 && elapsed.Elapsed.TotalSeconds >= seconds && result.Error == "" {
                        result.Error = "Command timed out. Effects may have occurred. Inspect status before repeating it."
                        Stop()
                    }
                    lock gate {
                        if stopped && interruptedAt < 0 {
                            interruptedAt = elapsed.ElapsedMilliseconds
                        }
                    }
                    if interruptedAt >= 0 && elapsed.ElapsedMilliseconds - interruptedAt >= 5000 {
                        process.Kill(true)
                        SignalCommand(-process.Id, 9)
                        await exited
                        break
                    }
                }
            }
            result.ExitCode = process.ExitCode
            result.Diagnostics = diagnostics.ToString()
            lock gate {
                if stopped && result.Error == "" {
                    result.Error = "Command cancelled. Inspect saved state before trying again."
                }
            }
            if output.Length > 1048576 {
                throw Exception(
                    "Command output exceeded the display limit. Inspect saved state before repeating this action."
                )
            }
            if result.Error == "" {
                result.Output = output.ToString()
            }
        } catch (error Exception) {
            result.Error = error.Message
        } finally {
            lock gate {
                active = nil
            }
            lock runningGate {
                running.Remove(this)
            }
        }
        return result
    }
}

func ReadCommandStream(reader StreamReader, output StringBuilder, tail bool = false) {
    try {
        let buffer = [4096]char
        var count = await reader.ReadAsync(buffer, 0, buffer.Length)
        while count > 0 {
            lock output {
                if tail && output.Length + count > 262144 {
                    output.Remove(0, output.Length + count - 262144)
                }
                output.Append(buffer, 0, Math.Min(count, Math.Max(0, 1048577 - output.Length)))
            }
            count = await reader.ReadAsync(buffer, 0, buffer.Length)
        }
    } catch (error IOException) { }
}
