package TokateTests

import System
import System.IO
import System.Text.Json.Nodes

internal class ProtectedPathChecks {
    shared {
        internal func All(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize(approve: false)
            let flow = test.Flow
            let paths = []string{" protected", "\uFEFFprotected", "scripts/quoted\" ", "scripts/checks/line\n\".sh"}
            let entries = JsonArray()
            for path in paths {
                PublishedContribution.Write(flow.Upstream, path, "original\n")
                entries.Add(JsonValue.Create(path.Contains('\n') ? "scripts/checks/": path) as JsonNode)
            }
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["protected_paths"] = entries
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Raw protected Git names")
            flow.Approve()
            let claim = test.ClaimRequest()
            test.Coordinate(test.Event(claim))
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for path in paths {
                baseline.Restore()
                test.Candidate(claim)
                let checkout = Path.Combine(flow.Temp.Root, "donor-work")
                File.AppendAllText(Path.Combine(checkout, path), "changed\n")
                flow.Git("-C", checkout, "add", "-A")
                flow.DonorGit(checkout, "commit", "-m", "Protected edit")
                let head = flow.Git("-C", checkout, "rev-parse", "HEAD")
                flow.Git(
                    "-C",
                    checkout,
                    "push",
                    Path.Combine(flow.Bin, "fork"),
                    "HEAD:refs/heads/tokate/v2-" + Check.Text(claim["uuid"])
                )
                let result = test.Coordinate(test.Event(test.PublishRequest(claim, head)), 1)
                Check.Contains(result.Error, "protected owner path")
                flow.NoInference()
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS coordinated publication rejects whitespace, BOM, quoted and newline protected Git names"
            )
        }
    }
}
