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
                switch name {
                    case "LeaseStalePublication" {
                        test.LeaseStalePublication()
                    }
                    case "LeasePublicationRace" {
                        test.LeasePublicationRace()
                    }
                    case "LeaseFencing" {
                        test.LeaseFencing()
                    }
                    case "LeaseReceipts" {
                        test.LeaseReceipts()
                    }
                    case "LeasePauseExecution" {
                        test.LeaseExecution("pause")
                    }
                    case "LeaseReleaseExecution" {
                        test.LeaseExecution("release")
                    }
                    case "LeaseExecution" {
                        test.LeaseExecution()
                    }
                    case "LeaseReplayAndLegacy" {
                        test.LeaseReplayAndLegacy()
                    }
                    case "LeaseTakeover" {
                        test.LeaseTakeover()
                    }
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
                }
                test.Flow.AutomationAttribution()
                Console.WriteLine("PASS V2 " + name)
            }
            Check.That(matched, "Unknown coordination selector: " + selected)
        }
    }
}
