package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class ContinuationChecks {
    shared {
        private func Read(directory string) JsonNode -> Check.Json(
            File.ReadAllText(Path.Combine(directory, "run.json"))
        )

        private func Setup(flow NativeFixture, actual bool = false) string {
            flow.Initialize()
            File.WriteAllText(Path.Combine(flow.Upstream, "tracked.txt"), "approved\n")
            File.WriteAllText(Path.Combine(flow.Upstream, "baseline.txt"), "baseline\n")
            Directory.CreateDirectory(Path.Combine(flow.Upstream, "folder"))
            File.WriteAllText(Path.Combine(flow.Upstream, "folder/child.txt"), "baseline\n")
            flow.Commit("Tracked source")
            flow.VerificationPolicy(
                "test -f result.txt && test \"$(cat tracked.txt)\" = preserved && test \"$(cat imported.txt)\" = untracked && test ! -e .verification-data"
            )
            flow.Approve()
            let source = flow.Claim(actual ? "3": "30", reserve: actual ? "1": "10")
            if actual {
                flow.Reload()
                flow.State["continuation_timeout"] = JsonValue.Create(true)
                flow.State["mode"] = JsonValue.Create("timeout")
                flow.Save()
                flow.Call([]string{"work", "--run", source, "--yes"}, 1)
            } else {
                let saved = Read(source)
                saved["state"] = JsonValue.Create("failed")
                saved["failure_stage"] = JsonValue.Create("inference")
                saved["failure_reason"] = JsonValue.Create("inference_interrupted")
                saved["error"] = JsonValue.Create("Preserved interrupted fixture")
                saved["codex_version"] = JsonValue.Create("codex-cli 0.160.0")
                File.WriteAllText(Path.Combine(source, "run.json"), saved.ToJsonString())
                File.WriteAllText(Path.Combine(source, "events.jsonl"), "{\"type\":\"partial")
                File.WriteAllText(Path.Combine(source, "stderr.log"), "interrupted original log")
                File.WriteAllText(Path.Combine(source, "checkout/tracked.txt"), "preserved\n")
                File.WriteAllText(Path.Combine(source, "checkout/imported.txt"), "untracked\n")
            }
            return source
        }

        private func Grant(flow NativeFixture, source string, code int32 = 0) Result -> flow.Call(
            []string{
                "approve",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--donor",
                "donor",
                "--continue-approval",
                Check.Text(Read(source)["approval"])
            },
            code,
            owner: true
        )

        private func Args(flow NativeFixture, source string, command string = "claim", yes bool = false)[]string {
            let args = List[string]{
                command,
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--model",
                "gpt-6.1-sol",
                "--effort",
                "high",
                "--seconds",
                "30",
                "--verification-reserve",
                "10",
                "--runs",
                Path.Combine(flow.Temp.Root, "runs"),
                "--continue-from",
                source,
                "--json"
            }
            if yes {
                args.Add("--yes")
            }
            return args.ToArray()
        }

        private func Import(flow NativeFixture, source string, code int32 = 0) string {
            let result = flow.Call(Args(flow, source), code)
            let envelope = Check.Json(result.Output)
            return Check.Text(envelope["data"]?["run"])
        }

        private func Fresh(flow NativeFixture, source string) string {
            for path in Directory.GetDirectories(Path.Combine(flow.Temp.Root, "runs")) {
                if path != source {
                    return path
                }
            }
            throw Exception("No preserved fresh preparation")
        }

        private func Count(flow NativeFixture, inference int32, runs int32) {
            flow.Reload()
            Check.That(
                Check.Text(flow.State["exec_count"] ?? JsonValue.Create(0)) == inference.ToString(),
                "Unexpected inference attempt"
            )
            Check.That(
                Directory.GetDirectories(Path.Combine(flow.Temp.Root, "runs")).Length == runs,
                "Duplicate reservation preparation"
            )
        }

        private func Flow(binary string) {
            using let flow = NativeFixture(binary)
            let source = Setup(flow, true)
            let old = Read(source)
            let original = File.ReadAllText(Path.Combine(source, "run.json"))
            let events = File.ReadAllText(Path.Combine(source, "events.jsonl"))
            let stderr = File.ReadAllText(Path.Combine(source, "stderr.log"))
            Check.That(Check.Text(old["failure_reason"]) == "inference_interrupted", "Timeout lost failed origin")
            flow.Call([]string{"recover", "--run", source}, 1)
            Grant(flow, source)
            flow.Call(Args(flow, source, "work"), 1)
            Count(flow, 1, 1)
            flow.Mode("")
            Import(flow, source)
            let fresh = Fresh(flow, source)
            let saved = Read(fresh)
            Check.That(
                saved["usage"] == nil && saved["turn_completed"] == nil && saved["verification"] == nil,
                "Import invented completion evidence"
            )
            Check.That(!File.Exists(Path.Combine(fresh, "report.md")), "Import invented a report")
            Check.That(Check.Text(saved["base"]) == Check.Text(old["base"]), "Import advanced approved base")
            Check.That(
                File.ReadAllText(Path.Combine(fresh, "checkout/tracked.txt")) == "preserved\n",
                "Tracked timeout edit lost"
            )
            Check.That(
                File.ReadAllText(Path.Combine(fresh, "checkout/imported.txt")) == "untracked\n",
                "Untracked timeout edit lost"
            )
            Check.That(!Directory.Exists(Path.Combine(fresh, "checkout/.verification-data")), "Generated data imported")
            flow.Call([]string{"prepare", "--run", fresh})
            flow.Call([]string{"prepare", "--run", fresh})
            flow.Call(Args(flow, source), 1)
            Count(flow, 1, 2)
            flow.Call([]string{"work", "--run", fresh}, 1)
            Count(flow, 1, 2)
            flow.Call([]string{"work", "--run", fresh, "--yes"})
            Count(flow, 2, 2)
            Check.That(File.ReadAllText(Path.Combine(source, "run.json")) == original, "Source metadata changed")
            Check.That(File.ReadAllText(Path.Combine(source, "events.jsonl")) == events, "Source events changed")
            Check.That(File.ReadAllText(Path.Combine(source, "stderr.log")) == stderr, "Source log changed")
            Check.That(
                File.ReadAllText(Path.Combine(source, "checkout/tracked.txt")) == "preserved\n",
                "Source tracked work changed"
            )
            Check.That(
                flow.Git("-C", Path.Combine(flow.Bin, "fork"), "rev-parse", Check.Text(old["branch"])) == Check.Text(
                    old["base"]
                ),
                "Prior branch changed"
            )
            let patch = File.ReadAllText(Path.Combine(fresh, "changes.patch"))
            for name in[]string{"tracked.txt", "imported.txt", "result.txt"} {
                Check.Contains(patch, name)
            }
            flow.Reload()
            let body = Check.Text(flow.State["pulls"]?[0]?["body"])
            Check.Contains(body, "unpublished interrupted attempt " + Check.Text(old["id"]))
            Check.Contains(body, "not retroactively successful")
            Check.Contains(body, "\"predecessor\"")
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            let prompt = Check.Text(flow.State["prompts"]?[1])
            Check.Contains(prompt, "untrusted task input")
            Check.Contains(prompt, "complete final diff")
            for mode in[]string{"missing-origin", "changed-origin", "changed-head"} {
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing fixture PR")
                let originalPull = pull.DeepClone()
                if mode == "changed-head" {
                    let head = pull["head"] ?? throw Exception("Missing head")
                    head["sha"] = JsonValue.Create(String('a', 40))
                } else if mode == "changed-origin" {
                    pull["body"] = JsonValue.Create(body.Replace("\"state\":\"failed\"", "\"state\":\"running\""))
                } else {
                    let start = body.IndexOf("<!-- tokate-receipt:") + "<!-- tokate-receipt:".Length
                    let end = body.IndexOf(" -->", start)
                    let receipt = Check.Json(body.Substring(start, end - start))
                    receipt.AsObject().Remove("predecessor")
                    pull["body"] = JsonValue.Create(
                        body.Substring(0, start) + receipt.ToJsonString() + body.Substring(end)
                    )
                }
                flow.Save()
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
                flow.Reload()
                let pulls = flow.State["pulls"] ?? throw Exception("Missing pulls")
                pulls[0] = originalPull
                flow.Save()
            }
        }

        private func NumericApproval(flow NativeFixture, prior string, donorId int64, repoId int64) string {
            flow.Git("-C", flow.Upstream, "checkout", "--quiet", "--detach", prior)
            let path = Path.Combine(flow.Upstream, ".github/tokate-approval.json")
            let approval = Check.Json(File.ReadAllText(path))
            approval["donor_id"] = JsonValue.Create(donorId)
            approval["repo_id"] = JsonValue.Create(repoId)
            File.WriteAllText(path, approval.ToJsonString())
            flow.Commit("Numeric predecessor fixture")
            let sha = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
            flow.Git("-C", flow.Upstream, "update-ref", "refs/heads/tokate/approvals/1", sha, prior)
            flow.Git("-C", flow.Upstream, "checkout", "--quiet", "main")
            return sha
        }

        private func Amendment(binary string) {
            using let flow = NativeFixture(binary)
            let source = Setup(flow)
            let old = Read(source)
            let sourceEvidence = Dictionary[string, string]()
            for file in[]string{
                "run.json",
                "events.jsonl",
                "stderr.log",
                "checkout/tracked.txt",
                "checkout/imported.txt"
            } {
                sourceEvidence[file] = File.ReadAllText(Path.Combine(source, file))
            }
            Grant(flow, source)
            Import(flow, source)
            let fresh = Fresh(flow, source)
            flow.Mode("staged_whitespace")
            Check.Contains(flow.Call([]string{"work", "--run", fresh, "--yes"}, 1).Error, "trailing whitespace")
            let saved = Read(fresh)
            let prior = saved["continuation"]?.DeepClone() ?? throw Exception("Missing fixture predecessor")
            let manifest = Check.Text(saved["continuation_manifest_sha256"])
            let originalEvidence = Dictionary[string, string]()
            for file in[]string{"run.json", "events.jsonl", "stderr.log", "report.md"} {
                originalEvidence[file] = File.ReadAllText(Path.Combine(fresh, file))
            }
            flow.NoPr()
            flow.Call([]string{"recover", "--run", fresh, "--prepare"})
            let originalHead = CorrectionChecks.Correct(flow, fresh)
            CorrectionChecks.Recover(flow, fresh, originalHead)
            Count(flow, 1, 2)
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            Check.That(JsonNode.DeepEquals(Read(fresh)["usage"], saved["usage"]), "Correction changed original usage")
            flow.Reload()
            let initialBody = Check.Text(flow.State["pulls"]?[0]?["body"])
            let start = initialBody.IndexOf("Fresh v1 attempt seeded from unpublished interrupted attempt ")
            Check.That(start >= 0, "Initial contribution lost interrupted origin")
            let end = initialBody.IndexOf("\n<!-- tokate-report:end -->", start)
            Check.That(end > start, "Initial origin report is incomplete")
            let origin = initialBody.Substring(start, end - start)
            Check.That(start == initialBody.LastIndexOf(origin), "Correction duplicated interrupted origin")
            Check.Contains(initialBody, "original declarations cover only the original completed turn")
            Check.Contains(initialBody, "| manual/unknown | unknown | unknown | unknown |")
            Check.Contains(origin, "unpublished interrupted attempt " + Check.Text(old["id"]))
            Check.Contains(origin, "predecessor approval " + Check.Text(old["approval"]))
            Check.Contains(origin, "Preserved origin state: failed; failure: inference_interrupted")
            Check.Contains(
                origin,
                "not retroactively successful. Missing prior usage, reports and verification are not reconstructed"
            )
            var previous = originalHead
            for attempt in 0 ... 2 {
                let checkout = Path.Combine(fresh, "checkout")
                File.WriteAllText(Path.Combine(checkout, "result.txt"), "Review amendment " + attempt.ToString() + "\n")
                flow.Git("-C", checkout, "add", "result.txt")
                flow.DonorGit(checkout, "commit", "-m", "Review seeded contribution")
                let commit = flow.Git("-C", checkout, "rev-parse", "HEAD")
                let args = []string{"amend", "--run", fresh, "--commit", commit, "--seconds", "30"}
                if attempt == 1 {
                    flow.Mode("lost_body_response")
                    flow.Call(args, 1)
                    Check.That(
                        File.Exists(Path.Combine(fresh, "amendments", commit, "publication.json")),
                        "Interrupted seeded amendment lost publication intent"
                    )
                    flow.Mode("")
                    flow.Reload()
                    let pushes = Check.Text(flow.State["git_pushes"])
                    flow.ResetTraffic()
                    flow.Call(args)
                    flow.Reload()
                    Check.That(Check.Text(flow.State["git_pushes"]) == pushes, "Seeded amendment retry repeated push")
                    for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                        Check.That(Check.Text(call["method"]) == "GET", "Seeded amendment retry repeated body write")
                    }
                } else {
                    flow.Call(args)
                }
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                flow.Reload()
                let body = Check.Text(flow.State["pulls"]?[0]?["body"])
                Check.Contains(body, origin)
                Check.That(body.IndexOf(origin) == body.LastIndexOf(origin), "Amendment duplicated interrupted origin")
                Check.Contains(body, "Review amendment: " + previous + " → " + commit)
                let receiptStart = body.IndexOf("<!-- tokate-receipt:") + "<!-- tokate-receipt:".Length
                let receiptEnd = body.IndexOf(" -->", receiptStart)
                let receipt = Check.Json(body.Substring(receiptStart, receiptEnd - receiptStart))
                Check.That(JsonNode.DeepEquals(receipt["predecessor"], prior), "Amendment changed predecessor receipt")
                Check.That(Check.Text(receipt["import_manifest_sha256"]) == manifest, "Amendment changed import hash")
                Check.That(Check.Text(receipt["head"]) == commit, "Amendment receipt lost current head")
                Check.That(Check.Text(receipt["original_head"]) == originalHead, "Amendment changed original head")
                previous = commit
                Count(flow, 1, 2)
            }
            flow.Reload()
            let body = Check.Text(flow.State["pulls"]?[0]?["body"])
            let receiptRegion = body.Substring(body.IndexOf("<!-- tokate-receipt:"))
            for replacement in[]string{"", origin.Replace("not retroactively successful", "retroactively successful")} {
                let changed = body.Replace(origin, replacement)
                Check.That(changed != body, "Origin tamper fixture did not change report")
                Check.That(
                    changed.Substring(changed.IndexOf("<!-- tokate-receipt:")) == receiptRegion,
                    "Origin tamper fixture changed receipt"
                )
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing fixture PR")
                pull["body"] = JsonValue.Create(changed)
                flow.Save()
                let refused = flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
                Check.Contains(refused.Output + refused.Error, "PR report omitted interrupted-origin provenance")
                flow.Reload()
                let restored = flow.State["pulls"]?[0] ?? throw Exception("Missing fixture PR")
                restored["body"] = JsonValue.Create(body)
                flow.Save()
            }
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            for file in sourceEvidence.Keys {
                Check.That(
                    File.ReadAllText(Path.Combine(source, file)) == sourceEvidence[file],
                    "Source evidence changed: " + file
                )
            }
            for file in originalEvidence.Keys {
                Check.That(
                    File.ReadAllText(Path.Combine(fresh, "original-evidence", file)) == originalEvidence[file],
                    "Original completed-attempt evidence changed: " + file
                )
            }
            Check.That(
                flow.Git("-C", Path.Combine(flow.Bin, "fork"), "rev-parse", Check.Text(old["branch"])) == Check.Text(
                    old["base"]
                ),
                "Amendment changed interrupted source branch"
            )
            Count(flow, 1, 2)
            let repair = RepairCase.Create(flow, fresh)
            repair.Call()
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            flow.Reload()
            let repaired = Check.Text(flow.State["pulls"]?[0]?["body"])
            Check.Contains(repaired, origin)
            Check.Contains(repaired, "original private state was unavailable")
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Repair restarted coding inference")
        }

        private func Owner(binary string) {
            for mode in[]string{
                "advanced",
                "revoked",
                "scope",
                "policy",
                "template",
                "decree",
                "wrong-sha",
                "retarget",
                "numeric-donor",
                "numeric-repo",
                "numeric-valid"
            } {
                using let flow = NativeFixture(binary)
                let source = Setup(flow)
                var prior = Check.Text(Read(source)["approval"])
                let oldBase = Check.Text(Read(source)["base"])
                if mode.StartsWith("numeric-", StringComparison.Ordinal) {
                    prior = NumericApproval(
                        flow,
                        prior,
                        mode == "numeric-donor" ? 999: 123,
                        mode == "numeric-repo" ? 99: 1
                    )
                } else if mode == "advanced" || mode == "decree" {
                    File.WriteAllText(Path.Combine(flow.Upstream, mode == "decree" ? "DECREE.md": "later.txt"), "new\n")
                    flow.Commit("Target advanced")
                } else if mode == "revoked" {
                    flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                } else if mode == "scope" {
                    flow.Reload()
                    let issue = flow.State["issue"] ?? throw Exception("Missing issue")
                    issue["body"] = JsonValue.Create("Changed task")
                    flow.Save()
                } else if mode == "policy" || mode == "template" {
                    if mode == "policy" {
                        let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                        let policy = Check.Json(File.ReadAllText(path))
                        policy["max_seconds"] = JsonValue.Create(3599)
                        File.WriteAllText(path, policy.ToJsonString())
                    } else {
                        File.AppendAllText(Path.Combine(flow.Upstream, ".github/tokate-pr.md"), "\nChanged template")
                    }
                    flow.Commit("Owner configuration changed")
                }
                let code = mode == "advanced" || mode == "numeric-valid" ? 0: 1
                let args = List[string]{
                    "approve",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--donor",
                    "donor",
                    "--continue-approval",
                    mode == "wrong-sha" ? String('a', 40): prior
                }
                if mode == "retarget" {
                    args.AddRange([]string{"--base-branch", "main"})
                }
                let result = flow.Call(args.ToArray(), code, owner: true)
                if mode == "numeric-donor" || mode == "numeric-repo" {
                    Check.Contains(
                        result.Error,
                        "Continuation changed predecessor binding: " + (mode == "numeric-donor" ? "donor_id": "repo_id")
                    )
                    Check.That(
                        flow.Git("-C", flow.Upstream, "rev-parse", "refs/heads/tokate/approvals/1") == prior,
                        "Numeric mismatch replaced predecessor authority"
                    )
                } else if mode == "numeric-valid" {
                    let sha = flow.Git("-C", flow.Upstream, "rev-parse", "refs/heads/tokate/approvals/1")
                    let approval = Check.Json(
                        flow.Git("-C", flow.Upstream, "show", sha + ":.github/tokate-approval.json")
                    )
                    let previous = Check.Json(
                        flow.Git("-C", flow.Upstream, "show", prior + ":.github/tokate-approval.json")
                    )
                    Check.That(
                        Check.Text(approval["donor_id"]) == "123" && Check.Text(approval["repo_id"]) == "1",
                        "Continuation replaced numeric predecessor identities"
                    )
                    Check.That(
                        sha != prior && Check.Text(approval["nonce"]) != Check.Text(previous["nonce"]) && Check.Text(
                            approval["predecessor_approval"]
                        ) == prior &&
                            Check.Text(approval["base"]) == oldBase,
                        "Numeric predecessor did not receive a fresh grant at its approved base"
                    )
                }
                if mode == "advanced" {
                    Import(flow, source)
                    let saved = Read(Fresh(flow, source))
                    Check.That(Check.Text(saved["base"]) == oldBase, "Continuation silently approved advanced HEAD")
                    let sha = Check.Text(saved["approval"])
                    let approval = Check.Json(
                        flow.Git("-C", flow.Upstream, "show", sha + ":.github/tokate-approval.json")
                    )
                    Check.That(Check.Text(approval["predecessor_approval"]) == prior, "Missing predecessor grant")
                    Check.That(
                        Check.Text(approval["base"]) == oldBase && sha != prior,
                        "Grant did not preserve original base with fresh nonce"
                    )
                }
                flow.NoInference()
            }
        }

        private func Refusals(binary string) {
            for mode in[]string{
                "ordinary-grant",
                "wrong-donor",
                "foreign-repo",
                "foreign-issue",
                "published",
                "completed",
                "v2",
                "lease",
                "protected",
                "decree",
                "symlink",
                "hardlink",
                "unchanged-hardlink",
                "fifo",
                "tracked-fifo",
                "directory-file",
                "file-directory",
                "source-repo-id",
                "source-head-id",
                "missing-source-id",
                "unsafe-path",
                "ambiguous-index",
                "restored-worktree",
                "missing-staged-addition",
                "changed-head",
                "hooks",
                "revoked"
            } {
                using let flow = NativeFixture(binary)
                let source = Setup(flow)
                Grant(flow, source)
                let checkout = Path.Combine(source, "checkout")
                let saved = Read(source)
                if mode == "ordinary-grant" {
                    flow.Approve()
                } else if mode == "wrong-donor" {
                    flow.Reload()
                    flow.State["viewer_id"] = JsonValue.Create(999)
                    flow.Save()
                } else if mode == "foreign-repo" ||
                    mode == "foreign-issue" ||
                    mode == "published" ||
                    mode == "completed" ||
                    mode == "v2" {
                    if mode == "foreign-repo" {
                        saved["repo"] = JsonValue.Create("other/project")
                    } else if mode == "foreign-issue" {
                        saved["issue"] = JsonValue.Create(2)
                    } else if mode == "published" {
                        saved["pr"] = JsonValue.Create(10)
                    } else if mode == "completed" {
                        saved["turn_completed"] = JsonValue.Create(true)
                    } else {
                        saved["version"] = JsonValue.Create(2)
                    }
                    File.WriteAllText(Path.Combine(source, "run.json"), saved.ToJsonString())
                } else if mode == "protected" {
                    File.AppendAllText(Path.Combine(checkout, ".github/tokate.json"), "\n ")
                } else if mode == "decree" {
                    File.WriteAllText(Path.Combine(checkout, "DECREE.md"), "donor instructions")
                } else if mode == "symlink" {
                    File.CreateSymbolicLink(Path.Combine(checkout, "escape"), Path.Combine(flow.Temp.Root, "home"))
                } else if mode == "hardlink" {
                    let path = Path.Combine(flow.Temp.Root, "secret")
                    File.WriteAllText(path, "secret")
                    Check.Success(
                        TestProcess.Run("/usr/bin/ln", []string{path, Path.Combine(checkout, "escape")}, flow.Temp.Env)
                    )
                } else if mode == "unchanged-hardlink" {
                    let path = Path.Combine(flow.Temp.Root, "linked-peer")
                    File.WriteAllText(path, "baseline\n")
                    File.Delete(Path.Combine(checkout, "baseline.txt"))
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/ln",
                            []string{path, Path.Combine(checkout, "baseline.txt")},
                            flow.Temp.Env
                        )
                    )
                } else if mode == "fifo" || mode == "tracked-fifo" {
                    let path = Path.Combine(checkout, mode == "fifo" ? "escape": "tracked.txt")
                    if mode == "tracked-fifo" {
                        File.Delete(path)
                    }
                    Check.Success(TestProcess.Run("/usr/bin/mkfifo", []string{path}, flow.Temp.Env))
                } else if mode == "directory-file" {
                    Directory.Delete(Path.Combine(checkout, "folder"), true)
                    File.WriteAllText(Path.Combine(checkout, "folder"), "replacement\n")
                } else if mode == "file-directory" {
                    File.Delete(Path.Combine(checkout, "baseline.txt"))
                    Directory.CreateDirectory(Path.Combine(checkout, "baseline.txt"))
                    File.WriteAllText(Path.Combine(checkout, "baseline.txt/child"), "replacement\n")
                } else if mode == "source-repo-id" || mode == "source-head-id" || mode == "missing-source-id" {
                    let markerPath = Path.Combine(checkout, ".git/tokate-preparation.json")
                    let marker = Check.Json(File.ReadAllText(markerPath))
                    if mode == "missing-source-id" {
                        saved.AsObject().Remove("preparation_repo_id")
                        marker.AsObject().Remove("repo_id")
                    } else {
                        saved[
                            mode == "source-repo-id" ? "preparation_repo_id": "preparation_head_id"
                        ] = JsonValue.Create(99)
                        marker[mode == "source-repo-id" ? "repo_id": "head_id"] = JsonValue.Create(99)
                    }
                    File.WriteAllText(Path.Combine(source, "run.json"), saved.ToJsonString())
                    File.WriteAllText(markerPath, marker.ToJsonString())
                } else if mode == "unsafe-path" {
                    File.WriteAllText(Path.Combine(checkout, "unsafe\nname"), "unsafe")
                } else if mode == "ambiguous-index" {
                    flow.Git("-C", checkout, "add", "tracked.txt")
                    File.WriteAllText(Path.Combine(checkout, "tracked.txt"), "different\n")
                } else if mode == "restored-worktree" {
                    flow.Git("-C", checkout, "add", "tracked.txt")
                    File.WriteAllText(Path.Combine(checkout, "tracked.txt"), "approved\n")
                } else if mode == "missing-staged-addition" {
                    flow.Git("-C", checkout, "add", "imported.txt")
                    File.Delete(Path.Combine(checkout, "imported.txt"))
                } else if mode == "changed-head" {
                    flow.Git("-C", checkout, "checkout", "--quiet", "-b", "unrelated")
                } else if mode == "hooks" {
                    Directory.CreateDirectory(Path.Combine(checkout, ".git/hooks"))
                    File.WriteAllText(Path.Combine(checkout, ".git/hooks/pre-commit"), "untrusted")
                } else if mode == "revoked" {
                    flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                }
                let original = File.ReadAllText(Path.Combine(source, "run.json"))
                if mode == "lease" {
                    using let lease = File.Open(
                        Path.Combine(source, ".lock"),
                        FileMode.Open,
                        FileAccess.ReadWrite,
                        FileShare.None
                    )
                    Import(flow, source, 1)
                } else {
                    Import(flow, source, 1)
                }
                Check.That(File.ReadAllText(Path.Combine(source, "run.json")) == original, "Refusal rewrote source")
                flow.NoInference()
                flow.NoPr()
                Check.That(
                    Directory.GetDirectories(Path.Combine(flow.Temp.Root, "runs")).Length <= 2,
                    "Refusal duplicated preparation"
                )
            }
        }

        private func Interruptions(binary string) {
            for mode in[]string{
                "capture",
                "init",
                "fetch",
                "checkout",
                "imported",
                "partial",
                "dirty",
                "manifest",
                "target-head"
                ,
                "target-hardlink",
                "write",
                "capture-hardlink"
            } {
                using let flow = NativeFixture(binary)
                let source = Setup(flow)
                Directory.CreateSymbolicLink(
                    Path.Combine(source, "checkout/.verification-data"),
                    Path.Combine(flow.Temp.Root, "home")
                )
                Grant(flow, source)
                if mode == "init" || mode == "fetch" || mode == "checkout" {
                    flow.Reload()
                    flow.State["preparation_interrupt"] = JsonValue.Create(mode)
                    flow.Save()
                    Import(flow, source, 1)
                } else {
                    Import(flow, source)
                }
                let fresh = Fresh(flow, source)
                let saved = Read(fresh)
                if mode == "capture" || mode == "capture-hardlink" {
                    saved.AsObject().Remove("continuation_phase")
                    saved.AsObject().Remove("continuation_manifest_sha256")
                    flow.Git("-C", Path.Combine(fresh, "checkout"), "restore", "tracked.txt")
                    File.Delete(Path.Combine(fresh, "checkout/imported.txt"))
                    File.Delete(Path.Combine(fresh, "checkout/partial.txt"))
                    File.WriteAllText(Path.Combine(fresh, "run.json"), saved.ToJsonString())
                    if mode == "capture-hardlink" {
                        File.Delete(Path.Combine(fresh, "continuation.json"))
                        let peer = Path.Combine(flow.Temp.Root, "capture-peer")
                        File.WriteAllText(peer, "preserve synthetic peer")
                        Check.Success(
                            TestProcess.Run(
                                "/usr/bin/ln",
                                []string{peer, Path.Combine(fresh, "continuation.json.tmp")},
                                flow.Temp.Env
                            )
                        )
                    }
                } else if mode == "write" {
                    saved["state"] = JsonValue.Create("preparing")
                    saved["continuation_phase"] = JsonValue.Create("importing")
                    saved["continuation_pending"] = JsonValue.Create("tracked.txt")
                    flow.Git("-C", Path.Combine(fresh, "checkout"), "restore", "tracked.txt")
                    File.WriteAllText(Path.Combine(fresh, "continuation-write.tmp"), "preser")
                    File.WriteAllText(Path.Combine(fresh, "run.json"), saved.ToJsonString())
                } else if mode == "imported" || mode == "partial" {
                    saved["state"] = JsonValue.Create("preparing")
                    saved["continuation_phase"] = JsonValue.Create("importing")
                    if mode == "partial" {
                        File.Delete(Path.Combine(fresh, "checkout/imported.txt"))
                    }
                    File.WriteAllText(Path.Combine(fresh, "run.json"), saved.ToJsonString())
                } else if mode == "dirty" {
                    File.WriteAllText(Path.Combine(fresh, "checkout/unrelated.txt"), "keep")
                } else if mode == "manifest" {
                    File.AppendAllText(Path.Combine(fresh, "continuation.json"), " ")
                } else if mode == "target-head" {
                    flow.Git("-C", Path.Combine(fresh, "checkout"), "checkout", "--quiet", "-b", "unrelated")
                } else if mode == "target-hardlink" {
                    saved["state"] = JsonValue.Create("preparing")
                    saved["continuation_phase"] = JsonValue.Create("importing")
                    let path = Path.Combine(flow.Temp.Root, "linked-peer")
                    File.WriteAllText(path, "approved\n")
                    File.Delete(Path.Combine(fresh, "checkout/tracked.txt"))
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/ln",
                            []string{path, Path.Combine(fresh, "checkout/tracked.txt")},
                            flow.Temp.Env
                        )
                    )
                    File.WriteAllText(Path.Combine(fresh, "run.json"), saved.ToJsonString())
                }
                let reject = mode == "dirty" ||
                    mode == "manifest" ||
                    mode == "target-head" ||
                    mode == "target-hardlink" ||
                    mode == "capture-hardlink"
                flow.Call([]string{"prepare", "--run", fresh}, reject ? 1: 0)
                flow.Call(Args(flow, source), 1)
                if reject {
                    flow.Call([]string{"work", "--run", fresh, "--yes"}, 1)
                }
                Count(flow, 0, 2)
                if mode == "target-hardlink" {
                    Check.That(
                        File.ReadAllText(Path.Combine(flow.Temp.Root, "linked-peer")) == "approved\n",
                        "Import wrote through the synthetic hardlink"
                    )
                }
                if mode == "write" {
                    Check.That(
                        !File.Exists(Path.Combine(fresh, "continuation-write.tmp")),
                        "Import left unfinished temporary content"
                    )
                    Check.That(
                        File.ReadAllText(Path.Combine(fresh, "checkout/tracked.txt")) == "preserved\n",
                        "Import did not finish the captured tracked-file replacement"
                    )
                }
                if mode == "capture-hardlink" {
                    Check.That(
                        File.ReadAllText(Path.Combine(flow.Temp.Root, "capture-peer")) == "preserve synthetic peer",
                        "Capture wrote through the synthetic hardlink"
                    )
                }
                Check.That(Check.Text(Read(source)["state"]) == "failed", "Preparation reinterpreted failed source")
                Check.That(
                    File.ReadAllText(Path.Combine(source, "checkout/imported.txt")) == "untracked\n",
                    "Preparation lost source work"
                )
            }
        }

        private func Cache(binary string) {
            for tracked in[]bool{false, true} {
                using let flow = NativeFixture(binary)
                let source = Setup(flow)
                Grant(flow, source)
                let checkout = Path.Combine(source, "checkout")
                let folder = Path.Combine(checkout, ".verification-data")
                Directory.CreateDirectory(folder)
                let cache = Path.Combine(folder, "private")
                File.WriteAllText(cache, "source-only output")
                if tracked {
                    flow.Git("-C", checkout, "add", ".verification-data/private")
                } else {
                    File.WriteAllText(Path.Combine(checkout, ".ENV"), "synthetic-secret")
                    File.WriteAllText(Path.Combine(checkout, ".npmrc"), "synthetic-token")
                }
                File.Delete(cache)
                Check.Success(TestProcess.Run("/usr/bin/mkfifo", []string{cache}, flow.Temp.Env))
                Import(flow, source, tracked ? 1: 0)
                if !tracked {
                    Check.That(
                        !Directory.Exists(Path.Combine(Fresh(flow, source), "checkout/.verification-data")),
                        "Untracked generated workspace was imported"
                    )
                    Check.That(
                        !File.Exists(Path.Combine(Fresh(flow, source), "checkout/.ENV")) && !File.Exists(
                            Path.Combine(Fresh(flow, source), "checkout/.npmrc")
                        ),
                        "Source credential files were imported"
                    )
                }
                Check.That(File.Exists(cache), "Source generated evidence was removed")
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func Budget(binary string) {
            using let flow = NativeFixture(binary)
            let source = Setup(flow)
            Grant(flow, source)
            flow.Call(flow.ClaimArgs(), 1)
            for mode in[]string{"seconds", "verification-reserve", "zero", "equal", "conflict"} {
                let args = List[string](Args(flow, source, "work", true))
                if mode == "seconds" || mode == "verification-reserve" {
                    args.RemoveRange(args.IndexOf("--" + mode), 2)
                } else if mode == "conflict" {
                    args.AddRange([]string{"--run", source})
                } else {
                    args[args.IndexOf("--verification-reserve") + 1] = mode == "zero" ? "0": "30"
                }
                flow.Call(args.ToArray(), 1)
                Count(flow, 0, 1)
            }
            flow.NoPr()
        }

        internal func All(binary string, selected string = "") {
            for name in[]string{"Flow", "Owner", "Refusals", "Interruptions", "Cache", "Amendment", "Budget"} {
                if selected != "" && name != selected {
                    continue
                }
                if selected == "" && !CiShard.Include("Continuation/" + name) {
                    continue
                }
                switch name {
                    case "Flow" {
                        Flow(binary)
                    }
                    case "Owner" {
                        Owner(binary)
                    }
                    case "Refusals" {
                        Refusals(binary)
                    }
                    case "Interruptions" {
                        Interruptions(binary)
                    }
                    case "Cache" {
                        Cache(binary)
                    }
                    case "Amendment" {
                        Amendment(binary)
                    }
                    case "Budget" {
                        Budget(binary)
                    }
                }
                Console.WriteLine("PASS v1 continuation " + name)
            }
        }
    }
}
