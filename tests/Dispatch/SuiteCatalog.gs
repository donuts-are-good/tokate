package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.Globalization
import System.IO

internal class SuiteCatalog {
    shared {
        internal func Select(binary string, name string) {
            switch name {
                case "Environment" {
                    if CiShard.Include("Process") {
                        ProcessChecks.All(binary)
                    }
                    if CiShard.Include("ProtectedPaths") {
                        ProtectedPathChecks.All(binary)
                    }
                    if CiShard.Include("CliDiscovery") {
                        CliDiscovery.All(binary)
                        CliDiscovery.Setup(binary)
                    }
                    if CiShard.Include("Diagnostics") {
                        Diagnostics.All(binary)
                    }
                    if CiShard.Include("Claude") {
                        ClaudeChecks.All(binary)
                    }
                    if CiShard.Include("DonorSelection") {
                        DonorSelectionChecks.All(binary)
                    }
                    if CiShard.Include("PiRuntime") {
                        PiChecks.Runtime(binary)
                    }
                    if CiShard.Include("Verification") {
                        VerificationChecks.All(binary)
                    }
                    PublicDescriptions.All(binary)
                    for name in NativeFlow.SerialGroups {
                        if CiShard.Include("Native/" + name) {
                            NativeFlow.All(binary, name)
                        }
                    }
                }
                case "Synchronization" {
                    SynchronizationChecks.All(binary, "current")
                }
                case "SynchronizationFirst" {
                    SynchronizationChecks.All(binary, "current", 1)
                }
                case "SynchronizationSecond" {
                    SynchronizationChecks.All(binary, "current", 2)
                }
                case "Native" {
                    NativeFlow.All(binary, parallel: true)
                }
                case "Coordination" {
                    CoordinationFlow.All(binary, leases: false, admission: false)
                    CommandTrafficChecks.All(binary)
                }
                case "Admission" {
                    CoordinationFlow.All(binary, admission: true)
                }
                case "LeaseLifecycle" {
                    CoordinationFlow.All(binary, leases: true)
                }
                case "Correction" {
                    CorrectionChecks.All(binary)
                }
                case "Amendment" {
                    AmendmentFlow.All(binary)
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
                case "Continuation" {
                    AttemptContinuationChecks.All(binary)
                }
                case "Targets" {
                    if CiShard.Include("Targets") {
                        TargetBranches.All(binary)
                    }
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
                using let data = Temp()
                let published = Path.Combine(data.Root, ".git/data")
                Directory.CreateDirectory(Path.Combine(published, "artifacts/linux-x64"))
                Directory.CreateDirectory(Path.Combine(published, "artifacts/tests"))
                File.Copy(binary, Path.Combine(published, "artifacts/linux-x64/tokate"))
                File.Copy(
                    Environment.ProcessPath ?? throw Exception("Missing test executable"),
                    Path.Combine(published, "artifacts/tests/tokate-tests")
                )
                File.Copy(TestProcess.Node(), Path.Combine(published, "artifacts/tests/node"))
                File.Copy(Path.Combine(project, "global.json"), Path.Combine(published, "global.json"))
                let jobs = []SuiteJob{
                    Job("Environment"),
                    Job("SynchronizationFirst"),
                    Job("SynchronizationSecond"),
                    Job("Native"),
                    Job("Coordination"),
                    Job("Admission"),
                    Job("LeaseLifecycle"),
                    Job("Correction"),
                    Job("Amendment"),
                    Job("Decree"),
                    Job("Targets"),
                    Job("Preparation"),
                    Job("Continuation"),
                    Job("Overlaps")
                }
                SuiteDriver(data.Root, jobs).Run(report)
                let installer = report.Serial()
                try {
                    if CiShard.Include("Installer") {
                        Installer.Skill(project)
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
                    }
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
                "cd .git/data && exec env TOKATE_CI_SHARD=" + CiShard.Spec() +
                    " artifacts/tests/tokate-tests --suite \"$$1\"",
                "suite",
                name
            }
        }
    }
}
