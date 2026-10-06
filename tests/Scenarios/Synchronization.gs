package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class SynchronizationChecks {
    shared {
        internal func StartTreeTraffic(flow NativeFixture) {
            flow.ResetTraffic()
            File.WriteAllText(Path.Combine(flow.Bin, "local-tree-heads.txt"), "")
        }

        internal func TreeTraffic(flow NativeFixture, previous string, grants int32, later bool, local bool) {
            flow.Reload()
            let heads = File.ReadAllLines(Path.Combine(flow.Bin, "local-tree-heads.txt"))
            let previousTree = flow.Git("-C", Path.Combine(flow.Bin, "fork"), "rev-parse", previous + "^{tree}")
            var localPasses int32
            for head in heads {
                if head == previous {
                    localPasses++
                }
            }
            var remotePasses int32
            var upstreamTrees int32
            var forkTrees int32
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                let path = Check.Text(call["path"])
                if !path.Contains("/git/trees/") || !path.EndsWith("?recursive=1", StringComparison.Ordinal) {
                    continue
                }
                if path.StartsWith("repos/owner/project/", StringComparison.Ordinal) {
                    upstreamTrees++
                } else {
                    forkTrees++
                }
                if path == "repos/donor/project/git/trees/" + previousTree + "?recursive=1" {
                    remotePasses++
                }
            }
            let candidateTrees = 2 * grants + (later ? 1: 0)
            if local {
                Check.That(localPasses > 0, "Missing local synchronization pass")
                Check.That(heads.Length == localPasses * candidateTrees, "Repeated local tree materialization")
            } else {
                Check.That(heads.Length == 0 && remotePasses == 1, "Missing isolated remote synchronization pass")
                Check.That(forkTrees == candidateTrees, "Repeated remote candidate tree materialization")
                Check.That(upstreamTrees == grants + 1, "Repeated repository baseline tree materialization")
            }
            Console.WriteLine(
                "Tree traffic: grants=" + grants.ToString() + " later=" + later.ToString() +
                    " local_passes=" +
                    localPasses.ToString() + " local_trees=" + heads.Length.ToString() +
                    " upstream_trees=" +
                    upstreamTrees.ToString() + " fork_trees=" + forkTrees.ToString()
            )
        }

        private func Saved(run string) JsonNode -> Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))

        private func Commit(flow NativeFixture, checkout string, message string) string {
            flow.Git("-C", checkout, "add", "-A")
            flow.Git(
                "-C",
                checkout,
                "-c",
                "user.name=Owner-reviewed donor",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-m",
                message
            )
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        private func Upstream(flow NativeFixture, ordinary bool = false, conflict bool = false) string {
            if ordinary {
                PublishedContribution.Write(flow.Upstream, "upstream.txt", "ordinary upstream change\n")
            } else {
                PublishedContribution.Write(flow.Upstream, ".github/workflows/verify.yml", "timeout-minutes: 30\n")
                flow.Git("-C", flow.Upstream, "mv", ".github/workflows/old.yml", ".github/workflows/renamed.yml")
                File.Delete(Path.Combine(flow.Upstream, "protected/gone"))
                File.SetUnixFileMode(
                    Path.Combine(flow.Upstream, "protected/content"),
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                )
                File.Delete(Path.Combine(flow.Upstream, "protected/link"))
                File.CreateSymbolicLink(Path.Combine(flow.Upstream, "protected/link"), "content")
                PublishedContribution.Write(flow.Upstream, "protected/new", "owner addition\n")
                PublishedContribution.Write(flow.Upstream, "guard/other", "owner sibling change\n")
            }
            if conflict {
                PublishedContribution.Write(flow.Upstream, "shared.txt", "owner shared resolution input\n")
            }
            flow.Commit("Owner trusted target")
            return flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
        }

        private func Candidate(flow NativeFixture, run string, upstream string, conflict bool = false) string {
            let checkout = Path.Combine(run, "checkout")
            if conflict {
                PublishedContribution.Write(checkout, "shared.txt", "donor conflicting line\n")
                Commit(flow, checkout, "Donor conflict input")
            }
            flow.Git("-C", checkout, "fetch", flow.Upstream, upstream)
            let env = Dictionary[string, string](flow.Temp.Env)
            for key in[]string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"} {
                env.Remove(key)
            }
            let merged = TestProcess.Run(
                "/usr/bin/git",
                []string{
                    "-C",
                    checkout,
                    "-c",
                    "user.name=Reviewed",
                    "-c",
                    "user.email=fixture@example.test",
                    "merge",
                    "--no-ff",
                    "--no-edit",
                    upstream
                },
                env
            )
            if conflict {
                Check.That(merged.Code == 1 && merged.Output.Contains("CONFLICT"), "Missing actual textual conflict")
                PublishedContribution.Write(checkout, "shared.txt", "Explicit owner-reviewed nonprotected resolution\n")
                return Commit(flow, checkout, "Owner-reviewed conflict resolution")
            }
            Check.Success(merged)
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        private func Grant(
            flow NativeFixture,
            candidate string,
            upstream string,
            code int32 = 0,
            owner bool = true
        ) string {
            flow.ResetTraffic()
            let result = flow.Call(
                []string{
                    "authorize-sync",
                    "--repo",
                    "owner/project",
                    "--pr",
                    "10",
                    "--commit",
                    candidate,
                    "--upstream",
                    upstream,
                    "--json"
                },
                code,
                owner: owner
            )
            flow.Reload()
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(!Check.Text(call["path"]).Contains(candidate), "Grant inspected private candidate")
                Check.That(
                    !(
                        Check.Text(call["method"]) == "PATCH" && Check.Text(call["path"]).Contains(
                            "tokate/contributions"
                        )
                    ),
                    "Grant advanced coordination state"
                )
            }
            if code != 0 {
                return ""
            }
            let grant = Check.Text(Check.Json(result.Output)["data"]?["grant"])
            Check.That(grant.Length == 40, "Missing grant identity")
            return grant
        }

        private func Amend(flow NativeFixture, run string, candidate string, grant string = "", code int32 = 0) Result {
            let args = List[string]{"amend", "--run", run, "--commit", candidate, "--seconds", "30"}
            if grant != "" {
                args.AddRange([]string{"--sync", grant})
            }
            return flow.Call(args.ToArray(), code)
        }

        private func Revoke(flow NativeFixture, grant string) {
            let result = flow.Call(
                []string{"revoke-sync", "--repo", "owner/project", "--grant", grant, "--json"},
                owner: true
            )
            Check.That(
                Check.Text(Check.Json(result.Output)["data"]?["grant"]) == grant,
                "Revocation lost grant identity"
            )
            let value = Check.Json(flow.Git("-C", flow.Upstream, "show", grant + ":synchronization.json"))
            let reference = "refs/heads/tokate/synchronizations/1/" + Check.Text(value["id"])
            let revoked = flow.Git("-C", flow.Upstream, "rev-parse", reference)
            let parents = flow.Git("-C", flow.Upstream, "rev-list", "--parents", "-n", "1", revoked).Split(' ')
            Check.That(parents.Length == 2 && parents[1] == grant, "Revocation did not preserve G as sole parent")
            Check.Contains(flow.Git("-C", flow.Upstream, "show", grant + ":synchronization.json"), "candidate")
        }

        private func Mutate(flow NativeFixture, run string, mode string, candidate string) string {
            let checkout = Path.Combine(run, "checkout")
            let content = Path.Combine(checkout, "protected/content")
            switch mode {
                case "blob" {
                    File.AppendAllText(content, "donor alteration\n")
                }
                case "mode" {
                    File.SetUnixFileMode(content, UnixFileMode.UserRead | UnixFileMode.UserWrite)
                }
                case "type" {
                    File.Delete(content)
                    File.CreateSymbolicLink(content, "new")
                }
                case "addition" {
                    PublishedContribution.Write(checkout, ".github/workflows/donor.yml", "donor workflow\n")
                }
                case "deletion" {
                    File.Delete(content)
                }
                case "rename-from" {
                    flow.Git("-C", checkout, "mv", "protected/new", "stolen.txt")
                }
                case "rename-to" {
                    flow.Git("-C", checkout, "mv", "result.txt", "protected/donor.txt")
                }
                case "absence" {
                    PublishedContribution.Write(checkout, "guard/missing", "donor addition at previously absent path\n")
                }
                case "ancestor" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                    File.CreateSymbolicLink(Path.Combine(checkout, "guard"), "protected")
                }
                case "ancestor-file" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                    PublishedContribution.Write(checkout, "guard", "donor ancestor file\n")
                }
                case "ancestor-submodule" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                    flow.Git("-C", checkout, "rm", "--cached", "-r", "guard")
                    flow.Git("clone", flow.Upstream, Path.Combine(checkout, "guard"))
                }
                case "sibling-creation" {
                    PublishedContribution.Write(checkout, "new-parent/public", "unrelated sibling\n")
                }
                case "sibling-removal" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                }
                case "decree", "decree-coordinator" {
                    PublishedContribution.Write(checkout, "DECREE.md", "Unapproved donor instructions\n")
                }
                case "reversion" {
                    PublishedContribution.Write(checkout, ".github/workflows/verify.yml", "timeout-minutes: 15\n")
                }
                case "semantic" {
                    PublishedContribution.Write(checkout, "result.txt", "")
                }
                default {
                    return candidate
                }
            }
            return Commit(flow, checkout, "Exact candidate with " + mode)
        }

        private func Run(preparation PublishedContribution, v2 bool, mode string) {
            preparation.Restore()
            if mode.StartsWith("reconcile-", StringComparison.Ordinal) {
                Reconcile(preparation, v2, mode.Substring("reconcile-".Length))
                return
            }
            let coordination = preparation.Coordination
            let flow = coordination.Flow
            let selected = mode == "selected-target" || mode == "authority-policy"
            let target = selected ? "release/review": ""
            let run = preparation.Run
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let h = Check.Text(Saved(run)["commit"])
            let stateBefore = v2 ? Check.Text(coordination.State()["sha"]): ""
            if selected {
                flow.Git("-C", flow.Upstream, "checkout", target)
            }
            let upstream = Upstream(flow, mode == "ordinary", mode == "conflict")
            var candidate = Candidate(flow, run, upstream, mode == "conflict")
            if mode == "stale-creation" {
                Grant(flow, candidate, Check.Text(Saved(run)["base"]), 1)
                return
            }
            if mode == "donor-grant" {
                Grant(flow, candidate, upstream, 1, false)
                return
            }
            if mode == "authority-policy" {
                flow.Git("-C", flow.Upstream, "checkout", "main")
                let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                let policy = Check.Json(File.ReadAllText(path))
                policy["max_seconds"] = JsonValue.Create(301)
                File.WriteAllText(path, policy.ToJsonString())
                flow.Commit("Authority policy changed")
                Grant(flow, candidate, upstream, 1)
                return
            }
            if mode == "unresolved" {
                File.WriteAllText(Path.Combine(run, "checkout/.git/MERGE_HEAD"), upstream + "\n")
            }
            candidate = Mutate(flow, run, mode, candidate)
            if mode == "ancestor-submodule" {
                Check.That(
                    flow.Git("-C", Path.Combine(run, "checkout"), "ls-tree", candidate, "--", "guard").StartsWith(
                        "160000 commit ",
                        StringComparison.Ordinal
                    ),
                    "Missing actual ancestor submodule"
                )
            }
            let grant = Grant(flow, candidate, upstream)
            if v2 {
                Check.That(Check.Text(coordination.State()["sha"]) == stateBefore, "Grant reset reservation/state S")
            }
            if mode == "decree-coordinator" {
                flow.Git(
                    "-C",
                    Path.Combine(run, "checkout"),
                    "push",
                    Path.Combine(flow.Bin, "fork"),
                    candidate + ":refs/heads/" + Check.Text(Saved(run)["branch"])
                )
                let state = coordination.State()
                let request = Check.Map(
                    "uuid",
                    Guid.NewGuid().ToString("D"),
                    "expected",
                    Check.Text(state["sha"]),
                    "approval",
                    Check.Text(state["state"]?["approval_id"]),
                    "action",
                    "amend",
                    "metadata",
                    Check.Map(
                        "fork",
                        Check.Text(Saved(run)["head_repo"]),
                        "branch",
                        Check.Text(Saved(run)["branch"]),
                        "previous",
                        h,
                        "head",
                        candidate,
                        "pr",
                        10,
                        "seconds",
                        30,
                        "tools",
                        Check.Json(File.ReadAllText(coordination.Tools)),
                        "verification",
                        "donor-reported-pass",
                        "attempt",
                        Check.Text(state["state"]?["reservation"]?["attempt"]),
                        "sync",
                        grant
                    )
                )
                let result = coordination.Coordinate(coordination.Event(request), 1)
                Check.Contains(
                    result.Output + result.Error,
                    "Synchronization changes protected owner content: \"DECREE.md\""
                )
                Check.That(
                    Check.Text(coordination.State()["sha"]) == stateBefore,
                    "Rejected DECREE changed coordination authority"
                )
                return
            }
            if mode == "revoked" {
                Revoke(flow, grant)
            } else if mode == "deleted" || mode == "donor-ref" || mode == "moved-ref" {
                let value = Check.Json(flow.Git("-C", flow.Upstream, "show", grant + ":synchronization.json"))
                let reference = "refs/heads/tokate/synchronizations/1/" + Check.Text(value["id"])
                flow.Git("-C", flow.Upstream, "update-ref", "-d", reference)
                if mode == "donor-ref" {
                    flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, grant)
                    flow.Git("-C", Path.Combine(flow.Bin, "fork"), "update-ref", reference, grant)
                } else if mode == "moved-ref" {
                    flow.Git("-C", flow.Upstream, "update-ref", reference, upstream)
                }
            } else if mode == "stale-target" {
                PublishedContribution.Write(flow.Upstream, "movement.txt", "target advanced\n")
                flow.Commit("Target moved after grant")
            } else if mode == "policy" || mode == "template" {
                File.AppendAllText(
                    Path.Combine(flow.Upstream, mode == "policy" ? ".github/tokate.json": ".github/tokate-pr.md"),
                    "\n "
                )
                flow.Commit("Owner scope changed")
            } else if mode == "substitution" {
                PublishedContribution.Write(Path.Combine(run, "checkout"), "another.txt", "different candidate\n")
                candidate = Commit(flow, Path.Combine(run, "checkout"), "Candidate substitution")
            } else if mode.StartsWith("local-tree-") || mode == "local-final-ancestry" {
                flow.Reload()
                if mode == "local-final-ancestry" {
                    flow.State["local_final_ancestry_fault"] = JsonValue.Create("true")
                } else {
                    flow.State["local_tree_fault"] = JsonValue.Create(mode.Substring("local-tree-".Length))
                }
                flow.Save()
            } else if mode.StartsWith("tree-") && mode != "tree-reuse" {
                flow.Reload()
                flow.State["tree_fault"] = JsonValue.Create(mode.Substring(5))
                flow.Save()
            } else if mode == "after-push" {
                flow.Mode("revoke_sync_after_push")
            }
            let success = mode == "timeout" ||
                mode == "tree-reuse" ||
                mode == "ordinary" ||
                mode == "conflict" ||
                mode == "sibling-creation" ||
                mode == "sibling-removal" ||
                mode == "selected-target" ||
                mode == "decree-after-sync" ||
                mode == "after-coordinate" ||
                mode == "state-mismatch"
            var requests int32
            var records int32
            var jobs int32
            if v2 && mode == "timeout" {
                flow.Reload()
                requests = Int32.Parse(Check.Text(flow.State["request_count"] ?? JsonValue.Create(0)))
                records = Int32.Parse(Check.Text(flow.State["workflow_records"] ?? JsonValue.Create(0)))
                jobs = Int32.Parse(Check.Text(flow.State["workflow_jobs"] ?? JsonValue.Create(0)))
                flow.Mode("lost_request_response")
            }
            if mode == "tree-reuse" {
                StartTreeTraffic(flow)
            }
            let result = Amend(flow, run, candidate, grant, success ? 0: 1)
            if mode == "tree-reuse" {
                TreeTraffic(flow, h, 1, false, true)
            }
            if !success {
                if mode.StartsWith("local-tree-") {
                    Check.Contains(
                        result.Output + result.Error,
                        mode.EndsWith("truncated") ?
                        "Truncated protected tree evidence": "Invalid protected tree evidence"
                    )
                } else if mode == "local-final-ancestry" {
                    Check.Contains(result.Output + result.Error, "Missing local synchronization ancestry evidence")
                }
                Check.That(
                    Check.Text(Saved(run)["commit"]) == h,
                    "Rejected synchronization rewrote original saved head"
                )
                if mode.StartsWith("ancestor", StringComparison.Ordinal) {
                    Check.Contains(
                        result.Output + result.Error,
                        "Synchronization changes protected owner content: \"guard\""
                    )
                }
                if mode == "decree" {
                    Check.Contains(
                        result.Output + result.Error,
                        "Synchronization changes protected owner content: \"DECREE.md\""
                    )
                }
                if mode == "semantic" {
                    let failed = Saved(Path.Combine(run, "amendments", candidate))
                    Check.That(
                        Check.Text(failed["state"]) == "failed",
                        "Clean merge semantic failure lost verification evidence"
                    )
                    Check.That(
                        File.Exists(Path.Combine(run, "amendments", candidate, "verification.json")),
                        "Missing failed owner check"
                    )
                } else if mode == "after-push" {
                    flow.Reload()
                    Check.That(
                        Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"]) == candidate,
                        "Race did not preserve physical push"
                    )
                    flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
                }
                return
            }
            if v2 {
                flow.Reload()
                let request = Check.PostedRequest(flow.State)
                if mode == "timeout" {
                    let path = Path.Combine(run, "amendments", candidate, "request.json")
                    let savedRequest = File.ReadAllText(path)
                    let journal = File.ReadAllText(path + ".posting.json")
                    let posted = Check.Text(flow.State["posted_request"]?["body"])
                    Check.That(
                        Check.Text(request["metadata"]?["sync"]) == grant && Check.Text(
                            Check.Json(journal)["request"]?["metadata"]?["sync"]
                        ) == grant,
                        "Lost response changed exact synchronization binding"
                    )
                    flow.Call([]string{"request", "--repo", "owner/project", "--issue", "1", "--file", path})
                    flow.Reload()
                    Check.That(
                        Int32.Parse(Check.Text(flow.State["request_count"])) == requests + 1 && Int32.Parse(
                            Check.Text(flow.State["workflow_records"])
                        ) == records +
                            1 &&
                            Int32.Parse(Check.Text(flow.State["workflow_jobs"])) == jobs + 1,
                        "Lost response or duplicate synchronization repeated a comment or workflow"
                    )
                    Check.That(
                        File.ReadAllText(path) == savedRequest && File.ReadAllText(path + ".posting.json") == journal &&
                            Check.Text(flow.State["posted_request"]?["body"]) == posted,
                        "Duplicate synchronization changed saved or physical request binding"
                    )
                }
                if mode == "state-mismatch" {
                    coordination.RewriteState(coordination.State()["state"] ?? throw Exception("Missing state"))
                    coordination.Coordinate(coordination.Event(request), 1)
                    return
                }
                if mode == "after-coordinate" {
                    Revoke(flow, grant)
                    coordination.Coordinate(coordination.Event(request), 1)
                    return
                }
                coordination.Coordinate(coordination.Event(request))
                Amend(flow, run, candidate, grant)
            }
            if mode == "tree-reuse" {
                StartTreeTraffic(flow)
            }
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            if mode == "tree-reuse" {
                TreeTraffic(flow, h, 1, false, false)
                flow.Reload()
                flow.State["diff_fault"] = JsonValue.Create("wrong-identical-base")
                flow.Save()
                let refused = flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
                Check.Contains(
                    refused.Output + refused.Error,
                    "Missing or mismatched synchronization ancestry evidence"
                )
                flow.Reload()
                flow.State["diff_fault"] = nil
                flow.Save()
            }
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/run.json")) == original,
                "Original receipt/evidence overwritten"
            )
            Check.That(
                Check.Text(Saved(run)["base"]) == Check.Text(Check.Json(original)["base"]),
                "Approval base rewritten"
            )
            Check.That(
                Saved(Path.Combine(run, "amendments", candidate))["verification"]?.AsArray().Count == 2,
                "Synchronization skipped independent owner commands"
            )
            Check.That(
                File.Exists(Path.Combine(run, "amendments", candidate, "conflict-evidence.txt")),
                "Missing conflict/parent evidence"
            )
            Check.Contains(
                flow.Git("-C", Path.Combine(flow.Bin, "fork"), "show", candidate + ":.github/workflows/verify.yml"),
                mode == "ordinary" ? "15": "30"
            )
            Check.Contains(flow.Git("-C", Path.Combine(flow.Bin, "fork"), "show", h + ":result.txt"), "")
            if mode == "decree-after-sync" {
                PublishedContribution.Write(
                    Path.Combine(run, "checkout"),
                    "DECREE.md",
                    "Unapproved later instructions\n"
                )
                let next = Commit(flow, Path.Combine(run, "checkout"), "Ordinary amendment changes DECREE")
                let rejected = Amend(flow, run, next, code: 1)
                Check.Contains(
                    rejected.Output + rejected.Error,
                    "Synchronization changes protected owner content: \"DECREE.md\""
                )
                return
            }
            PublishedContribution.Write(Path.Combine(run, "checkout"), "followup.txt", "ordinary review correction\n")
            let next = Commit(flow, Path.Combine(run, "checkout"), "Ordinary amendment after synchronization")
            if mode == "tree-reuse" {
                StartTreeTraffic(flow)
            }
            Amend(flow, run, next)
            if mode == "tree-reuse" {
                TreeTraffic(flow, h, 1, true, true)
            }
            if v2 {
                flow.Reload()
                let request = Check.PostedRequest(flow.State)
                coordination.Coordinate(coordination.Event(request))
                Amend(flow, run, next)
            }
            if mode == "tree-reuse" {
                StartTreeTraffic(flow)
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                TreeTraffic(flow, h, 1, true, false)
            }
            let history = Saved(run)["synchronizations"]?[0] ?? throw Exception("Lost historical synchronization")
            Check.That(
                Check.Text(history["candidate"]) == candidate && Check.Text(history["upstream"]) == upstream &&
                    Check.Text(history["grant"]) == grant,
                "D relabeled historical G/C/U"
            )
            flow.Reload()
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            flow.Save()
            flow.Call([]string{"checks", "--run", run}, owner: true)
            PublishedContribution.Write(flow.Upstream, "later-target.txt", "acceptance must recheck target\n")
            flow.Commit("Target moved before final acceptance")
            flow.Call([]string{"checks", "--run", run}, 1, owner: true)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            let newUpstream = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
            let newCandidate = Candidate(flow, run, newUpstream)
            let newGrant = Grant(flow, newCandidate, newUpstream)
            if mode == "tree-reuse" {
                StartTreeTraffic(flow)
            }
            Amend(flow, run, newCandidate, newGrant)
            if mode == "tree-reuse" {
                TreeTraffic(flow, h, 2, false, true)
            }
            if v2 {
                flow.Reload()
                let request = Check.PostedRequest(flow.State)
                coordination.Coordinate(coordination.Event(request))
                Amend(flow, run, newCandidate, newGrant)
            }
            Check.That(Saved(run)["synchronizations"]?.AsArray().Count == 2, "New grant discarded history")
            if mode == "tree-reuse" {
                StartTreeTraffic(flow)
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                TreeTraffic(flow, h, 2, false, false)
                PublishedContribution.Write(Path.Combine(run, "checkout"), "two-grant-followup.txt", "later head\n")
                let later = Commit(flow, Path.Combine(run, "checkout"), "Later head after two grants")
                StartTreeTraffic(flow)
                Amend(flow, run, later)
                TreeTraffic(flow, h, 2, true, true)
                if v2 {
                    flow.Reload()
                    coordination.Coordinate(coordination.Event(Check.PostedRequest(flow.State)))
                    Amend(flow, run, later)
                }
                StartTreeTraffic(flow)
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                TreeTraffic(flow, h, 2, true, false)
                let tree = flow.Git("-C", Path.Combine(flow.Bin, "fork"), "rev-parse", later + "^{tree}")
                flow.Reload()
                flow.State["tree_fault"] = JsonValue.Create("truncated")
                flow.State["tree_fault_sha"] = JsonValue.Create(tree)
                flow.Save()
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
                flow.Reload()
                flow.State["tree_fault"] = nil
                flow.State["tree_fault_sha"] = nil
                flow.Save()
                PublishedContribution.Write(
                    Path.Combine(run, "checkout"),
                    "protected/content",
                    "unapproved later edit\n"
                )
                let protectedHead = Commit(flow, Path.Combine(run, "checkout"), "Protected later head")
                let rejected = Amend(flow, run, protectedHead, code: 1)
                Check.Contains(rejected.Output + rejected.Error, "Synchronization changes protected owner content")
            }
            Revoke(flow, grant)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            if v2 {
                flow.NoInference()
            }
        }

        private func Reconcile(preparation PublishedContribution, v2 bool, mode string) {
            let coordination = preparation.Coordination
            let flow = coordination.Flow
            let run = preparation.Run
            let checkout = Path.Combine(run, "checkout")
            let before = Saved(run)
            let h = Check.Text(before["commit"])
            let base = Check.Text(before["base"])
            let verification = File.ReadAllText(Path.Combine(run, "verification.json"))
            flow.Reload()
            let inference = Check.Text(flow.State["exec_count"])
            let pushes = Check.Text(flow.State["git_pushes"])
            let selected = mode == "selected"
            if selected {
                flow.Git("-C", flow.Upstream, "checkout", "release/review")
            }
            let conflict = mode == "conflict" || mode == "protected"
            let upstream = Upstream(flow, conflict: conflict || mode == "interruption")
            var start = h
            if mode == "edits" || conflict || mode == "interruption" {
                PublishedContribution.Write(
                    checkout,
                    mode == "edits" ? "local.txt": "shared.txt",
                    "committed donor work\n"
                )
                start = Commit(flow, checkout, "Committed local work")
            }
            var index = File.ReadAllBytes(Path.Combine(checkout, ".git/index"))
            if mode == "dirty" {
                PublishedContribution.Write(checkout, "private.txt", "uncommitted work\n")
                File.AppendAllText(Path.Combine(checkout, "result.txt"), "staged local edit\n")
                flow.Git("-C", checkout, "add", "result.txt")
                File.AppendAllText(Path.Combine(checkout, "result.txt"), "unstaged local edit\n")
                index = File.ReadAllBytes(Path.Combine(checkout, ".git/index"))
            } else if mode == "driver" || mode == "filter" {
                PublishedContribution.Write(
                    checkout,
                    ".gitattributes",
                    "* " + (mode == "driver" ? "merge=hostile": "filter=hostile") + "\n"
                )
                Commit(flow, checkout, "Repository-selected program")
                flow.Git(
                    "-C",
                    checkout,
                    "config",
                    mode == "driver" ? "merge.hostile.driver": "filter.hostile.clean",
                    "touch " + Path.Combine(flow.Temp.Root, "executed")
                )
            } else if mode == "metadata" {
                File.WriteAllText(
                    Path.Combine(checkout, ".git/objects/info/alternates"),
                    flow.Upstream + "/.git/objects\n"
                )
            } else if mode == "submodule-filter" {
                let module = Path.Combine(checkout, "module")
                flow.Git("clone", flow.Upstream, module)
                PublishedContribution.Write(module, ".gitattributes", "* filter=hostile\n")
                Commit(flow, module, "Submodule attributes")
                Commit(flow, checkout, "Embedded submodule")
                flow.Git(
                    "-C",
                    module,
                    "config",
                    "filter.hostile.clean",
                    "touch " + Path.Combine(flow.Temp.Root, "executed")
                )
                File.AppendAllText(Path.Combine(module, "shared.txt"), "dirty submodule work\n")
            } else if mode == "unidentified" {
                File.Delete(Path.Combine(run, v2 ? "coding": "checkout", ".git/tokate-preparation.json"))
            } else if mode == "operation" {
                Directory.CreateDirectory(Path.Combine(checkout, ".git/rebase-merge"))
            } else if mode == "local-divergence" {
                flow.Git("-C", checkout, "checkout", "--detach", base)
            } else if mode == "fork-divergence" {
                flow.Git(
                    "-C",
                    Path.Combine(flow.Bin, "fork"),
                    "update-ref",
                    "refs/heads/" + Check.Text(before["branch"]),
                    base
                )
            } else if mode == "unpublished" || mode == "failed" {
                before["state"] = JsonValue.Create(mode == "failed" ? "failed": "claimed")
                Check.SaveJson(Path.Combine(run, "run.json"), before)
            } else if mode == "closed" || mode == "merged" {
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                pull[mode == "closed" ? "state": "merged"] = mode == "closed" ? JsonValue.Create(
                    "closed"
                ): JsonValue.Create(true)
                flow.Save()
            }
            let refuse = Array.IndexOf(
                []string{
                    "dirty",
                    "driver",
                    "filter",
                    "metadata",
                    "submodule-filter",
                    "unidentified",
                    "operation",
                    "local-divergence",
                    "fork-divergence",
                    "unpublished",
                    "failed",
                    "closed",
                    "merged",
                    "donor"
                },
                mode
            ) >= 0
            flow.ResetTraffic()
            if mode == "interruption" {
                flow.State["mode"] = JsonValue.Create("reconcile_merge_pause")
                flow.Save()
                let entered = Path.Combine(flow.Bin, "reconcile-merge-entered")
                let repeated = Path.Combine(flow.Bin, "reconcile-merge-repeated")
                let info = ProcessStartInfo(flow.Binary)
                info.UseShellExecute = false
                info.RedirectStandardOutput = true
                info.RedirectStandardError = true
                info.Environment.Clear()
                for entry in flow.Temp.Env {
                    info.Environment[entry.Key] = entry.Value
                }
                info.ArgumentList.Add("reconcile")
                info.ArgumentList.Add("--run")
                info.ArgumentList.Add(run)
                using let process = Process.Start(info) ?? throw Exception("Missing reconciliation process")
                try {
                    let watch = Stopwatch.StartNew()
                    while !File.Exists(entered) && !process.HasExited {
                        Check.That(watch.Elapsed.TotalSeconds < 20, "Reconciliation did not reach the Git merge")
                        select {
                            case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                        }
                    }
                    Check.That(
                        File.Exists(entered) && !process.HasExited,
                        "Reconciliation exited before Git merge interruption"
                    )
                    Check.That(
                        Check.Text(Saved(run)["reconciliation"]?["phase"]) == "merging",
                        "Missing saved merge intent"
                    )
                } finally {
                    if !process.HasExited {
                        try {
                            process.Kill(true)
                        } catch (error InvalidOperationException) { }
                    }
                    process.WaitForExit()
                }
                let physicalIndex = Convert.ToHexString(File.ReadAllBytes(Path.Combine(checkout, ".git/index")))
                let physicalHead = flow.Git("-C", checkout, "rev-parse", "HEAD")
                Check.That(
                    physicalHead == start && !File.Exists(Path.Combine(checkout, ".git/MERGE_HEAD")),
                    "Git merge ran before interruption"
                )
                flow.Call([]string{"reconcile", "--run", run, "--resume"}, 1)
                Check.That(
                    physicalHead == flow.Git("-C", checkout, "rev-parse", "HEAD") &&
                        physicalIndex == Convert.ToHexString(File.ReadAllBytes(Path.Combine(checkout, ".git/index"))) &&
                        !File.Exists(repeated),
                    "Resume repeated interrupted merge or changed index"
                )
                return
            }
            let result = flow.Call(
                []string{"reconcile", "--run", run, "--json"},
                refuse || conflict ? 1: 0,
                owner: mode == "donor"
            )
            flow.Reload()
            Check.That(
                Check.Text(flow.State["exec_count"]) == inference && Check.Text(flow.State["git_pushes"]) == pushes,
                "Reconciliation launched inference or pushed"
            )
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Reconciliation wrote remote authority")
            }
            Check.That(
                File.ReadAllText(Path.Combine(run, "verification.json")) == verification,
                "Reconciliation ran verification"
            )
            Check.That(
                Check.Text(Saved(run)["commit"]) == h && Check.Text(Saved(run)["base"]) == base,
                "Reconciliation replaced published head or approved base"
            )
            Check.That(!File.Exists(Path.Combine(flow.Temp.Root, "executed")), "Repository-selected program executed")
            if refuse {
                Check.That(Saved(run)["reconciliation"] == nil, "Refusal created a merge intent")
                if mode == "dirty" {
                    Check.That(
                        File.ReadAllText(Path.Combine(checkout, "private.txt")) == "uncommitted work\n" &&
                            Convert.ToHexString(index) == Convert.ToHexString(
                            File.ReadAllBytes(Path.Combine(checkout, ".git/index"))
                        ),
                        "Dirty refusal lost work"
                    )
                }
                return
            }
            if conflict {
                let pending = File.ReadAllText(Path.Combine(checkout, ".git/MERGE_HEAD"))
                let unresolved = Convert.ToHexString(File.ReadAllBytes(Path.Combine(checkout, ".git/index")))
                flow.Call([]string{"reconcile", "--run", run}, 1)
                flow.Call([]string{"reconcile", "--run", run, "--resume"}, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(checkout, ".git/MERGE_HEAD")) == pending && Convert.ToHexString(
                        File.ReadAllBytes(Path.Combine(checkout, ".git/index"))
                    ) == unresolved,
                    "Resume discarded conflict state"
                )
                PublishedContribution.Write(checkout, "shared.txt", "explicit resolution\n")
                if mode == "protected" {
                    File.AppendAllText(Path.Combine(checkout, "protected/content"), "unapproved alteration\n")
                }
                Commit(flow, checkout, "Explicit conflict resolution")
                if mode == "protected" {
                    let rejected = flow.Call([]string{"reconcile", "--run", run, "--resume"}, 1)
                    Check.Contains(rejected.Output + rejected.Error, "Synchronization changes protected owner content")
                    return
                }
                flow.Call([]string{"reconcile", "--run", run, "--resume"})
            } else {
                let data = Check.Json(result.Output)["data"]
                Check.That(
                    Check.Text(data?["local"]) == "true" && Check.Text(data?["verified"]) == "false",
                    "Candidate was not local and unverified"
                )
            }
            let candidate = Check.Text(Saved(run)["reconciliation"]?["candidate"])
            flow.Git("-C", checkout, "merge-base", "--is-ancestor", start, candidate)
            flow.Git("-C", checkout, "merge-base", "--is-ancestor", upstream, candidate)
            flow.Call([]string{"reconcile", "--run", run, "--resume"})
            if mode == "moving-target" {
                PublishedContribution.Write(flow.Upstream, "movement.txt", "target changed\n")
                flow.Commit("Move target")
            } else if mode == "moving-head" {
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                let head = pull["head"] ?? throw Exception("Missing PR head")
                head["sha"] = JsonValue.Create(base)
                flow.Save()
            } else if mode == "moving-approval" {
                flow.Reload()
                let issue = flow.State["issue"] ?? throw Exception("Missing issue")
                issue["title"] = JsonValue.Create("Changed task")
                flow.Save()
            }
            if mode.StartsWith("moving-", StringComparison.Ordinal) {
                flow.Call([]string{"reconcile", "--run", run, "--resume"}, 1)
                Check.That(
                    flow.Git("-C", checkout, "rev-parse", "HEAD") == candidate,
                    "Changed authority lost candidate"
                )
                return
            }
            if mode == "edits" {
                Check.That(
                    File.ReadAllText(Path.Combine(checkout, "local.txt")) == "committed donor work\n",
                    "Merge lost committed edits"
                )
            }
            let grant = Grant(flow, candidate, upstream)
            Amend(flow, run, candidate, grant)
            if v2 {
                flow.Reload()
                coordination.Coordinate(coordination.Event(Check.PostedRequest(flow.State)))
                Amend(flow, run, candidate, grant)
            }
            Check.That(Check.Text(Saved(run)["commit"]) == candidate, "Amend did not publish reconciled candidate")
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        }

        internal func All(binary string, only string = "", partition int32 = 0) {
            let selectors = List[string](only.Split(','))
            let matchedSelectors = HashSet[string]()
            var matched bool
            let preparations = Dictionary[string, PublishedContribution]()
            try {
                for version in[]string{"v1", "v2"} {
                    var index int32
                    for mode in[]string{
                        "timeout",
                        "ordinary",
                        "tree-reuse",
                        "conflict",
                        "stale-creation",
                        "donor-grant",
                        "blob",
                        "mode",
                        "type",
                        "addition",
                        "deletion",
                        "rename-from",
                        "rename-to",
                        "absence",
                        "ancestor",
                        "ancestor-file",
                        "ancestor-submodule",
                        "sibling-creation",
                        "sibling-removal",
                        "decree",
                        "decree-after-sync",
                        "decree-coordinator",
                        "selected-target",
                        "authority-policy",
                        "reversion",
                        "semantic",
                        "revoked",
                        "deleted",
                        "donor-ref",
                        "moved-ref",
                        "stale-target",
                        "policy",
                        "template",
                        "substitution",
                        "tree-truncated",
                        "tree-missing",
                        "tree-identity",
                        "tree-ancestor",
                        "local-tree-truncated",
                        "local-tree-malformed",
                        "local-final-ancestry",
                        "unresolved",
                        "after-push",
                        "after-coordinate",
                        "state-mismatch",
                        "reconcile-edits",
                        "reconcile-selected",
                        "reconcile-dirty",
                        "reconcile-fork-divergence",
                        "reconcile-driver",
                        "reconcile-filter",
                        "reconcile-metadata",
                        "reconcile-submodule-filter",
                        "reconcile-unidentified",
                        "reconcile-operation",
                        "reconcile-local-divergence",
                        "reconcile-unpublished",
                        "reconcile-failed",
                        "reconcile-closed",
                        "reconcile-merged",
                        "reconcile-donor",
                        "reconcile-moving-target",
                        "reconcile-moving-head",
                        "reconcile-moving-approval",
                        "reconcile-conflict",
                        "reconcile-interruption",
                        "reconcile-protected"
                    } {
                        index++
                        if (mode == "after-coordinate" || mode == "state-mismatch" || mode == "decree-coordinator") &&
                            version != "v2" {
                            continue
                        }
                        if only != "" && !selectors.Contains(version) && !selectors.Contains(mode) &&
                            !selectors.Contains(version + "/" + mode) {
                            continue
                        }
                        if (partition == 1 && index > 21) || (partition == 2 && index <= 21) {
                            continue
                        }
                        matched = true
                        matchedSelectors.Add(version)
                        matchedSelectors.Add(mode)
                        matchedSelectors.Add(version + "/" + mode)
                        if !CiShard.Include("Synchronization/" + version + "/" + mode) {
                            continue
                        }
                        let target = mode == "selected-target" ||
                            mode == "authority-policy" ||
                            mode == "reconcile-selected" ? "release/review": ""
                        let key = version + "/" + target
                        if !preparations.ContainsKey(key) {
                            preparations[key] = PublishedContribution.Create(
                                binary,
                                version == "v2",
                                synchronization: true,
                                baseBranch: target
                            )
                        }
                        Run(preparations[key], version == "v2", mode)
                        Console.WriteLine("PASS synchronization " + version + "/" + mode)
                    }
                }
                Check.That(matched, "Unknown synchronization selector: " + only)
                for selector in selectors {
                    Check.That(
                        only == "" || matchedSelectors.Contains(selector),
                        "Unknown synchronization selector: " + selector
                    )
                }
            } finally {
                for preparation in preparations.Values {
                    preparation.Dispose()
                }
            }
        }
    }
}
