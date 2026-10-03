package TokateTests

import System
import System.IO
import System.Text.Json.Nodes
import Tokate

internal class TargetBranches {
    shared {
        private func Target(flow NativeFlow, branch string) string {
            flow.Git("-C", flow.Upstream, "checkout", "-b", branch)
            File.WriteAllText(Path.Combine(flow.Upstream, ".github/tokate.json"), "{\"version\":999}")
            File.WriteAllText(Path.Combine(flow.Upstream, ".github/tokate-pr.md"), "Untrusted target template")
            File.WriteAllText(Path.Combine(flow.Upstream, "target.txt"), "Selected target code\n")
            flow.Commit("Different target configuration")
            let base = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, branch)
            flow.Git("-C", flow.Upstream, "checkout", "main")
            return base
        }

        private func Approve(flow NativeFlow, branch string) JsonNode {
            flow.Call(
                []string{
                    "approve",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--donor",
                    "donor",
                    "--base-branch",
                    branch
                },
                owner: true
            )
            let state = flow.Git("-C", flow.Upstream, "show", "tokate/contributions/1:state.json")
            return Check.Json(state)["approval"] ?? throw Exception("Missing approval")
        }

        private func Move(flow NativeFlow, branch string) string {
            if branch == "release/next" {
                flow.Git("-C", flow.Upstream, "checkout", "--orphan", "replacement-target")
                File.WriteAllText(Path.Combine(flow.Upstream, "target.txt"), "Later target code\n")
            } else {
                flow.Git("-C", flow.Upstream, "checkout", branch)
            }
            File.WriteAllText(Path.Combine(flow.Upstream, "moved.txt"), "Later target revision\n")
            flow.Commit("Advance selected target")
            let moved = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
            flow.Git("-C", flow.Upstream, "checkout", "main")
            if branch == "release/next" {
                flow.Git("-C", flow.Upstream, "branch", "-f", branch, moved)
                flow.Git("-C", flow.Upstream, "branch", "-D", "replacement-target")
            }
            return moved
        }

        private func RunBase(run string, base string, branch string) {
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["base"]) == base && Check.Text(saved["base_branch"]) == branch,
                "Run silently changed its approved base"
            )
        }

        private func Receipt(flow NativeFlow, branch string) {
            flow.Reload()
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            Check.That(Check.Text(pull["base"]?["ref"]) == branch, "Publication changed the target")
            Check.That(
                !Check.Text(pull["body"]).Contains("Untrusted target template"),
                "Target template weakened authority"
            )
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            flow.Save()
            flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10"}, owner: true)
            flow.Reload()
            flow.State["check_change"] = JsonValue.Create("base")
            flow.Save()
            flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            flow.Reload()
            flow.State["check_change"] = JsonValue.Create("")
            let restored = flow.State["pulls"]?[0]?["base"] ?? throw Exception("Missing base")
            restored["ref"] = JsonValue.Create(branch)
            flow.Save()
            flow.Reload()
            let head = flow.State["pulls"]?[0]?["head"] ?? throw Exception("Missing head")
            let sha = Check.Text(head["sha"])
            head["sha"] = JsonValue.Create(String('a', 40))
            flow.Save()
            flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            head["sha"] = JsonValue.Create(sha)
            let target = flow.State["pulls"]?[0]?["base"] ?? throw Exception("Missing base")
            target["ref"] = JsonValue.Create("main")
            flow.Save()
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            target["ref"] = JsonValue.Create(branch)
            flow.Save()
            flow.Git("-C", flow.Upstream, "branch", "-D", branch)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        }

        private func V1(binary string, branch string) {
            using let flow = NativeFlow(binary)
            flow.Initialize()
            let base = Target(flow, branch)
            flow.Call(
                []string{
                    "approve",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--donor",
                    "donor",
                    "--base-branch=" + branch
                },
                owner: true
            )
            let approvalSha = flow.Git("-C", flow.Upstream, "rev-parse", "tokate/approvals/1")
            let approval = Check.Json(
                flow.Git("-C", flow.Upstream, "show", "tokate/approvals/1:.github/tokate-approval.json")
            )
            Check.That(
                Check.Text(approval["authority_branch"]) == "main" && Check.Text(approval["base"]) == base &&
                    Check.Text(approval["base_branch"]) == branch,
                "Approval did not separate target and authority"
            )
            let moved = Move(flow, branch)
            let run = flow.Claim()
            RunBase(run, base, branch)
            let work = flow.Call([]string{"work", "--run", run})
            Check.Contains(work.Error, base)
            Check.Contains(work.Error, moved)
            Check.That(
                !File.Exists(Path.Combine(run, "checkout/moved.txt")),
                "Managed preparation checked out the moving target"
            )
            Check.That(
                flow.Git("-C", flow.Upstream, "rev-parse", "tokate/approvals/1") == approvalSha,
                "Movement rewrote approval"
            )
            RunBase(run, base, branch)
            Receipt(flow, branch)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Target changes repeated inference")
        }

        private func V2(binary string, branch string, external bool) {
            using let test = CoordinationFlow(binary)
            test.Initialize()
            let flow = test.Flow
            let base = Target(flow, branch)
            let approval = Approve(flow, branch)
            Check.That(
                Check.Text(approval["authority_branch"]) == "main" && Check.Text(approval["base"]) == base,
                "V2 target lost approval authority"
            )
            let claim = test.ClaimRequest()
            test.Coordinate(test.Event(claim))
            if !external {
                File.WriteAllText(
                    test.Tools,
                    "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
                )
            }
            let moved = Move(flow, branch)
            let run = test.Prepare(external ? "external": "tokate")
            RunBase(run, base, branch)
            if external {
                let checkout = Path.Combine(flow.Temp.Root, "donor-work")
                flow.Git("clone", flow.Upstream, checkout)
                flow.Git("-C", checkout, "checkout", "--detach", base)
                File.WriteAllText(Path.Combine(checkout, "result.txt"), "External contribution\n")
                flow.Git("-C", checkout, "add", ".")
                flow.Git(
                    "-C",
                    checkout,
                    "-c",
                    "user.name=Donor",
                    "-c",
                    "user.email=donor@example.test",
                    "commit",
                    "-m",
                    "Result"
                )
                let head = flow.Git("-C", checkout, "rev-parse", "HEAD")
                flow.Git(
                    "-C",
                    checkout,
                    "push",
                    Path.Combine(flow.Bin, "fork"),
                    "HEAD:refs/heads/tokate/v2-" + Check.Text(claim["uuid"])
                )
                let result = flow.Call([]string{"external", "--run", run, "--commit", head})
                Check.Contains(result.Error, base)
                Check.Contains(result.Error, moved)
                flow.NoInference()
            } else {
                flow.Call([]string{"work", "--run", run})
            }
            Check.That(
                !File.Exists(Path.Combine(run, "checkout/moved.txt")),
                "V2 prepared the moving target instead of approved base"
            )
            RunBase(run, base, branch)
            flow.Call([]string{"submit", "--run", run})
            let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
            test.Coordinate(test.Event(request))
            Receipt(flow, branch)
        }

        private func Freshness(binary string, version int32, change string) {
            using let test = CoordinationFlow(binary)
            let flow = test.Flow
            if version == 2 {
                test.Initialize()
            } else {
                flow.Initialize()
            }
            let branch = "release/freshness"
            let base = Target(flow, branch)
            if change == "missing" {
                flow.Git("-C", flow.Upstream, "branch", "-D", branch)
                flow.Call(
                    []string{
                        "approve",
                        "--repo",
                        "owner/project",
                        "--issue",
                        "1",
                        "--donor",
                        "donor",
                        "--base-branch",
                        branch
                    },
                    1,
                    owner: true
                )
                flow.NoInference()
                return
            }
            flow.Call(
                []string{
                    "approve",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--donor",
                    "donor",
                    "--base-branch",
                    branch
                },
                owner: true
            )
            var run = ""
            if version == 2 {
                test.Coordinate(test.Event(test.ClaimRequest()))
                run = test.Prepare()
            } else {
                run = flow.Claim()
            }
            let saved = File.ReadAllText(Path.Combine(run, "run.json"))
            if change == "deleted" {
                flow.Git("-C", flow.Upstream, "branch", "-D", branch)
            } else if change == "authority" {
                flow.Reload()
                flow.State["default_branch"] = JsonValue.Create(branch)
                flow.Save()
            } else {
                if change == "policy" {
                    let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                    let policy = Check.Json(File.ReadAllText(path))
                    policy["max_seconds"] = JsonValue.Create(3599)
                    File.WriteAllText(path, policy.ToJsonString())
                } else {
                    File.AppendAllText(
                        Path.Combine(flow.Upstream, ".github/tokate-pr.md"),
                        "\nChanged authority template\n"
                    )
                }
                flow.Commit("Owner configuration changed")
                flow.Git("-C", flow.Upstream, "checkout", "main")
            }
            let result = version == 1 ? flow.Call([]string{"work", "--run", run}, 1): flow.Call(
                []string{"external", "--run", run, "--commit", base},
                1
            )
            if change != "deleted" {
                Check.Contains(result.Error, "approve again")
            }
            Check.That(
                File.ReadAllText(Path.Combine(run, "run.json")) == saved,
                "Failed freshness check rewrote saved run"
            )
            flow.NoInference()
            flow.NoPr()
        }

        private func Legacy(binary string, version int32) {
            using let test = CoordinationFlow(binary)
            let flow = test.Flow
            if version == 2 {
                test.Initialize()
                let state = test.State()["state"] ?? throw Exception("Missing state")
                let approval = state["approval"]?.AsObject() ?? throw Exception("Missing approval")
                approval.Remove("authority_branch")
                state["approval_id"] = JsonValue.Create(
                    Data.Hash(RequestData.Canonical(RequestData.Parse(approval.ToJsonString())))
                )
                test.RewriteState(state)
                test.Coordinate(test.Event(test.ClaimRequest()))
                File.WriteAllText(
                    test.Tools,
                    "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
                )
            } else {
                flow.Initialize()
                flow.Approve()
                flow.Git("-C", flow.Upstream, "checkout", "tokate/approvals/1")
                let path = Path.Combine(flow.Upstream, ".github/tokate-approval.json")
                let approval = Check.Json(File.ReadAllText(path)).AsObject()
                approval.Remove("authority_branch")
                File.WriteAllText(path, approval.ToJsonString())
                flow.Commit("Legacy approval without new fields")
                flow.Git("-C", flow.Upstream, "checkout", "main")
            }
            let run = version == 1 ? flow.Claim(): test.Prepare("tokate")
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(saved["authority_branch"] == nil, "Legacy run was migrated")
            File.WriteAllText(
                Path.Combine(flow.Upstream, "later.txt"),
                "Later code does not rewrite the legacy approved base\n"
            )
            flow.Commit("Move default branch")
            flow.Call([]string{"work", "--run", run})
            if version == 2 {
                flow.Call([]string{"submit", "--run", run})
                test.Coordinate(test.Event(Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))))
            }
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            flow.Git("-C", flow.Upstream, "branch", "other")
            flow.Reload()
            flow.State["default_branch"] = JsonValue.Create("other")
            flow.Save()
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        }

        internal func All(binary string) {
            for branch in[]string{"release", "release/next"} {
                V1(binary, branch)
                Console.WriteLine("PASS V1 selected target " + branch)
            }
            V2(binary, "release", false)
            V2(binary, "release/next", true)
            Console.WriteLine("PASS V2 managed and external selected targets")
            for version in[]int32{1, 2} {
                for change in[]string{"missing", "deleted", "authority", "policy", "template"} {
                    Freshness(binary, version, change)
                    Console.WriteLine("PASS V" + version.ToString() + " target freshness: " + change)
                }
                Legacy(binary, version)
                Console.WriteLine("PASS V" + version.ToString() + " unchanged legacy branch/freshness semantics")
            }
        }
    }
}
