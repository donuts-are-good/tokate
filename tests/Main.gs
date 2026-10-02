package TokateTests

import System
import System.IO

func Main(args[]string) int32 {
    try {
        let exe = Environment.ProcessPath ?? throw Exception("Missing process path")
        if Path.GetFileName(exe) == "curl" {
            return Installer.Fixture(args, Path.GetDirectoryName(exe) ?? "")
        }
        let project = Directory.GetCurrentDirectory()
        let binary = Environment.GetEnvironmentVariable("TOKATE_BINARY") ?? Path.Combine(
            project,
            "artifacts/linux-x64/tokate"
        )
        Installer.Lifecycle(project, binary)
        Console.WriteLine("PASS installer lifecycle, failed updates, credential boundary, and offline removal")
        Installer.RefuseSymlink(project)
        Console.WriteLine("PASS installer rejects symlink replacement")
        return 0
    } catch (error Exception) {
        Console.Error.WriteLine(error.ToString())
        return 1
    }
}
