package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.Globalization
import System.IO
import Tokate

internal class SuiteCatalog {
    shared {
        internal func Select(binary string, name string) {
            switch name {
                case "SynchronizationV2" {
                    SynchronizationChecks.All(binary, "v2")
                }
                case "SynchronizationV2First" {
                    SynchronizationChecks.All(binary, "v2", 1)
                }
                case "SynchronizationV2Second" {
                    SynchronizationChecks.All(binary, "v2", 2)
                }
                case "SynchronizationV1" {
                    SynchronizationChecks.All(binary, "v1")
                }
                case "Native" {
                    NativeFlow.All(binary, parallel: true)
                }
                case "Coordination" {
                    CoordinationFlow.All(binary)
                    CommandTrafficChecks.All(binary)
                }
                case "Correction" {
                    CorrectionChecks.All(binary)
                }
                case "Amendment" {
                    AmendmentFlow.All(binary)
                }
                case "Repair" {
                    RepairChecks.All(binary)
                }
                case "Decree" {
                    DecreeFlow.All(binary)
                }
                case "Overlaps" {
                    OverlapChecks.All(binary)
                }
                case "Preparation" {
                    PreparationChecks.All(binary)
                }
                case "Targets" {
                    TargetBranches.All(binary)
                }
                default {
                    throw Exception("Unknown suite selector: " + name)
                }
            }
        }

        internal func All(project string, binary string) {
            let clock = Stopwatch.StartNew()
            let report = SuiteReport()
            try {
                let serial = report.Serial()
                try {
                    ProcessChecks.All()
                    ProtectedPathChecks.All()
                    CliDiscovery.All(binary)
                    Diagnostics.All(binary)
                    DonorSelectionChecks.All(binary)
                    VerificationChecks.All()
                    SuiteChecks.All()
                    for name in NativeFlow.SerialGroups {
                        NativeFlow.All(binary, name)
                    }
                } finally {
                    report.Finish(serial)
                }
                using let data = Temp()
                let published = Path.Combine(data.Root, ".git/data")
                Directory.CreateDirectory(Path.Combine(published, "artifacts/linux-x64"))
                Directory.CreateDirectory(Path.Combine(published, "artifacts/tests"))
                File.Copy(binary, Path.Combine(published, "artifacts/linux-x64/tokate"))
                File.Copy(
                    Environment.ProcessPath ?? throw Exception("Missing test executable"),
                    Path.Combine(published, "artifacts/tests/tokate-tests")
                )
                File.Copy(Path.Combine(project, "global.json"), Path.Combine(published, "global.json"))
                let jobs = []SuiteJob{
                    Job("SynchronizationV2First"),
                    Job("SynchronizationV1"),
                    Job("SynchronizationV2Second"),
                    Job("Native"),
                    Job("Coordination"),
                    Job("Correction"),
                    Job("Amendment"),
                    Job("Repair"),
                    Job("Decree"),
                    Job("Targets"),
                    Job("Preparation"),
                    Job("Overlaps")
                }
                SuiteDriver(data.Root, jobs).Run(report)
                let installer = report.Serial()
                try {
                    Installer.Lifecycle(project, binary)
                    Console.WriteLine(
                        "PASS installer lifecycle, failed updates, credential boundary, and offline removal"
                    )
                    Installer.ShellDetection(project, binary)
                    Installer.RefuseInvalidPath(project)
                    Console.WriteLine("PASS installer rejects symlink and directory replacement")
                    Installer.RefuseUnsupportedPlatform(project, binary)
                    Console.WriteLine(
                        "PASS unsupported architecture/libc refusal preserves installations and permits removal"
                    )
                } finally {
                    report.Finish(installer)
                }
            } finally {
                Console.WriteLine(
                    "Verification: " + report.Groups.ToString() +
                        " groups passed; " +
                        clock
                        .Elapsed
                        .TotalSeconds
                        .ToString("F3", CultureInfo.InvariantCulture) +
                        " seconds elapsed"
                )
            }
        }

        private func Job(name string) SuiteJob -> SuiteJob{
            Name: name,
            Command: []string{
                "/bin/sh",
                "-c",
                "cd .git/data && exec artifacts/tests/tokate-tests --suite \"$$1\"",
                "suite",
                name
            }
        }
    }
}
