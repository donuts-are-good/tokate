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
            for test in[]TestCase[NativeFlow]{
                TestCase[NativeFlow]("MissingTools", async (value NativeFlow) -> value.MissingTools()),
                TestCase[NativeFlow]("DoctorToolchain", async (value NativeFlow) -> value.DoctorToolchain()),
                TestCase[NativeFlow]("OwnerWithoutCodex", async (value NativeFlow) -> value.OwnerWithoutCodex()),
                TestCase[NativeFlow]("StructuredContract", async (value NativeFlow) -> value.StructuredContract()),
                TestCase[NativeFlow]("StructuredFailures", async (value NativeFlow) -> value.StructuredFailures()),
                TestCase[NativeFlow]("CrossAccountFlow", async (value NativeFlow) -> value.CrossAccountFlow()),
                TestCase[NativeFlow]("ModelPolicyMalformed", async (value NativeFlow) -> value.ModelPolicyMalformed()),
                TestCase[NativeFlow]("MissingFork", async (value NativeFlow) -> value.MissingFork()),
                TestCase[NativeFlow]("VerificationReserve", async (value NativeFlow) -> ReserveChecks.All(binary)),
                TestCase[NativeFlow]("ManagedCancellation", async (value NativeFlow) -> value.ManagedCancellation()),
                TestCase[NativeFlow]("EmptyProtectedPaths", async (value NativeFlow) -> value.EmptyProtectedPaths()),
                TestCase[NativeFlow]("GitEvidence", async (value NativeFlow) -> value.GitEvidence()),
                TestCase[NativeFlow]("RepositoryConfig", async (value NativeFlow) -> value.RepositoryConfig()),
                TestCase[NativeFlow]("TemporaryIsolation", async (value NativeFlow) -> value.TemporaryIsolation()),
                TestCase[NativeFlow](
                    "TemporaryHomeRejected",
                    async (value NativeFlow) -> value.TemporaryHomeRejected()
                ),
                TestCase[NativeFlow]("OutputBoundary", async (value NativeFlow) -> value.OutputBoundary()),
                TestCase[NativeFlow]("ToolAuthentication", async (value NativeFlow) -> value.ToolAuthentication()),
                TestCase[NativeFlow]("ConditionalClaim", async (value NativeFlow) -> value.ConditionalClaim()),
                TestCase[NativeFlow](
                    "ConditionalValidators",
                    async (value NativeFlow) -> value.ConditionalValidators()
                ),
                TestCase[NativeFlow]("ConditionalApproval", async (value NativeFlow) -> value.ConditionalApproval()),
                TestCase[NativeFlow]("ReadTraffic", async (value NativeFlow) -> value.ReadTraffic()),
                TestCase[NativeFlow]("MutationTraffic", async (value NativeFlow) -> value.MutationTraffic()),
                TestCase[NativeFlow](
                    "CanonicalVerification",
                    async (value NativeFlow) -> value.CanonicalVerification()
                ),
                TestCase[NativeFlow](
                    "RepositoryIdentity",
                    async (value NativeFlow) -> RepositoryIdentityChecks.All(binary)
                ),
                TestCase[NativeFlow]("BackgroundCleanup", async (value NativeFlow) -> value.BackgroundCleanup()),
                TestCase[NativeFlow]("UnsupportedSandbox", async (value NativeFlow) -> value.UnsupportedSandbox()),
                TestCase[NativeFlow](
                    "DisposableVerification",
                    async (value NativeFlow) -> DisposableVerificationChecks.All(binary)
                ),
                TestCase[NativeFlow]("VerificationBoundary", async (value NativeFlow) -> value.VerificationBoundary()),
                TestCase[NativeFlow]("VerificationNetwork", async (value NativeFlow) -> value.VerificationNetwork()),
            } {
                let name = test.Name
                if selected != "" && selected != name {
                    continue
                }
                if parallel && Array.IndexOf(SerialGroups, name) >= 0 {
                    continue
                }
                matched = true
                if !CiShard.Include("Native/" + name) {
                    continue
                }
                using let flow = NativeFlow(binary)
                if Array.IndexOf(
                    []string{
                        "StructuredFailures",
                        "GitEvidence",
                        "CanonicalVerification",
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
                test.Run(flow)
                flow.AutomationAttribution()
                Console.WriteLine("PASS " + name)
            }
            Check.That(matched, "Unknown native selector: " + selected)
        }
    }
}
