package TokateTests

import System
import System.IO

func Main(args[]string) int32 {
    try {
        if args.Length == 1 && args[0] == "--discovery-holder" {
            return CliDiscovery.Holder()
        }
        let exe = Environment.ProcessPath ?? throw Exception("Missing process path")
        if Path.GetFileName(exe) == "curl" {
            return ReleaseTools.Fixture(args, Path.GetDirectoryName(exe) ?? "")
        }
        let name = Path.GetFileName(exe)
        if name == "id" || name == "getent" {
            return ReleaseTools.ShellFixture(name, args, Path.GetDirectoryName(exe) ?? "")
        }
        if name == "uname" || name == "getconf" {
            return ReleaseTools.PlatformFixture(name, args, Path.GetDirectoryName(exe) ?? "")
        }
        if name == "git" || name == "gh" || name.StartsWith("codex") {
            return Fixture(Path.GetDirectoryName(exe) ?? "").Run(name, args)
        }
        let project = Directory.GetCurrentDirectory()
        let binary = Environment.GetEnvironmentVariable("TOKATE_BINARY") ?? Path.Combine(
            project,
            "artifacts/linux-x64/tokate"
        )
        if args.Length == 4 && args[0] == "--local-codex" {
            LocalCodex.All(binary, args[1], args[2], args[3])
            return 0
        }
        if args.Length == 1 && args[0] == "--process" {
            ProcessChecks.All(binary)
            return 0
        }
        if args.Length == 1 && args[0] == "--verification" {
            VerificationChecks.All(binary)
            return 0
        }
        if args.Length == 1 && args[0] == "--protected-paths" {
            ProtectedPathChecks.All(binary)
            return 0
        }
        if args.Length == 2 && args[0] == "--runtime-files-parent" {
            VerificationChecks.RuntimeFilesParent(binary, args[1])
            return 0
        }
        if args.Length == 2 && args[0] == "--suite" {
            SuiteCatalog.Select(binary, args[1])
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--diagnostics" {
            Diagnostics.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if args.Length == 1 && args[0] == "--overlaps" {
            OverlapChecks.All(binary)
            return 0
        }
        if args.Length == 1 && args[0] == "--json-cli" {
            CliDiscovery.Structured(binary)
            return 0
        }
        if args.Length == 1 && args[0] == "--progress" {
            ProgressChecks.All(binary)
            return 0
        }
        if args.Length == 1 && args[0] == "--terminal" {
            TerminalOutput.All(binary)
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--selection" {
            DonorSelectionChecks.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--targets" {
            TargetBranches.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--preparation" {
            PreparationChecks.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--continuation" {
            ContinuationChecks.All(binary, args.Length == 2 ? args[1]: "")
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
        if args.Length == 1 && args[0] == "--installer-shell-detection" {
            Installer.ShellDetection(project, binary)
            return 0
        }
        if args.Length == 2 && args[0] == "--flow" {
            NativeFlow.All(binary, args[1])
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--traffic-commands" {
            CommandTrafficChecks.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--coordination" {
            CoordinationFlow.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--correction" {
            CorrectionChecks.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--synchronizations" {
            SynchronizationChecks.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--public-descriptions" {
            PublicDescriptions.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--amendments" {
            AmendmentFlow.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--repairs" {
            RepairChecks.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--decree" {
            DecreeFlow.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        Check.That(args.Length == 0, "Unknown test arguments: " + String.Join(" ", args))
        SuiteCatalog.All(project, binary)
        return 0
    } catch (error Exception) {
        Console.Error.WriteLine(error.ToString())
        return 1
    }
}
