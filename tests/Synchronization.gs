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
            policy["protected_paths"] = Check.Json("[\"protected/\",\"guard/missing\"]")
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
                // Changing an unprotected sibling changes an ancestor tree SHA.
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
                    upstream
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
            let start = result.Output.IndexOf("Synchronization grant: ")
            Check.That(start >= 0, "Missing grant identity")
            return result.Output.Substring(start + "Synchronization grant: ".Length, 40)
        }

        private func Amend(flow NativeFlow, run string, candidate string, grant string = "", code int32 = 0) Result {
            let args = List[string]{"amend", "--run", run, "--commit", candidate, "--seconds", "30"}
            if grant != "" {
                args.AddRange([]string{"--sync", grant})
            }
            return flow.Call(args.ToArray(), code)
        }

        private func Revoke(flow NativeFlow, grant string) {
            flow.Call([]string{"revoke-sync", "--repo", "owner/project", "--grant", grant}, owner: true)
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
                case "reversion" {
                    Write(checkout, ".github/workflows/verify.yml", "timeout-minutes: 15\n")
                }
                case "semantic" {
                    Write(checkout, "result.txt", "")
                }
            }
            return Commit(flow, checkout, "Exact candidate with " + mode)
        }

        private func Run(binary string, v2 bool, mode string) {
            using let coordination = CoordinationFlow(binary)
            let flow = coordination.Flow
            let run = v2 ? AmendmentFlow.V2Original(coordination, synchronization: true): AmendmentFlow.Original(
                flow,
                synchronization: true
            )
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let h = Check.Text(Saved(run)["commit"])
            let stateBefore = v2 ? Check.Text(coordination.State()["sha"]): ""
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
                mode == "reversion" ||
                mode == "semantic" {
                candidate = Mutate(flow, run, mode)
            }
            let grant = Grant(flow, candidate, upstream)
            if v2 {
                Check.That(Check.Text(coordination.State()["sha"]) == stateBefore, "Grant reset reservation/state S")
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
                mode == "after-coordinate" ||
                mode == "state-mismatch"
            let result = Amend(flow, run, candidate, grant, success ? 0: 1)
            if !success {
                Check.That(
                    Check.Text(Saved(run)["commit"]) == h,
                    "Rejected synchronization rewrote original saved head"
                )
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
            // Later ordinary D retains G/C/U without applying the exact grant to D.
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
            // A new exact grant can synchronize a stale historical U; history remains intact.
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

        internal func All(binary string, only string = "") {
            for version in[]string{"v1", "v2"} {
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
                    if (mode == "after-coordinate" || mode == "state-mismatch") && version != "v2" {
                        continue
                    }
                    if only != "" && only != version && only != mode && only != version + "/" + mode {
                        continue
                    }
                    Run(binary, version == "v2", mode)
                    Console.WriteLine("PASS synchronization " + version + "/" + mode)
                }
            }
        }
    }
}
