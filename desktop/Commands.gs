package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text
import System.Text.Json

class CommandResult {
    var Value JsonElement
    var Diagnostics string = ""
    var Error string = ""
    var ExitCode int32
}

@DllImport("libc", EntryPoint: "kill")
func SignalCommand(pid int32, signal int32) int32;

class CommandRunner {
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

    func Run(arguments[]string, tool string = "tokate", directory string = "", seconds int32 = 120) CommandResult {
        let result = CommandResult{}
        var catalogHome = ""
        try {
            let start = ProcessStartInfo{
                FileName: tool,
                UseShellExecute: false,
                RedirectStandardInput: true,
                RedirectStandardOutput: true,
                RedirectStandardError: true,
                CreateNoWindow: true,
            }
            if tool == "codex" {
                for path in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                    let candidate = Path.Combine(path, "codex")
                    if Path.IsPathFullyQualified(candidate) && File.Exists(candidate) {
                        start.FileName = candidate
                        break
                    }
                }
                if !Path.IsPathFullyQualified(start.FileName) {
                    throw Exception("Install Codex to load its model catalog.")
                }
                catalogHome = Path.Combine(Path.GetTempPath(), "tokate-models-" + Guid.NewGuid().ToString("N"))
                Directory.CreateDirectory(
                    catalogHome,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                )
                start.Environment.Clear()
                start.Environment["PATH"] = "/usr/local/bin:/usr/bin:/bin"
                start.Environment["HOME"] = catalogHome
                start.Environment["CODEX_HOME"] = catalogHome
                start.WorkingDirectory = catalogHome
            }
            if directory != "" {
                start.WorkingDirectory = directory
            }
            let executable = start.FileName
            start.FileName = "/usr/bin/setsid"
            start.ArgumentList.Add("--wait")
            start.ArgumentList.Add("--")
            start.ArgumentList.Add(executable)
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            if tool == "tokate" {
                start.ArgumentList.Add("--json")
            }
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
                using let document = JsonDocument.Parse(output.ToString())
                result.Value = document.RootElement.Clone()
                if tool == "tokate" &&
                    (
                    Number(result.Value, "schema_version") != 1 ||
                        Number(result.Value, "exit_code") != result.ExitCode ||
                        TextOf(result.Value, "command") != arguments[0]
                ) {
                    throw Exception(
                        "The CLI returned an unsupported result. Inspect state before repeating this action."
                    )
                }
            }
        } catch (error Exception) {
            result.Error = error.Message
        } finally {
            lock gate {
                active = nil
            }
            if catalogHome != "" {
                Directory.Delete(catalogHome, true)
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

func RunCommand(
    runner CommandRunner,
    host Window,
    arguments[]string,
    tool string,
    directory string,
    seconds int32,
    completed Action[CommandResult]
) {
    let result = runner.Run(arguments, tool, directory, seconds)
    host.TryPost(() -> completed(result))
}

func Field(value JsonElement, key string) JsonElement {
    var result JsonElement
    if value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out result) {
        return result
    }
    return JsonElement{}
}

func TextOf(value JsonElement, key string) string {
    let item = Field(value, key)
    if item.ValueKind == JsonValueKind.String {
        return item.GetString() ?? ""
    }
    return item.ValueKind == JsonValueKind.Number ? item.ToString(): ""
}

func Number(value JsonElement, key string) int32 {
    let item = Field(value, key)
    var number int32
    return item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out number) ? number: 0
}

func Items(value JsonElement) List[JsonElement] {
    let result = List[JsonElement]()
    if value.ValueKind == JsonValueKind.Array {
        for item in value.EnumerateArray() {
            result.Add(item)
        }
    }
    return result
}

func Repository(value string) string {
    let trimmed = value.Trim().TrimEnd('/')
    let repo = trimmed.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase) ? trimmed.Substring(
        19
    ): trimmed
    let parts = repo.Split('/')
    if parts.Length != 2 && !(parts.Length == 4 && parts[2] == "issues") {
        throw Exception("Enter owner/repository or a GitHub issue URL.")
    }
    for part in[]string{parts[0], parts[1]} {
        if part.Length == 0 || part.StartsWith("-") || part == "." || part == ".." {
            throw Exception("Enter a valid GitHub repository.")
        }
        for c in part {
            if !Char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_' && c != '.' {
                throw Exception("Enter a valid GitHub repository.")
            }
        }
    }
    return parts[0] + "/" + parts[1]
}
