package TokateTests

import System
import System.IO
import Tokate

func Main(args[]string) int32 {
    try {
        let exe = Environment.ProcessPath ?? throw Exception("Missing process path")
        if Path.GetFileName(exe) == "curl" {
            return Installer.Fixture(args, Path.GetDirectoryName(exe) ?? "")
        }
        let name = Path.GetFileName(exe)
        if name == "uname" || name == "getconf" {
            return Installer.PlatformFixture(name, args, Path.GetDirectoryName(exe) ?? "")
        }
        if name == "git" || name == "gh" || name.StartsWith("codex") {
            return Fixture(Path.GetDirectoryName(exe) ?? "").Run(name, args)
        }
        let project = Directory.GetCurrentDirectory()
        if args.Length == 2 && args[0] == "--api-write" {
            try {
                GitHub.Api("repos/owner/project/issues/1/assignees", method: args[1])
                return 0
            } finally {
                ApiTransport.Report()
            }
        }
        if args.Length == 2 && args[0] == "--verify-checkout" {
            let result = Verification.Run(args[1], []string{"bash", "scripts/verify.sh"}, true, 1800)
            Console.Write(result.Output)
            Console.Error.Write(result.Error)
            return result.Code
        }
        if args.Length == 3 && args[0] == "--runtime-files-parent" {
            VerificationChecks.RuntimeFilesParent(args[1], args[2])
            return 0
        }
        if args.Length == 1 && args[0] == "--runtime-files" {
            VerificationChecks.RuntimeFiles()
            VerificationChecks.RuntimeCancellation()
            return 0
        }
        if args.Length == 1 && args[0] == "--verification" {
            VerificationChecks.All()
            return 0
        }
        if args.Length == 1 && args[0] == "--process" {
            ProcessChecks.All()
            return 0
        }
        let binary = Environment.GetEnvironmentVariable("TOKATE_BINARY") ?? Path.Combine(
            project,
            "artifacts/linux-x64/tokate"
        )
        if args.Length == 1 && args[0] == "--json-cli" {
            CliDiscovery.Structured(binary)
            return 0
        }
        if args.Length == 1 && args[0] == "--cli" {
            CliDiscovery.All(binary)
            return 0
        }
        if args.Length == 2 && args[0] == "--cli-shell" {
            CliDiscovery.All(binary, args[1])
            return 0
        }
        if args.Length == 2 && args[0] == "--shell" {
            Installer.Lifecycle(project, binary, args[1])
            Console.WriteLine("PASS installer lifecycle for " + args[1])
            return 0
        }
        if args.Length == 2 && args[0] == "--flow" {
            NativeFlow.All(binary, args[1])
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--coordination" {
            CoordinationFlow.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        ProcessChecks.All()
        CliDiscovery.All(binary)
        NativeFlow.All(binary)
        CoordinationFlow.All(binary)
        VerificationChecks.All()
        Installer.Lifecycle(project, binary)
        Console.WriteLine("PASS installer lifecycle, failed updates, credential boundary, and offline removal")
        Installer.RefuseInvalidPath(project)
        Console.WriteLine("PASS installer rejects symlink and directory replacement")
        Installer.RefuseUnsupportedPlatform(project, binary)
        Console.WriteLine("PASS unsupported architecture/libc refusal preserves installations and permits removal")
        return 0
    } catch (error Exception) {
        Console.Error.WriteLine(error.ToString())
        return 1
    }
}
