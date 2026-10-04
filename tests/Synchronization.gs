package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class SynchronizationChecks {
    shared {
        internal func SetupOwner(flow NativeFlow) {
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["protected_paths"] = Check.Json("[\"protected/\",\"guard/missing\",\"new-parent/missing\"]")
            policy["verification"] = Check.Json(
                "[[\"/bin/sh\",\"-c\",\"test -f result.txt\"],[\"/bin/sh\",\"-c\",\"test -s result.txt && ! grep -q BAD result.txt\"]]"
            )
            File.WriteAllText(policyPath, policy.ToJsonString())
            Write(flow.Upstream, ".github/workflows/verify.yml", "timeout-minutes: 15\n")
            Write(flow.Upstream, ".github/workflows/old.yml", "old workflow\n")
            Write(flow.Upstream, "protected/content", "owner data\n")
            Write(flow.Upstream, "protected/gone", "remove upstream\n")
            Write(flow.Upstream, "protected/link", "regular upstream\n")
            Write(flow.Upstream, "guard/other", "nonprotected sibling\n")
            Write(flow.Upstream, "DECREE.md", "Approved owner instructions\n")
            Write(flow.Upstream, "shared.txt", "original shared line\n")
            flow.Commit("Approved protected fixtures")
        }

        private func Write(root string, path string, text string) {
            let file = Path.Combine(root, path)
            Directory.CreateDirectory(Path.GetDirectoryName(file) ?? root)
            File.WriteAllText(file, text)
        }

        private func Saved(run string) JsonNode -> Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))

        private func Commit(flow NativeFlow, checkout string, message string) string {
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

        private func Upstream(flow NativeFlow, ordinary bool = false, conflict bool = false) string {
            if ordinary {
                Write(flow.Upstream, "upstream.txt", "ordinary upstream change\n")
            } else {
                Write(flow.Upstream, ".github/workflows/verify.yml", "timeout-minutes: 30\n")
                flow.Git("-C", flow.Upstream, "mv", ".github/workflows/old.yml", ".github/workflows/renamed.yml")
                File.Delete(Path.Combine(flow.Upstream, "protected/gone"))
                File.SetUnixFileMode(
                    Path.Combine(flow.Upstream, "protected/content"),
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                )
                File.Delete(Path.Combine(flow.Upstream, "protected/link"))
                File.CreateSymbolicLink(Path.Combine(flow.Upstream, "protected/link"), "content")
                Write(flow.Upstream, "protected/new", "owner addition\n")
                Write(flow.Upstream, "guard/other", "owner sibling change\n")
            }
            if conflict {
                Write(flow.Upstream, "shared.txt", "owner shared resolution input\n")
            }
            flow.Commit("Owner trusted target")
            return flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
        }

        private func Candidate(flow NativeFlow, run string, upstream string, conflict bool = false) string {
            let checkout = Path.Combine(run, "checkout")
            if conflict {
                Write(checkout, "shared.txt", "donor conflicting line\n")
                Commit(flow, checkout, "Donor conflict input")
            }
            flow.Git("-C", checkout, "fetch", flow.Upstream, upstream)
            let env = Dictionary[string, string](flow.Temp.Env)
            for key in[]string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"} {
                env.Remove(key)
            }
            let merged = Check.Run(
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
                Write(checkout, "shared.txt", "Explicit owner-reviewed nonprotected resolution\n")
                return Commit(flow, checkout, "Owner-reviewed conflict resolution")
            }
            Check.Success(merged)
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        private func Grant(
            flow NativeFlow,
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

        private func Amend(flow NativeFlow, run string, candidate string, grant string = "", code int32 = 0) Result {
            let args = List[string]{"amend", "--run", run, "--commit", candidate, "--seconds", "30"}
            if grant != "" {
                args.AddRange([]string{"--sync", grant})
            }
            return flow.Call(args.ToArray(), code)
        }

        private func Revoke(flow NativeFlow, grant string) {
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

        private func Mutate(flow NativeFlow, run string, mode string) string {
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
                    Write(checkout, ".github/workflows/donor.yml", "donor workflow\n")
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
                    Write(checkout, "guard/missing", "donor addition at previously absent path\n")
                }
                case "ancestor" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                    File.CreateSymbolicLink(Path.Combine(checkout, "guard"), "protected")
                }
                case "ancestor-file" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                    Write(checkout, "guard", "donor ancestor file\n")
                }
                case "ancestor-submodule" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                    flow.Git("-C", checkout, "rm", "--cached", "-r", "guard")
                    flow.Git("clone", flow.Upstream, Path.Combine(checkout, "guard"))
                }
                case "sibling-creation" {
                    Write(checkout, "new-parent/public", "unrelated sibling\n")
                }
                case "sibling-removal" {
                    Directory.Delete(Path.Combine(checkout, "guard"), true)
                }
                case "decree", "decree-coordinator" {
                    Write(checkout, "DECREE.md", "Unapproved donor instructions\n")
                }
                case "reversion" {
                    Write(checkout, ".github/workflows/verify.yml", "timeout-minutes: 15\n")
                }
                case "semantic" {
                    Write(checkout, "result.txt", "")
                }
            }
            return Commit(flow, checkout, "Exact candidate with " + mode)
        }

        private func Run(preparation PublishedContribution, v2 bool, mode string) {
            preparation.Restore()
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
            if mode == "blob" ||
                mode == "mode" ||
                mode == "type" ||
                mode == "addition" ||
                mode == "deletion" ||
                mode == "rename-from" ||
                mode == "rename-to" ||
                mode == "absence" ||
                mode == "ancestor" ||
                mode == "ancestor-file" ||
                mode == "ancestor-submodule" ||
                mode == "sibling-creation" ||
                mode == "sibling-removal" ||
                mode == "decree" ||
                mode == "decree-coordinator" ||
                mode == "reversion" ||
                mode == "semantic" {
                candidate = Mutate(flow, run, mode)
            }
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
                Write(flow.Upstream, "movement.txt", "target advanced\n")
                flow.Commit("Target moved after grant")
            } else if mode == "policy" || mode == "template" {
                File.AppendAllText(
                    Path.Combine(flow.Upstream, mode == "policy" ? ".github/tokate.json": ".github/tokate-pr.md"),
                    "\n "
                )
                flow.Commit("Owner scope changed")
            } else if mode == "substitution" {
                Write(Path.Combine(run, "checkout"), "another.txt", "different candidate\n")
                candidate = Commit(flow, Path.Combine(run, "checkout"), "Candidate substitution")
            } else if mode.StartsWith("tree-") {
                flow.Reload()
                flow.State["tree_fault"] = JsonValue.Create(mode.Substring(5))
                flow.Save()
            } else if mode == "after-push" {
                flow.Mode("revoke_sync_after_push")
            }
            let success = mode == "timeout" ||
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
            let result = Amend(flow, run, candidate, grant, success ? 0: 1)
            if !success {
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
                let request = Check.Json(Check.Text(flow.State["posted_request"]?["body"]).Substring(8))
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
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
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
                Write(Path.Combine(run, "checkout"), "DECREE.md", "Unapproved later instructions\n")
                let next = Commit(flow, Path.Combine(run, "checkout"), "Ordinary amendment changes DECREE")
                let rejected = Amend(flow, run, next, code: 1)
                Check.Contains(
                    rejected.Output + rejected.Error,
                    "Synchronization changes protected owner content: \"DECREE.md\""
                )
                return
            }
            Write(Path.Combine(run, "checkout"), "followup.txt", "ordinary review correction\n")
            let next = Commit(flow, Path.Combine(run, "checkout"), "Ordinary amendment after synchronization")
            Amend(flow, run, next)
            if v2 {
                flow.Reload()
                let request = Check.Json(Check.Text(flow.State["posted_request"]?["body"]).Substring(8))
                coordination.Coordinate(coordination.Event(request))
                Amend(flow, run, next)
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
            Write(flow.Upstream, "later-target.txt", "acceptance must recheck target\n")
            flow.Commit("Target moved before final acceptance")
            flow.Call([]string{"checks", "--run", run}, 1, owner: true)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            let newUpstream = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
            let newCandidate = Candidate(flow, run, newUpstream)
            let newGrant = Grant(flow, newCandidate, newUpstream)
            Amend(flow, run, newCandidate, newGrant)
            if v2 {
                flow.Reload()
                let request = Check.Json(Check.Text(flow.State["posted_request"]?["body"]).Substring(8))
                coordination.Coordinate(coordination.Event(request))
                Amend(flow, run, newCandidate, newGrant)
            }
            Check.That(Saved(run)["synchronizations"]?.AsArray().Count == 2, "New grant discarded history")
            Revoke(flow, grant)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            if v2 {
                flow.NoInference()
            }
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
                        "unresolved",
                        "after-push",
                        "after-coordinate",
                        "state-mismatch"
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
                        let target = mode == "selected-target" || mode == "authority-policy" ? "release/review": ""
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
                        matched = true
                        matchedSelectors.Add(version)
                        matchedSelectors.Add(mode)
                        matchedSelectors.Add(version + "/" + mode)
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
