package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal partial class CoordinationFlow : CoordinationFixture {
    shared {
        internal func ReleaseDownload(args[]string, root string) int32 {
            let state = Check.Json(File.ReadAllText(Path.Combine(root, "state.json")))
            Check.That(
                Environment.GetEnvironmentVariable("GH_TOKEN") == nil && Environment.GetEnvironmentVariable(
                    "GITHUB_TOKEN"
                ) == nil,
                "Coordination credentials reached release download"
            )
            let url = args[args.Length - 1]
            let output = args[Array.IndexOf(args, "--output") + 1]
            if url.EndsWith("/41") {
                File.Copy(Path.Combine(root, "release.tar.gz"), output)
            } else {
                Check.That(url.EndsWith("/42"), "Unexpected immutable release asset URL")
                File.WriteAllText(
                    output,
                    Installer.Hash(Path.Combine(root, "release.tar.gz")) + "  tokate-" + Check.Text(
                        state["release_version"]
                    ) +
                        "-linux-x64.tar.gz\n"
                )
            }
            return 0
        }

        internal func Concurrent(binary string, path string, env Dictionary[string, string], output Chan[Result]) {
            output <- TestProcess.Run(binary, []string{"coordinate", "--repo", "owner/project", "--event", path}, env)
        }

        internal func All(binary string, selected string = "") {
            var matched bool
            for name in[]string{
                "EligibilityTraffic",
                "EligibilityRaces",
                "EligibilityLatePublication",
                "EligibilityDeclarations",
                "EligibilityModes",
                "EligibilityRevocation",
                "EligibilityAuthority",
                "EligibilityTransport",
                "EligibilityConcurrency",
                "SimultaneousClaims",
                "SimultaneousClaimsMissingParticipant",
                "ReplayAndInterruptedState",
                "ExternalPublication",
                "InterruptedVerification",
                "CanonicalExternal",
                "CanonicalSubmit",
                "ExpiryAndRevocation",
                "InvalidEvents",
                "InterruptedWrite",
                "PublicationRevocation",
                "ExpiryDuringPublication",
                "EvictedReplay",
                "SetupRelease",
                "TokateExecution",
                "DeclarationRestrictions",
                "ModelPolicyModes",
                "EffortDeclarations",
                "ManagedModelPolicy",
                "ModelPolicyAuthority",
                "Compatibility",
                "ProtectedExternal",
                "ProtectedCoordinator",
                "ProtectedManaged",
                "ReceiptEvidence"
            } {
                if selected != "" && selected != name {
                    continue
                }
                matched = true
                if name.StartsWith("Eligibility", StringComparison.Ordinal) {
                    EligibilityChecks.All(binary, name)
                    continue
                }
                using let test = CoordinationFlow(binary)
                test.Initialize()
                switch name {
                    case "SimultaneousClaims" {
                        test.SimultaneousClaims()
                    }
                    case "SimultaneousClaimsMissingParticipant" {
                        test.SimultaneousClaimsMissingParticipant()
                    }
                    case "ReplayAndInterruptedState" {
                        test.ReplayAndInterruptedState()
                    }
                    case "InterruptedVerification" {
                        test.InterruptedVerification()
                    }
                    case "ExternalPublication" {
                        test.ExternalPublication()
                    }
                    case "ProtectedExternal" {
                        test.ProtectedExternal()
                    }
                    case "ProtectedCoordinator" {
                        test.ProtectedCoordinator()
                    }
                    case "ProtectedManaged" {
                        test.ProtectedManaged()
                    }
                    case "ReceiptEvidence" {
                        test.ReceiptEvidence()
                    }
                    case "CanonicalExternal" {
                        test.CanonicalExternal()
                    }
                    case "CanonicalSubmit" {
                        test.CanonicalSubmit()
                    }
                    case "ExpiryAndRevocation" {
                        test.ExpiryAndRevocation()
                    }
                    case "InvalidEvents" {
                        test.InvalidEvents()
                    }
                    case "InterruptedWrite" {
                        test.InterruptedWrite()
                    }
                    case "PublicationRevocation" {
                        test.PublicationRevocation()
                    }
                    case "ExpiryDuringPublication" {
                        test.ExpiryDuringPublication()
                    }
                    case "EvictedReplay" {
                        test.EvictedReplay()
                    }
                    case "SetupRelease" {
                        test.SetupRelease()
                    }
                    case "TokateExecution" {
                        test.TokateExecution()
                    }
                    case "DeclarationRestrictions" {
                        test.DeclarationRestrictions()
                    }
                    case "ModelPolicyModes" {
                        test.ModelPolicyModes()
                    }
                    case "EffortDeclarations" {
                        test.EffortDeclarations()
                    }
                    case "ManagedModelPolicy" {
                        test.ManagedModelPolicy()
                    }
                    case "ModelPolicyAuthority" {
                        test.ModelPolicyAuthority()
                    }
                    case "Compatibility" {
                        test.Compatibility()
                    }
                }
                test.Flow.AutomationAttribution()
                Console.WriteLine("PASS V2 " + name)
            }
            Check.That(matched, "Unknown coordination selector: " + selected)
        }
    }
}
