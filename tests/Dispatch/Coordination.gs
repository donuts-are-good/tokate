package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal partial class CoordinationFlow : CoordinationFixture {
    shared {
        internal func All(binary string, selected string = "", leases bool? = nil) {
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
                if let lifecycle = leases {
                    if name.StartsWith("Lease") != lifecycle {
                        continue
                    }
                }
                matched = true
                if !CiShard.Include("Coordination/" + name) {
                    continue
                }
                if name.StartsWith("Eligibility", StringComparison.Ordinal) {
                    EligibilityChecks.All(binary, name)
                    continue
                }
                using let test = CoordinationFlow(binary)
                test.Initialize()
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
