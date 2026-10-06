package TokateTests

import System
import System.IO
import System.Text.Json.Nodes

internal class ProtectedPathChecks {
    shared {
        internal func All(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
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
            let run = flow.Claim()
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for path in paths {
                for committed in[]bool{false, true} {
                    baseline.Restore()
                    let checkout = Path.Combine(run, "checkout")
                    File.AppendAllText(Path.Combine(checkout, path), "changed\n")
                    flow.Git("-C", checkout, "add", "-A")
                    let savedPath = Path.Combine(run, "run.json")
                    let saved = Check.Json(File.ReadAllText(savedPath))
                    saved["state"] = JsonValue.Create("generated")
                    let checks = JsonArray()
                    checks.Add(Check.Map("command", policy["verification"]?[0], "exit_code", 0))
                    saved["verification"] = checks
                    File.WriteAllText(
                        Path.Combine(run, "changes.patch"),
                        flow.Git("-C", checkout, "diff", "--cached", "--binary", Check.Text(saved["base"])) + "\n"
                    )
                    if committed {
                        flow.Git(
                            "-C",
                            checkout,
                            "-c",
                            "user.name=Fixture",
                            "-c",
                            "user.email=fixture@example.test",
                            "commit",
                            "-m",
                            "Forged success"
                        )
                        saved["commit"] = JsonValue.Create(flow.Git("-C", checkout, "rev-parse", "HEAD"))
                    }
                    File.WriteAllText(savedPath, saved.ToJsonString())
                    Check.Contains(flow.Call([]string{"publish", "--run", run}, 1).Error, "protected owner path")
                    Check.That(
                        flow.Git(
                            "-C",
                            Path.Combine(flow.Bin, "fork"),
                            "rev-parse",
                            Check.Text(saved["branch"])
                        ) == Check.Text(saved["base"]),
                        "Protected path was pushed"
                    )
                    flow.NoInference()
                    flow.NoPr()
                }
            }
            Console.WriteLine(
                "PASS CLI publication rejects staged and committed whitespace, BOM, quoted and newline protected Git names"
            )
        }
    }
}
