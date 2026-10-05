package TokateTests

import Gsharp.Concurrency
import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Net
import System.Net.Sockets
import System.Text.Json.Nodes

internal partial class NativeFlow : NativeFixture {
    shared {
        internal let SerialGroups[]string = []string{
            "ReadTraffic",
            "GitEvidence",
            "TemporaryIsolation",
            "TemporaryHomeRejected",
            "VerificationBoundary",
            "DisposableVerification"
        }

        internal func All(binary string, selected string = "", parallel bool = false) {
            var matched bool
            for name in[]string{
                "HelpAndArguments",
                "MissingTools",
                "DoctorToolchain",
                "OwnerWithoutCodex",
                "StructuredContract",
                "StructuredFailures",
                "CrossAccountFlow",
                "OwnerPolicy",
                "ModelPolicyModes",
                "ModelPolicyMalformed",
                "FailedReassignment",
                "MissingFork",
                "VerificationReserve",
                "DefaultBudget",
                "HigherOwnerBudget",
                "LowerOwnerBudget",
                "IssueEdit",
                "Revocation",
                "Timeout",
                "ManagedCancellation",
                "Reapproval",
                "PolicyEdit",
                "WorkflowEdit",
                "ProtectedEntrypoint",
                "ProtectedRecovery",
                "ProtectedPublication",
                "EmptyProtectedPaths",
                "ReceiptEvidence",
                "GitEvidence",
                "RepositoryConfig",
                "NoPatch",
                "TemporaryIsolation",
                "TemporaryHomeRejected",
                "OutputBoundary",
                "ToolAuthentication",
                "ConditionalClaim",
                "ConditionalValidators",
                "ConditionalApproval",
                "ReadTraffic",
                "MutationTraffic",
                "PublicationFailures",
                "ExistingPublication",
                "CanonicalVerification",
                "CanonicalPublication",
                "RepositoryIdentity",
                "PublicationRevocation",
                "BackgroundCleanup",
                "UnsupportedSandbox",
                "DisposableVerification",
                "VerificationBoundary",
                "VerificationNetwork",
                "VerificationRecovery"
            } {
                if selected != "" && selected != name {
                    continue
                }
                if parallel && Array.IndexOf(SerialGroups, name) >= 0 {
                    continue
                }
                matched = true
                using let flow = NativeFlow(binary)
                if Array.IndexOf(
                    []string{
                        "StructuredFailures",
                        "ModelPolicyModes",
                        "ProtectedPublication",
                        "GitEvidence",
                        "PublicationFailures",
                        "CanonicalVerification",
                        "CanonicalPublication",
                        "ConditionalClaim",
                        "ConditionalApproval",
                        "VerificationNetwork",
                        "VerificationReserve",
                        "RepositoryIdentity"
                    },
                    name
                ) < 0 {
                    flow.Initialize()
                }
                switch name {
                    case "HelpAndArguments" {
                        flow.HelpAndArguments()
                    }
                    case "MissingTools" {
                        flow.MissingTools()
                    }
                    case "DoctorToolchain" {
                        flow.DoctorToolchain()
                    }
                    case "OwnerWithoutCodex" {
                        flow.OwnerWithoutCodex()
                    }
                    case "StructuredFailures" {
                        flow.StructuredFailures()
                    }
                    case "StructuredContract" {
                        flow.StructuredContract()
                    }
                    case "CrossAccountFlow" {
                        flow.CrossAccountFlow()
                    }
                    case "OwnerPolicy" {
                        flow.OwnerPolicy()
                    }
                    case "ModelPolicyModes" {
                        flow.ModelPolicyModes()
                    }
                    case "ModelPolicyMalformed" {
                        flow.ModelPolicyMalformed()
                    }
                    case "FailedReassignment" {
                        flow.FailedReassignment()
                    }
                    case "MissingFork" {
                        flow.MissingFork()
                    }
                    case "VerificationReserve" {
                        ReserveChecks.All(binary)
                    }
                    case "DefaultBudget" {
                        flow.DefaultBudget()
                    }
                    case "HigherOwnerBudget" {
                        flow.DefaultBudget(7200)
                    }
                    case "LowerOwnerBudget" {
                        flow.DefaultBudget(30, "30")
                    }
                    case "IssueEdit" {
                        flow.IssueEdit()
                    }
                    case "Revocation" {
                        flow.Revocation()
                    }
                    case "ManagedCancellation" {
                        flow.ManagedCancellation()
                    }
                    case "Timeout" {
                        flow.Timeout()
                    }
                    case "Reapproval" {
                        flow.Reapproval()
                    }
                    case "PolicyEdit" {
                        flow.PolicyEdit()
                    }
                    case "WorkflowEdit" {
                        flow.WorkflowEdit()
                    }
                    case "ProtectedEntrypoint" {
                        flow.ProtectedEntrypoint()
                    }
                    case "ProtectedRecovery" {
                        flow.ProtectedRecovery()
                    }
                    case "ProtectedPublication" {
                        flow.ProtectedPublication()
                    }
                    case "EmptyProtectedPaths" {
                        flow.EmptyProtectedPaths()
                    }
                    case "ReceiptEvidence" {
                        flow.ReceiptEvidence()
                    }
                    case "GitEvidence" {
                        flow.GitEvidence()
                    }
                    case "RepositoryConfig" {
                        flow.RepositoryConfig()
                    }
                    case "NoPatch" {
                        flow.NoPatch()
                    }
                    case "TemporaryIsolation" {
                        flow.TemporaryIsolation()
                    }
                    case "TemporaryHomeRejected" {
                        flow.TemporaryHomeRejected()
                    }
                    case "OutputBoundary" {
                        flow.OutputBoundary()
                    }
                    case "ToolAuthentication" {
                        flow.ToolAuthentication()
                    }
                    case "ConditionalClaim" {
                        flow.ConditionalClaim()
                    }
                    case "ConditionalValidators" {
                        flow.ConditionalValidators()
                    }
                    case "ConditionalApproval" {
                        flow.ConditionalApproval()
                    }
                    case "ReadTraffic" {
                        flow.ReadTraffic()
                    }
                    case "MutationTraffic" {
                        flow.MutationTraffic()
                    }
                    case "ExistingPublication" {
                        flow.ExistingPublication()
                    }
                    case "PublicationFailures" {
                        flow.PublicationFailures()
                    }
                    case "CanonicalVerification" {
                        flow.CanonicalVerification()
                    }
                    case "CanonicalPublication" {
                        flow.CanonicalPublication()
                    }
                    case "RepositoryIdentity" {
                        RepositoryIdentityChecks.All(binary)
                    }
                    case "PublicationRevocation" {
                        flow.PublicationRevocation()
                    }
                    case "BackgroundCleanup" {
                        flow.BackgroundCleanup()
                    }
                    case "UnsupportedSandbox" {
                        flow.UnsupportedSandbox()
                    }
                    case "DisposableVerification" {
                        DisposableVerificationChecks.All(binary)
                    }
                    case "VerificationBoundary" {
                        flow.VerificationBoundary()
                    }
                    case "VerificationRecovery" {
                        flow.VerificationRecovery()
                    }
                    case "VerificationNetwork" {
                        flow.VerificationNetwork()
                    }
                    default {
                        throw Exception("Unknown test: " + name)
                    }
                }
                flow.AutomationAttribution()
                Console.WriteLine("PASS " + name)
            }
            Check.That(matched, "Unknown native selector: " + selected)
        }
    }
}
