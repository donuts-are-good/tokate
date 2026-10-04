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
        if args.Length == 2 && args[0] == "--capture-write-failure" {
            ProcessChecks.LimitedCapture(args[1])
            return 0
        }
        if args.Length == 2 && args[0] == "--capture-prefix" {
            ProcessChecks.Prefix(args[1])
            return 0
        }
        if args.Length == 2 && args[0] == "--api-write" {
            try {
                GitHub.Api("repos/owner/project/issues/1/assignees", method: args[1])
                return 0
            } finally {
                ApiTransport.Report()
            }
        }
        if args.Length == 3 && args[0] == "--verify-captured" {
            Verification.Check(
                args[2],
                System.Collections.Generic.List[Object](),
                J.Parse("[\"bash\",\"scripts/verify.sh\"]"),
                args[1],
                false,
                1800
            )
            return 0
        }
        if args.Length == 1 && args[0] == "--verification-cancellation" {
            VerificationChecks.RuntimeCancellation()
            return 0
        }
        if args.Length == 2 && args[0] == "--verify-checkout" {
            let result = Verification.Run(args[1], []string{"bash", "scripts/verify.sh"}, true, 1800)
            Console.Write(result.Output)
            Console.Error.Write(result.Error)
            return result.Code ?? throw Exception("Missing completed verifier exit code")
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
        if args.Length == 1 && args[0] == "--verification-capture" {
            VerificationChecks.Cleanup()
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
        if args.Length == 1 && args[0] == "--protected-paths" {
            ProtectedPathChecks.All()
            return 0
        }
        if args.Length == 1 && args[0] == "--suites" {
            SuiteChecks.All()
            return 0
        }
        if (args.Length == 2 || args.Length == 3) && args[0] == "--suite-fixture" {
            SuiteChecks.Fixture(args[1], args.Length == 3 ? args[2]: "cancel")
            return 0
        }
        let binary = Environment.GetEnvironmentVariable("TOKATE_BINARY") ?? Path.Combine(
            project,
            "artifacts/linux-x64/tokate"
        )
        if args.Length == 2 && args[0] == "--suite" {
            SuiteDriver.Select(binary, args[1])
            return 0
        }
        if args.Length == 1 && args[0] == "--json-cli" {
            CliDiscovery.Structured(binary)
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
        if (args.Length == 1 || args.Length == 2) && args[0] == "--amendments" {
            AmendmentFlow.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        if (args.Length == 1 || args.Length == 2) && args[0] == "--decree" {
            DecreeFlow.All(binary, args.Length == 2 ? args[1]: "")
            return 0
        }
        Check.That(args.Length == 0, "Unknown test arguments: " + String.Join(" ", args))
        SuiteDriver.All(project, binary)
        return 0
    } catch (error Exception) {
        Console.Error.WriteLine(error.ToString())
        return 1
    }
}
