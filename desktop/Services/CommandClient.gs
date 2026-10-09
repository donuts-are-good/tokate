package TokateDesktop

import System
import System.Collections.Generic
import System.Diagnostics
import System.Text.Json

class CommandResult {
    var Value JsonElement
    var Diagnostics string = ""
    var Error string = ""
    var ExitCode int32
}

class CommandClient {
    private let process ProcessRunner = ProcessRunner()

    func Stop() -> process.Stop()

    func RecentOutput() string -> process.RecentOutput()

    func Run(arguments[]string, tool string = "tokate", directory string = "", seconds int32 = 120) CommandResult {
        try {
            if tool == "codex" {
                return ModelCatalog.Read(process, arguments, seconds)
            }
            if tool == "tokate" {
                return TokateClient.Read(process, arguments, directory, seconds)
            }
            return ReadJson(process.Run(CommandStart(tool, arguments, directory), seconds))
        } catch (error Exception) {
            return CommandResult{Error: error.Message}
        }
    }
}

class TokateClient {
    shared {
        func Read(process ProcessRunner, arguments[]string, directory string, seconds int32) CommandResult {
            let start = CommandStart("tokate", arguments, directory)
            start.ArgumentList.Add("--json")
            let result = ReadJson(process.Run(start, seconds))
            if result.Error == "" &&
                (
                Number(result.Value, "schema_version") != 1 ||
                    Number(result.Value, "exit_code") != result.ExitCode ||
                    TextOf(result.Value, "command") != arguments[0]
            ) {
                result.Error = "The CLI returned an unsupported result. Inspect state before repeating this action."
            }
            return result
        }
    }
}

func CommandStart(tool string, arguments[]string, directory string = "") ProcessStartInfo {
    let start = ProcessStartInfo{FileName: tool}
    if directory != "" {
        start.WorkingDirectory = directory
    }
    for argument in arguments {
        start.ArgumentList.Add(argument)
    }
    return start
}

func ReadJson(process ProcessResult) CommandResult {
    let result = CommandResult{Diagnostics: process.Diagnostics, Error: process.Error, ExitCode: process.ExitCode}
    if result.Error == "" {
        try {
            using let document = JsonDocument.Parse(process.Output)
            result.Value = document.RootElement.Clone()
        } catch (error Exception) {
            result.Error = error.Message
        }
    }
    return result
}

func RunCommand(
    runner CommandClient,
    arguments[]string,
    tool string,
    directory string,
    seconds int32,
    completed Action[CommandResult]
) {
    completed(runner.Run(arguments, tool, directory, seconds))
}
