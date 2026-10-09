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
        switch args.Length == 0 ? "": args[0] {
            case "--nix-runtime" when args.Length == 4 {
                NixChecks.Run(binary, args[1], args[2], args[3])
            }
            case "--pi-runtime" when(args.Length == 1 || args.Length == 2) {
                PiChecks.Runtime(binary, args.Length == 2 ? args[1]: "")
            }
            case "--pi-proof" when args.Length == 6 {
                PiChecks.Run(binary, args[1], args[2], args[3], args[4], args[5])
            }
            case "--local-codex" when args.Length == 4 {
                LocalCodex.All(binary, args[1], args[2], args[3])
            }
            case "--process" when args.Length == 1 {
                ProcessChecks.All(binary)
            }
            case "--verification" when args.Length == 1 {
                VerificationChecks.All(binary)
            }
            case "--protected-paths" when args.Length == 1 {
                ProtectedPathChecks.All(binary)
            }
            case "--runtime-files-parent" when args.Length == 2 {
                VerificationChecks.RuntimeFilesParent(binary, args[1])
            }
            case "--suite" when args.Length == 2 {
                SuiteCatalog.Select(binary, args[1])
            }
            case "--diagnostics" when(args.Length == 1 || args.Length == 2) {
                Diagnostics.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--overlaps" when args.Length == 1 {
                OverlapChecks.All(binary)
            }
            case "--json-cli" when args.Length == 1 {
                CliDiscovery.Structured(binary)
            }
            case "--saved-runs" when args.Length == 1 {
                CliDiscovery.Saved(binary)
            }
            case "--progress" when(args.Length == 1 || args.Length == 2) {
                ProgressChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--terminal" when args.Length == 1 {
                TerminalOutput.All(binary)
            }
            case "--selection" when(args.Length == 1 || args.Length == 2) {
                DonorSelectionChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--targets" when(args.Length == 1 || args.Length == 2) {
                TargetBranches.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--preparation" when(args.Length == 1 || args.Length == 2) {
                PreparationChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--continuation" when(args.Length == 1 || args.Length == 2) {
                AttemptContinuationChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--cli-setup" when args.Length == 1 {
                CliDiscovery.Setup(binary)
            }
            case "--cli" when args.Length == 1 {
                CliDiscovery.All(binary)
            }
            case "--cli-shell" when args.Length == 2 {
                CliDiscovery.All(binary, args[1])
            }
            case "--shell" when args.Length == 2 {
                Installer.Lifecycle(project, binary, args[1])
                Console.WriteLine("PASS installer lifecycle for " + args[1])
            }
            case "--installer-shell-detection" when args.Length == 1 {
                Installer.ShellDetection(project, binary)
            }
            case "--flow" when args.Length == 2 {
                NativeFlow.All(binary, args[1])
            }
            case "--traffic-commands" when(args.Length == 1 || args.Length == 2) {
                CommandTrafficChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--coordination" when(args.Length == 1 || args.Length == 2) {
                CoordinationFlow.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--correction" when(args.Length == 1 || args.Length == 2) {
                CorrectionChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--synchronizations" when(args.Length == 1 || args.Length == 2) {
                SynchronizationChecks.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--public-descriptions" when(args.Length == 1 || args.Length == 2) {
                PublicDescriptions.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--amendments" when(args.Length == 1 || args.Length == 2) {
                AmendmentFlow.All(binary, args.Length == 2 ? args[1]: "")
            }
            case "--decree" when(args.Length == 1 || args.Length == 2) {
                DecreeFlow.All(binary, args.Length == 2 ? args[1]: "")
            }
            default {
                Check.That(args.Length == 0, "Unknown test arguments: " + String.Join(" ", args))
                SuiteCatalog.All(project, binary)
            }
        }
        return 0
    } catch (error Exception) {
        Console.Error.WriteLine(error.ToString())
        return 1
    }
}
