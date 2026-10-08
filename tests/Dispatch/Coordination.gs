package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal partial class CoordinationFlow : CoordinationFixture {
    shared {
        internal func All(binary string, selected string = "", leases bool? = nil, admission bool? = nil) {
            var matched bool
            for name in[]string{
                "LeaseStalePublication",
                "LeasePublicationRace",
                "LeaseFencing",
                "LeaseReceipts",
                "LeaseExecution",
                "LeasePauseExecution",
                "LeaseReleaseExecution",
                "LeaseReplayAndLegacy",
                "LeaseTakeover",
                "AdmissionAuthority",
                "AdmissionCoordinator",
                "AdmissionSafety",
                "EligibilityTraffic",
                "EligibilityRaces",
                "EligibilityLatePublication",
                "EligibilityDeclarations",
                "EligibilityModes",
                "EligibilityPresentation",
                "ContributionStatus",
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
                "CoordinatorPermissions",
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
                if let lifecycle = leases {
                    if name.StartsWith("Lease") != lifecycle {
                        continue
                    }
                }
                if let admit = admission {
                    if name.StartsWith("Admission") != admit {
                        continue
                    }
                }
                matched = true
                if !CiShard.Include("Coordination/" + name) {
                    continue
                }
                if name.StartsWith("Admission", StringComparison.Ordinal) {
                    AdmissionChecks.All(binary, name)
                    continue
                }
                if name == "ContributionStatus" {
                    ContributionStatusChecks.All(binary)
                    continue
                }
                if name.StartsWith("Eligibility", StringComparison.Ordinal) {
                    EligibilityChecks.All(binary, name)
                    continue
                }
                switch name {
                    case "ProtectedCoordinator" {
                        ProtectedCoordinator(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                    case "CoordinatorPermissions" {
                        CoordinatorPermissions(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                    case "ModelPolicyModes" {
                        ModelPolicyModes(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                    case "EffortDeclarations" {
                        EffortDeclarations(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                    case "ManagedModelPolicy" {
                        ManagedModelPolicy(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                    case "ModelPolicyAuthority" {
                        ModelPolicyAuthority(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                    case "Compatibility" {
                        Compatibility(binary)
                        Console.WriteLine("PASS V2 " + name)
                        continue
                    }
                }
                using let test = CoordinationFlow(binary)
                test.Initialize(
                    approve: name != "ProtectedExternal" &&
                        name != "ProtectedManaged" &&
                        name != "ReceiptEvidence" &&
                        name != "InterruptedVerification"
                )
                let execute async (CoordinationFlow) -> void = switch name {
                    case "LeaseStalePublication": async (value CoordinationFlow) -> value.LeaseStalePublication()
                    case "LeasePublicationRace": async (value CoordinationFlow) -> value.LeasePublicationRace()
                    case "LeaseFencing": async (value CoordinationFlow) -> value.LeaseFencing()
                    case "LeaseReceipts": async (value CoordinationFlow) -> value.LeaseReceipts()
                    case "LeasePauseExecution": async (value CoordinationFlow) -> value.LeaseExecution("pause")
                    case "LeaseReleaseExecution": async (value CoordinationFlow) -> value.LeaseExecution("release")
                    case "LeaseExecution": async (value CoordinationFlow) -> value.LeaseExecution()
                    case "LeaseReplayAndLegacy": async (value CoordinationFlow) -> value.LeaseReplayAndLegacy()
                    case "LeaseTakeover": async (value CoordinationFlow) -> value.LeaseTakeover()
                    case "SimultaneousClaims": async (value CoordinationFlow) -> value.SimultaneousClaims()
                    case "SimultaneousClaimsMissingParticipant": async (
                        value CoordinationFlow
                    ) -> value.SimultaneousClaimsMissingParticipant()
                    case "ReplayAndInterruptedState": async (
                        value CoordinationFlow
                    ) -> value.ReplayAndInterruptedState()
                    case "InterruptedVerification": async (value CoordinationFlow) -> value.InterruptedVerification()
                    case "ExternalPublication": async (value CoordinationFlow) -> value.ExternalPublication()
                    case "ProtectedExternal": async (value CoordinationFlow) -> value.ProtectedExternal()
                    case "ProtectedManaged": async (value CoordinationFlow) -> value.ProtectedManaged()
                    case "ReceiptEvidence": async (value CoordinationFlow) -> value.ReceiptEvidence()
                    case "CanonicalExternal": async (value CoordinationFlow) -> value.CanonicalExternal()
                    case "CanonicalSubmit": async (value CoordinationFlow) -> value.CanonicalSubmit()
                    case "ExpiryAndRevocation": async (value CoordinationFlow) -> value.ExpiryAndRevocation()
                    case "InvalidEvents": async (value CoordinationFlow) -> value.InvalidEvents()
                    case "InterruptedWrite": async (value CoordinationFlow) -> value.InterruptedWrite()
                    case "PublicationRevocation": async (value CoordinationFlow) -> value.PublicationRevocation()
                    case "ExpiryDuringPublication": async (value CoordinationFlow) -> value.ExpiryDuringPublication()
                    case "EvictedReplay": async (value CoordinationFlow) -> value.EvictedReplay()
                    case "SetupRelease": async (value CoordinationFlow) -> value.SetupRelease()
                    case "TokateExecution": async (value CoordinationFlow) -> value.TokateExecution()
                    case "DeclarationRestrictions": async (value CoordinationFlow) -> value.DeclarationRestrictions()
                    default: throw Exception("Unknown coordination case: " + name)
                }
                await execute(test)
                test.Flow.AutomationAttribution()
                Console.WriteLine("PASS V2 " + name)
            }
            Check.That(matched, "Unknown coordination selector: " + selected)
        }
    }
}
