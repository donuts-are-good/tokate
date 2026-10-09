package TokateTests

import System
import System.IO
import System.Text.Json.Nodes

internal class RepositoryIdentityChecks {
    shared {
        private func WorkArgs(flow NativeFixture, repo string, command string = "work")[]string -> []string{
            command,
            "--repo",
            repo,
            "--issue",
            "1",
            "--model",
            "gpt-6.1-sol",
            "--effort",
            "high",
            "--seconds",
            "30",
            "--runs",
            Path.Combine(flow.Temp.Root, "runs"),
            "--json"
        }

        private func Approve(flow NativeFixture, repo string) {
            flow.Call([]string{"approve", "--repo", repo, "--issue", "1"}, owner: true)
            let approval = Check.Json(flow.Git("-C", flow.Upstream, "show", "tokate/contributions/1:state.json"))
            Check.That(Check.Text(approval["approval"]?["repo"]) == repo, "Approval spelling was rewritten")
        }

        private func MixedWork(binary string, selfOwned bool, approvalRepo string, workRepo string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.State["self_owned"] = JsonValue.Create(selfOwned)
            flow.Save()
            Approve(flow, approvalRepo)
            let approval = Check.Text(
                Check.Json(flow.Git("-C", flow.Upstream, "show", "tokate/contributions/1:state.json"))["approval_id"]
            )
            let result = Check.Envelope(flow.Acquire(WorkArgs(flow, workRepo)), "work", "ok")
            let run = Check.Text(result["data"]?["run"])
            flow.Publish(run)
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(Check.Text(saved["repo"]) == workRepo, "Run spelling was rewritten")
            Check.That(Check.Text(saved["approval"]) == approval, "Original approval was replaced")
            Check.That(Check.Text(saved["state"]) == "published", "Mixed-case work did not publish")
            Check.That(
                String.Equals(
                    Check.Text(saved["head_repo"]),
                    (selfOwned ? "owner/": "donor/") + workRepo.Split('/')[1],
                    StringComparison.OrdinalIgnoreCase
                ),
                "Wrong claim repository"
            )
            flow.Call([]string{"verify-pr", "--repo", "OWNER/PROJECT", "--pr", "10"}, owner: true)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Mixed-case work repeated inference")
            flow.AutomationAttribution()
            Console.WriteLine(
                "PASS mixed-case CLI work " + approvalRepo + " -> " + workRepo + (selfOwned ? " self-owned": " fork")
            )
        }

        private func SavedRun(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            Approve(flow, "OwNeR/PrOjEcT")
            let claim = Check.Envelope(flow.Acquire(WorkArgs(flow, "owner/project", "claim")), "claim", "ok")
            let run = Check.Text(claim["data"]?["run"])
            let path = Path.Combine(run, "run.json")
            RepositoryFaults.Reject(flow, run, []string{"work", "--run", run})
            var saved = Check.Json(File.ReadAllText(path))
            let original = saved.ToJsonString()
            for field in[]string{"approval", "base", "policy_hash", "base_branch", "branch"} {
                let text = Check.Text(saved[field])
                saved[field] = JsonValue.Create(field == "base_branch" ? "Main": text.ToUpperInvariant())
                File.WriteAllText(path, saved.ToJsonString())
                flow.Call([]string{"work", "--run", run}, 1)
                saved = Check.Json(original)
            }
            saved["repo"] = JsonValue.Create("OWNER/PROJECT")
            saved["head_repo"] = JsonValue.Create("DONOR/PROJECT")
            File.WriteAllText(path, saved.ToJsonString())
            flow.Call([]string{"work", "--run", run})
            saved = Check.Json(File.ReadAllText(path))
            saved["repo"] = JsonValue.Create("owner/project")
            saved["head_repo"] = JsonValue.Create("donor/project")
            File.WriteAllText(path, saved.ToJsonString())
            flow.Publish(run)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            flow.Reload()
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            let body = Check.Text(pull["body"])
            pull["body"] = JsonValue.Create(
                body.Replace("\"repo\":\"owner/project\"", "\"repo\":\"owner/other\"", StringComparison.Ordinal)
            )
            Check.That(Check.Text(pull["body"]) != body, "Cross-repository receipt was not changed")
            flow.Save()
            Check.Contains(
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true).Error,
                "current exact-commit coordination authority"
            )
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Saved-run validation repeated inference")
            Console.WriteLine("PASS saved-run repository case changes and exact hash/ref validation")
        }

        private func Refusals(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            Approve(flow, "OwNeR/PrOjEcT")
            flow.Git("clone", "--mirror", flow.Upstream, Path.Combine(flow.Bin, "other"))
            flow.Reload()
            flow.State["repository_folders"] = Check.Json("{\"owner/other\":\"other\"}")
            flow.Save()
            Check.Envelope(flow.Call(WorkArgs(flow, "owner/other"), 1), "work", "error", "command_failed")
            flow.NoInference()
            let claimed = Check.Envelope(flow.Acquire(WorkArgs(flow, "owner/project", "claim")), "claim", "ok")
            let run = Check.Text(claimed["data"]?["run"])
            let path = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            saved["repo"] = JsonValue.Create("owner/other")
            File.WriteAllText(path, saved.ToJsonString())
            flow.Call([]string{"work", "--run", run}, 1)
            flow.NoInference()
            saved["repo"] = JsonValue.Create("owner/project")
            File.WriteAllText(path, saved.ToJsonString())
            flow.Reload()
            flow.State["fork_parent"] = JsonValue.Create("owner/other")
            flow.Save()
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "not a fork")
            flow.Reload()
            flow.State.AsObject().Remove("fork_parent")
            flow.State["viewer_login"] = JsonValue.Create("other")
            flow.Save()
            flow.Call([]string{"work", "--run", run}, 1)
            flow.NoInference()
            flow.Reload()
            flow.State.AsObject().Remove("viewer_login")
            let issue = flow.State["issue"] ?? throw Exception("Missing issue")
            issue["title"] = JsonValue.Create("Changed issue")
            flow.Save()
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "Approval revoked or task changed")
            flow.Reload()
            let originalIssue = flow.State["issue"] ?? throw Exception("Missing issue")
            originalIssue["title"] = JsonValue.Create("Implement fixture")
            flow.Save()
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["max_seconds"] = JsonValue.Create(3601)
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Changed policy")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "policy or template changed")
            flow.NoInference()
            flow.NoPr()
            Console.WriteLine(
                "PASS different repository, unrelated fork, wrong donor and changed issue/policy refusals"
            )
        }

        private func Coordination(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize(false)
            let flow = test.Flow
            flow.OwnerAccess()
            flow.Call([]string{"approve", "--repo", "OwNeR/PrOjEcT", "--issue", "1"}, owner: true)
            let claim = test.ClaimRequest()
            var eventPath = test.Event(claim)
            let event = Check.Json(File.ReadAllText(eventPath))
            let repository = event["repository"] ?? throw Exception("Missing event repository")
            repository["full_name"] = JsonValue.Create("OwNeR/PrOjEcT")
            File.WriteAllText(eventPath, event.ToJsonString())
            flow.Call([]string{"coordinate", "--repo", "OWNER/PROJECT", "--event", eventPath}, owner: true)
            let state = test.State()
            let prepared = Check.Envelope(
                flow.Call(
                    []string{
                        "prepare",
                        "--repo",
                        "OWNER/PROJECT",
                        "--issue",
                        "1",
                        "--state",
                        Check.Text(state["sha"]),
                        "--source",
                        "external",
                        "--tools",
                        test.Tools,
                        "--seconds",
                        "30",
                        "--runs",
                        Path.Combine(flow.Temp.Root, "runs"),
                        "--json"
                    }
                ),
                "prepare",
                "ok"
            )
            let run = Check.Text(prepared["data"]?["run"])
            let savedPath = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(savedPath))
            saved["repo"] = JsonValue.Create("owner/project")
            saved["head_repo"] = JsonValue.Create("DONOR/PROJECT")
            File.WriteAllText(savedPath, saved.ToJsonString())
            let commit = test.Candidate(claim)
            flow.Call([]string{"external", "--run", run, "--commit", commit})
            flow.Call([]string{"submit", "--run", run})
            flow.Reload()
            let request = Check.PostedRequest(flow.State)
            eventPath = test.Event(request)
            flow.Call([]string{"coordinate", "--repo", "OWNER/PROJECT", "--event", eventPath}, owner: true)
            flow.Call([]string{"verify-pr", "--repo", "OWNER/PROJECT", "--pr", "10"}, owner: true)
            flow.NoInference()
            flow.AutomationAttribution()
            Console.WriteLine("PASS version-2 repository case variants through saved-run validation and publication")
        }

        internal func All(binary string) {
            MixedWork(binary, false, "OwNeR/PrOjEcT", "owner/project")
            MixedWork(binary, false, "owner/project", "OwNeR/PrOjEcT")
            MixedWork(binary, true, "OwNeR/PrOjEcT", "OWNER/PROJECT")
            SavedRun(binary)
            Refusals(binary)
            Coordination(binary)
            Console.WriteLine(
                "PASS repository case variants, saved runs, self-owned CLI work and cross-repository refusal"
            )
        }
    }
}
