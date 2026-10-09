package TokateDesktop

import System
import System.IO

class ModelCatalog {
    shared {
        func Read(process ProcessRunner, arguments[]string, seconds int32) CommandResult {
            let start = CommandStart("codex", arguments)
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
            let directory = Path.Combine(Path.GetTempPath(), "tokate-models-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                start.Environment.Clear()
                start.Environment["PATH"] = "/usr/local/bin:/usr/bin:/bin"
                start.Environment["HOME"] = directory
                start.Environment["CODEX_HOME"] = directory
                start.WorkingDirectory = directory
                return ReadJson(process.Run(start, seconds))
            } finally {
                Directory.Delete(directory, true)
            }
        }
    }
}
