package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class PreparationChecks {
    shared {
        private func RunPath(flow NativeFixture) string {
            let directories = Directory.GetDirectories(Path.Combine(flow.Temp.Root, "runs"))
            Check.That(directories.Length == 1, "Preparation did not retain exactly one saved run")
            return directories[0]
        }

        private func Resume(flow NativeFixture, run string, code int32 = 0) Result -> flow.Call(
            []string{"prepare", "--run", run},
            code
        )

        private func Creation(binary string) {
            for mode in[]string{"", "lost_fork_response", "lost_branch_response", "pending"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                Directory.Delete(Path.Combine(flow.Bin, "fork"), true)
                flow.Reload()
                flow.State["missing_fork"] = JsonValue.Create(true)
                flow.State["mode"] = JsonValue.Create(mode)
                if mode == "pending" {
                    flow.State["fork_creation_pending"] = JsonValue.Create(8)
                }
                flow.Save()
                let first = flow.Claim(code: mode == "pending" ? 1: 0)
                let run = mode == "pending" ? RunPath(flow): first
                flow.Reload()
                flow.State["fork_pending_reads"] = JsonValue.Create(0)
                flow.Save()
                Resume(flow, run)
                Resume(flow, run)
                flow.Reload()
                Check.That(Check.Text(flow.State["fork_creations"]) == "1", "Fork creation was repeated")
                let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                Check.That(Check.Text(saved["state"]) == "claimed", "Creation did not finish preparation")
                Check.That(
                    flow.Git("-C", Path.Combine(run, "checkout"), "rev-parse", "HEAD") == Check.Text(saved["base"]),
                    "Checkout moved off approved source"
                )
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func Selection(binary string) {
            for mode in[]string{
                "renamed",
                "explicit",
                "ambiguous",
                "incomplete",
                "collision",
                "ownership",
                "parent",
                "permission"
            } {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                flow.Reload()
                var discovery = Check.Json("[{\"full_name\":\"donor/renamed\",\"fork\":true,\"owner\":{\"id\":123}}]")
                if mode == "renamed" {
                    discovery.AsArray().Add(
                        Check.Map(
                            "full_name",
                            "donor/private",
                            "private",
                            true,
                            "fork",
                            true,
                            "owner",
                            Check.Map("id", 123)
                        )
                    )
                }
                if mode == "ambiguous" {
                    discovery.AsArray().Add(
                        Check.Map("full_name", "donor/second", "fork", true, "owner", Check.Map("id", 123))
                    )
                } else if mode == "incomplete" {
                    discovery = JsonArray()
                    for i in 0 ... 100 {
                        discovery.AsArray().Add(
                            Check.Map(
                                "full_name",
                                "donor/repo-" + i.ToString(),
                                "fork",
                                false,
                                "owner",
                                Check.Map("id", 123)
                            )
                        )
                    }
                } else if mode == "collision" {
                    discovery = JsonArray()
                    flow.State["fork_parent"] = JsonValue.Create("other/project")
                } else if mode == "ownership" {
                    flow.State["fork_owner_id"] = JsonValue.Create(999)
                } else if mode == "parent" {
                    discovery = JsonArray()
                    flow.State["fork_parent"] = JsonValue.Create("other/project")
                } else if mode == "permission" {
                    flow.State["fork_push"] = JsonValue.Create(false)
                }
                flow.State["fork_discovery"] = discovery
                flow.Save()
                let args = List[string]{
                    "claim",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "high",
                    "--seconds",
                    "30"
                }
                let success = mode == "renamed" || mode == "explicit"
                if mode == "explicit" {
                    args.AddRange([]string{"--fork", "donor/custom"})
                }
                args.AddRange([]string{"--runs", Path.Combine(flow.Temp.Root, "runs")})
                flow.Acquire(args.ToArray(), success ? 0: 1)
                if success {
                    let saved = Check.Json(File.ReadAllText(Path.Combine(RunPath(flow), "run.json")))
                    Check.That(
                        Check.Text(saved["head_repo"]) == (mode == "explicit" ? "donor/custom": "donor/renamed"),
                        "Renamed fork was not selected"
                    )
                }
                flow.Reload()
                for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    let path = Check.Text(call["path"])
                    if path.StartsWith("user/repos?") {
                        Check.That(
                            Array.IndexOf(path.Split('?')[1].Split('&'), "visibility=public") >= 0,
                            "Fork discovery requested private repository metadata"
                        )
                    }
                    Check.That(path != "repos/donor/private", "Private fork metadata was collected")
                }
                Check.That(flow.State["fork_creations"] == nil, "Selection failure created a fork")
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func Interruptions(binary string) {
            for phase in[]string{"init", "fetch", "checkout"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                flow.Reload()
                flow.State["preparation_interrupt"] = JsonValue.Create(phase)
                flow.Save()
                flow.Claim(code: 1)
                let run = RunPath(flow)
                Check.That(Directory.Exists(Path.Combine(run, "checkout.staging")), "Interrupted staging was removed")
                Resume(flow, run)
                Check.That(!Directory.Exists(Path.Combine(run, "checkout.staging")), "Staging was not promoted")
                Check.That(Directory.Exists(Path.Combine(run, "checkout")), "Recovered checkout is missing")
                Resume(flow, run)
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func Preservation(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            File.WriteAllText(Path.Combine(flow.Upstream, "donor-dirty.txt"), "private donor work")
            let base = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
            let tree = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD^{tree}")
            let unrelated = flow.DonorGit(
                flow.Upstream,
                "commit-tree",
                tree,
                "-p",
                base,
                "-m",
                "Divergent fork progress"
            )
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, unrelated)
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "update-ref", "refs/heads/main", unrelated)
            let run = flow.Claim()
            let checkout = Path.Combine(run, "checkout")
            Check.That(!File.Exists(Path.Combine(checkout, "donor-dirty.txt")), "Donor work was imported")
            Check.That(
                File.ReadAllText(Path.Combine(flow.Upstream, "donor-dirty.txt")) == "private donor work",
                "User checkout was changed"
            )
            Check.That(
                flow.Git("-C", Path.Combine(flow.Bin, "fork"), "rev-parse", "main") == unrelated,
                "Fork default branch was synchronized"
            )
            File.WriteAllText(Path.Combine(checkout, "private.txt"), "preserve me")
            Check.Contains(Resume(flow, run, 1).Error, "Preserved")
            flow.Call([]string{"work", "--run", run}, 1)
            Check.That(
                File.ReadAllText(Path.Combine(checkout, "private.txt")) == "preserve me",
                "Dirty local work was overwritten"
            )
            File.Delete(Path.Combine(checkout, "private.txt"))
            let marker = Path.Combine(checkout, ".git/tokate-preparation.json")
            let identity = File.ReadAllText(marker)
            File.Delete(marker)
            Resume(flow, run, 1)
            File.WriteAllText(marker, identity)
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            flow.Git(
                "-C",
                Path.Combine(flow.Bin, "fork"),
                "update-ref",
                "refs/heads/" + Check.Text(saved["branch"]),
                unrelated
            )
            Resume(flow, run, 1)
            flow.Claim(code: 1)
            Check.That(
                flow.Git("-C", Path.Combine(flow.Bin, "fork"), "rev-parse", Check.Text(saved["branch"])) == unrelated,
                "Existing contribution branch was changed"
            )
            flow.NoInference()
            flow.NoPr()
        }

        private func ExternalClaim(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let flow = test.Flow
            File.Delete(Path.Combine(flow.Bin, "codex"))
            let args = List[string]{
                "claim",
                "owner/project",
                "--issue",
                "1",
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
            for option in[]string{"--profile", "--harness", "--verification-reserve"} {
                let invalid = List[string](args)
                invalid.AddRange([]string{option, option == "--verification-reserve" ? "5": "codex"})
                flow.Call(invalid.ToArray(), 1)
            }
            Check.That(!Directory.Exists(Path.Combine(flow.Temp.Root, "runs")), "Invalid external claim created a run")
            let result = Check.Json(flow.Call(args.ToArray(), 8).Output)
            let run = RunPath(flow)
            let path = Path.Combine(run, "run.json")
            let pending = Check.Json(File.ReadAllText(path))
            Check.That(
                Check.Text(pending["source"]) == "external" && pending["selection"] == nil,
                "External claim acquired a managed selection"
            )
            Check.That(Check.Text(result["status"]) == "pending", "External claim lost pending status")
            Check.That(
                !(result["next_actions"]?.ToJsonString() ?? "").Contains("\"work\""),
                "External pending claim offered managed inference"
            )
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Reload()
            let comment = flow.State["request_comments"]?[0] ?? throw Exception("Missing external claim")
            test.Coordinate(PostedEvent(test, comment))
            Resume(flow, run)
            let prepared = Check.Json(File.ReadAllText(path))
            Check.That(
                Check.Text(prepared["state"]) == "claimed" && Check.Text(prepared["seconds"]) == "30",
                "External claim did not retain its verification budget"
            )
            Check.That(
                Directory.Exists(Path.Combine(run, "coding")) && !Directory.Exists(Path.Combine(run, "checkout")),
                "External claim prepared a managed checkout"
            )
            Check.That(
                prepared["tools"]?.ToJsonString() == File.ReadAllText(test.Tools),
                "External claim changed donor tool declarations"
            )
            flow.Reload()
            Check.That(Check.Text(flow.State["request_count"]) == "1", "External claim was posted twice")
            flow.NoInference()
            flow.NoPr()
        }

        private func Reservation(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            test.Claim()
            let run = test.Prepare()
            let path = Path.Combine(run, "run.json")
            let original = File.ReadAllText(path)
            let work = Path.Combine(run, "coding/unfinished.txt")
            File.WriteAllText(work, "Saved work")
            test.Flow.Call([]string{"request", "--run", run, "--help"})
            var requests int32
            for action in[]string{"renew", "pause", "resume", "release"} {
                let args = []string{"request", "--run", run, "--operation", action, "--json"}
                test.Flow.Call(args, 1, owner: true)
                if action == "release" {
                    test.Flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                }
                let pending = Check.Json(test.Flow.Call(args, 8).Output)
                Check.That(Check.Text(pending["data"]?["pending"]) == "true", "Reservation request lost pending status")
                let saved = Check.Json(File.ReadAllText(path))
                let pendingText = File.ReadAllText(path)
                saved["id"] = JsonValue.Create(Guid.NewGuid().ToString("D"))
                File.WriteAllText(path, saved.ToJsonString())
                test.Flow.Call(args, 1)
                File.WriteAllText(path, pendingText)
                let request = saved["reservation_request"] ?? throw Exception("Missing saved request")
                let journal = Path.Combine(run, "reservation-" + Check.Text(request["uuid"]) + ".posting.json")
                let backup = journal + ".saved"
                File.Move(journal, backup)
                File.CreateSymbolicLink(journal, work)
                test.Flow.Call(args, 1)
                File.Delete(journal)
                File.Move(backup, journal)
                test.Flow.Call(args, 8)
                test.Flow.Reload()
                requests++
                Check.That(
                    Check.Text(test.Flow.State["request_count"]) == requests.ToString(),
                    "Repeated reservation request posted another comment"
                )
                let comment = test
                    .Flow
                    .State["request_comments"]?[requests - 1] ??
                    throw Exception("Missing request comment")
                test.Coordinate(PostedEvent(test, comment))
                let complete = Check.Json(test.Flow.Call(args).Output)
                Check.That(
                    Check.Text(complete["data"]?["pending"]) == "false",
                    "Recorded reservation request stayed pending"
                )
                let state = test.State()["state"]?["reservation"]
                Check.That(
                    Check.Text(state?["status"]) == (
                        action == "pause" ? "paused": action == "release" ? "released": "active"
                    ),
                    "Reservation did not make the requested transition"
                )
                Check.That(
                    File.ReadAllText(path) == original && File.ReadAllText(work) == "Saved work",
                    "Reservation changed saved execution authority or discarded work"
                )
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
        }

        private func Partial(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let flow = test.Flow
            File.WriteAllText(
                test.Tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            test.Claim()
            let run = test.Prepare("tokate", seconds: "4", reserve: "1")
            flow.Mode("timeout")
            flow.Call([]string{"work", "--run", run}, 1)
            let checkout = Path.Combine(run, "checkout")
            Check.That(File.Exists(Path.Combine(checkout, "partial.txt")), "Interrupted work was not retained")
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            let summary = "{\"changes\":[\"Preserve incomplete work for the next donor.\"],\"verification\":[],\"limitations\":[\"Independent verification has not passed.\"]}"
            for mode in[]string{"empty", "protected", "missing-summary", "expired"} {
                baseline.Restore()
                flow.Reload()
                if mode != "missing-summary" {
                    File.WriteAllText(Path.Combine(checkout, "tokate-public-summary.json"), summary)
                }
                if mode == "empty" {
                    File.Delete(Path.Combine(checkout, "partial.txt"))
                } else if mode == "protected" {
                    Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
                    File.WriteAllText(Path.Combine(checkout, ".github/workflows/unsafe.yml"), "name: unsafe\n")
                } else if mode == "expired" {
                    test.Expire()
                }
                flow.Call([]string{"submit", "--run", run, "--incomplete"}, 1)
                flow.NoPr()
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Partial refusal repeated inference")
            }
            baseline.Restore()
            flow.Reload()
            File.WriteAllText(Path.Combine(checkout, "tokate-public-summary.json"), summary)
            flow.Call([]string{"submit", "--run", run, "--incomplete"}, 1, owner: true)
            flow.Call([]string{"submit", "--run", run, "--incomplete"})
            let path = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            let commit = Check.Text(saved["commit"])
            Check.That(
                Check.Text(saved["incomplete"]) == "true" && Check.Text(saved["state"]) == "incomplete_generated",
                "Partial publication fabricated a completed run"
            )
            let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
            Check.That(
                Check.Text(request["metadata"]?["verification"]) == "not-passed" && Check.Text(
                    request["metadata"]?["incomplete"]
                ) == "true",
                "Partial metadata claimed passing verification"
            )
            saved["commit"] = JsonValue.Create("")
            File.WriteAllText(path, saved.ToJsonString())
            flow.Call([]string{"submit", "--run", run, "--incomplete"})
            Check.That(flow.Git("-C", checkout, "rev-parse", "HEAD") == commit, "Partial recovery made another commit")
            flow.Reload()
            let posted = flow.State["request_comments"]?[0] ?? throw Exception("Missing partial publication request")
            test.Coordinate(PostedEvent(test, posted))
            flow.Call([]string{"submit", "--run", run})
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Reload()
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing incomplete draft")
            Check.That(Check.Text(pull["draft"]) == "true", "Partial publication removed draft status")
            Check.Contains(Check.Text(pull["title"]), "Incomplete:")
            Check.Contains(Check.Text(pull["body"]), "independent owner verification has not passed")
            let checked = Check.Json(
                flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10", "--json"}, 1).Output
            )
            Check.That(
                Check.Text(checked["data"]?["incomplete"]) == "true" && Check.Text(
                    checked["data"]?["machine_status"]
                ) != "passed",
                "Incomplete draft became ready"
            )
            flow.Reload()
            let body = Check.Text(flow.State["pulls"]?[0]?["body"])
            (flow.State["pulls"]?[0] ?? throw Exception("Missing draft"))["body"] = JsonValue.Create(
                body.Replace(",\"incomplete\":true", "")
            )
            flow.Save()
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1)
            flow.Reload()
            (flow.State["pulls"]?[0] ?? throw Exception("Missing draft"))["body"] = JsonValue.Create(body)
            flow.Save()
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Completed work\n")
            flow.Git("-C", checkout, "add", "result.txt")
            flow.DonorGit(checkout, "commit", "-m", "Complete partial work")
            let completed = flow.Git("-C", checkout, "rev-parse", "HEAD")
            let args = []string{
                "amend",
                "--run",
                run,
                "--commit",
                completed,
                "--seconds",
                "30",
                "--summary",
                PublishedContribution.Summary(flow, completed, "Complete the interrupted contribution.")
            }
            flow.Call(args)
            flow.Reload()
            let amendment = flow.State["request_comments"]?[1] ?? throw Exception("Missing completion request")
            test.Coordinate(PostedEvent(test, amendment))
            flow.Call(args)
            flow.Reload()
            Check.That(Check.Text(flow.State["pr_create_count"]) == "1", "Completion created another PR")
            Check.That(
                Check.Json(File.ReadAllText(path))["incomplete"] == nil,
                "Completed run retained incomplete status"
            )
            Check.That(
                Check.Text(flow.State["pulls"]?[0]?["title"]) == "Implement fixture",
                "Completion retained generated incomplete title"
            )
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            flow.Save()
            let ready = Check.Json(
                flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10", "--json"}).Output
            )
            Check.That(
                Check.Text(ready["data"]?["machine_status"]) == "passed" && Check.Text(
                    ready["data"]?["owner_review"]
                ) == "required",
                "Completed amendment lost readiness or accepted itself"
            )
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Partial publication restarted inference")
        }

        private func External(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let claim = test.Claim()
            let run = test.Prepare()
            let coding = Path.Combine(run, "coding")
            Check.That(
                Directory.Exists(coding) && !Directory.Exists(Path.Combine(run, "checkout")),
                "External coding and verification checkout were combined"
            )
            Resume(test.Flow, run)
            File.WriteAllText(Path.Combine(coding, "private-work.txt"), "external coding in progress")
            Resume(test.Flow, run, 1)
            let commit = test.Candidate(claim)
            test.Flow.Call([]string{"external", "--run", run, "--commit", commit})
            Check.That(
                File.ReadAllText(Path.Combine(coding, "private-work.txt")) == "external coding in progress",
                "Verification touched external coding work"
            )
            Check.That(
                test.Flow.Git("-C", Path.Combine(run, "checkout"), "rev-parse", "HEAD") == commit,
                "External verification did not use exact commit"
            )
            Resume(test.Flow, run, 1)
            test.Flow.NoInference()
            test.Flow.NoPr()
        }

        private func Ownership(binary string) {
            for owner in[]bool{true, false} {
                using let test = CoordinationFixture(binary)
                test.Initialize(false)
                test.Flow.Reload()
                test.Flow.State["self_owned"] = JsonValue.Create(true)
                test.Flow.State["upstream_owner_id"] = JsonValue.Create(owner ? 123: 999)
                test.Flow.Save()
                test.Flow.ApproveSelf()
                let claim = test.ClaimRequest()
                test.Coordinate(test.Event(claim, 123, "owner"))
                let state = test.State()
                test.Flow.Call(
                    []string{
                        "prepare",
                        "--repo",
                        "owner/project",
                        "--issue",
                        "1",
                        "--state",
                        Check.Text(state["sha"]),
                        "--source",
                        "external",
                        "--tools",
                        test.Tools,
                        "--fork",
                        "owner/project",
                        "--runs",
                        Path.Combine(test.Flow.Temp.Root, "runs")
                    },
                    owner ? 0: 1
                )
                if !owner {
                    let rejected = test.PublishRequest(claim, Check.Text(state["state"]?["approval"]?["base"]))
                    let metadata = rejected["metadata"] ?? throw Exception("Missing metadata")
                    metadata["fork"] = JsonValue.Create("owner/project")
                    test.Coordinate(test.Event(rejected, 123, "owner"), 1)
                    test.Flow.NoInference()
                    test.Flow.NoPr()
                    continue
                }
                let run = RunPath(test.Flow)
                let record = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                let coding = Path.Combine(run, "coding")
                File.WriteAllText(Path.Combine(coding, "result.txt"), "Owner contribution")
                test.Flow.Git("-C", coding, "add", ".")
                test.Flow.Git(
                    "-C",
                    coding,
                    "-c",
                    "user.name=Owner",
                    "-c",
                    "user.email=owner@example.test",
                    "commit",
                    "-m",
                    "Owner work"
                )
                let commit = test.Flow.Git("-C", coding, "rev-parse", "HEAD")
                test.Flow.Git(
                    "-C",
                    coding,
                    "push",
                    test.Flow.Upstream,
                    "HEAD:refs/heads/" + Check.Text(record["branch"])
                )
                test.Flow.Call([]string{"external", "--run", run, "--commit", commit})
                test.Flow.Call([]string{"submit", "--run", run})
                let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
                test.Coordinate(test.Event(request, 123, "owner"))
                test.Flow.Reload()
                Check.That(
                    test.Flow.State["pulls"]?.AsArray().Count == 1,
                    "Coordinator rejected numerically owned upstream"
                )
                test.Flow.NoInference()
            }
        }

        private func Authority(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            flow.Reload()
            flow.State["preparation_revoke_after_fetch"] = JsonValue.Create(true)
            flow.Save()
            flow.Claim(code: 1)
            let run = RunPath(flow)
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["state"]) == "preparing" && saved["preparation_complete"] == nil,
                "Revoked preparation completed"
            )
            Check.That(Directory.Exists(Path.Combine(run, "checkout")), "Revoked preparation deleted progress")
            Resume(flow, run, 1)
            flow.Call([]string{"work", "--run", run}, 1)
            flow.NoInference()
            flow.NoPr()
            using let external = CoordinationFixture(binary)
            external.Initialize()
            let claim = external.Claim()
            let directory = external.Prepare()
            let path = Path.Combine(directory, "run.json")
            let old = Check.Json(File.ReadAllText(path))
            old.AsObject().Remove("preparation_version")
            old.AsObject().Remove("preparation_identity")
            File.WriteAllText(path, old.ToJsonString())
            let original = File.ReadAllText(path)
            Resume(external.Flow, directory, 1)
            Check.That(File.ReadAllText(path) == original, "Old v2 run was migrated")
            let commit = external.Candidate(claim)
            external.Flow.Call([]string{"external", "--run", directory, "--commit", commit}, 1)
            external.Flow.NoInference()
            external.Flow.NoPr()
        }

        private func LinkedControls(binary string) {
            for v2 in[]bool{true} {
                using let test = CoordinationFixture(binary)
                let flow = test.Flow
                var run string
                if v2 {
                    test.Initialize()
                    test.Claim()
                    run = test.Prepare()
                } else {
                    flow.Initialize()
                    flow.Approve()
                    run = flow.Claim()
                }
                let original = File.ReadAllText(Path.Combine(run, "run.json"))
                for control in[]string{".lock", "run.json", "run.json.tmp"} {
                    let path = Path.Combine(run, control)
                    let backup = Path.Combine(flow.Temp.Root, "control-backup")
                    let existed = File.Exists(path)
                    if existed {
                        File.Move(path, backup)
                    }
                    for link in[]string{"symbolic", "dangling", "hard"} {
                        let dangling = link == "dangling"
                        let target = Path.Combine(flow.Temp.Root, "control-target")
                        if !dangling {
                            File.WriteAllText(target, original)
                        }
                        if link == "hard" {
                            Check.Success(TestProcess.Run("/usr/bin/ln", []string{target, path}, flow.Temp.Env))
                        } else {
                            File.CreateSymbolicLink(path, target)
                        }
                        for command in[]string{
                            "prepare",
                            "work",
                            "external",
                            "submit",
                            "recover",
                            "correction",
                            "amend",
                            "submit-correction",
                        } {
                            let corrected = command.EndsWith("-correction")
                            if corrected {
                                File.WriteAllText(Path.Combine(run, "correction.json"), "{}")
                            }
                            let name = corrected ? command.Replace("-correction", ""): (
                                command == "correction" ? "recover": command
                            )
                            let args = List[string]{name, "--run", run}
                            if command == "correction" || command == "recover" {
                                args.Add("--prepare")
                            }
                            if command == "external" || command == "amend" {
                                args.AddRange([]string{"--commit", String('0', 40)})
                            }
                            if command == "amend" {
                                args.AddRange([]string{"--seconds", "30"})
                            }
                            Check.Contains(flow.Call(args.ToArray(), 1).Error, "Preserved")
                            if corrected {
                                File.Delete(Path.Combine(run, "correction.json"))
                            }
                            Check.That(
                                link == "hard" ? File.ReadAllText(path) == original: FileInfo(
                                    path
                                ).LinkTarget == target,
                                "Refusal replaced linked control"
                            )
                            Check.That(
                                dangling ? !File.Exists(target): File.ReadAllText(target) == original,
                                "Refusal followed linked control"
                            )
                        }
                        File.Delete(path)
                        if !dangling {
                            File.Delete(target)
                        }
                    }
                    if existed {
                        File.Move(backup, path)
                    }
                    Check.That(
                        File.ReadAllText(Path.Combine(run, "run.json")) == original,
                        "Refusal changed run record"
                    )
                }
                Resume(flow, run)
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func Claiming(binary string, args[]string, env Dictionary[string, string], output Chan[Result]) {
            output <- TestProcess.Run(binary, args, env)
        }

        private func AcquisitionArgs(flow NativeFixture, command string)[]string -> []string{
            command,
            "https://github.com/owner/project/issues/1",
            "--model",
            "gpt-6.1-sol",
            "--effort",
            "high",
            "--seconds",
            "60",
            "--verification-reserve",
            "20",
            "--runs",
            Path.Combine(flow.Temp.Root, "runs")
        }

        private func PostedEvent(test CoordinationFixture, comment JsonNode) string {
            let path = Path.Combine(test.Flow.Temp.Root, "posted-event.json")
            File.WriteAllText(
                path,
                Check.Map(
                    "action",
                    "created",
                    "repository",
                    Check.Map("full_name", "owner/project", "id", 1),
                    "issue",
                    Check.Map("number", 1),
                    "comment",
                    comment.DeepClone()
                )
                    .ToJsonString()
            )
            return path
        }

        private func Acquiring(test CoordinationFixture, command string, code int32 = 0) string {
            let flow = test.Flow
            let output = Chan[Result](1)
            go Claiming(flow.Binary, AcquisitionArgs(flow, command), flow.Temp.Env, output)
            var comment JsonNode? = nil
            let deadline = DateTime.UtcNow.AddSeconds(30)
            while comment == nil {
                let snapshot = Check.Json(File.ReadAllText(Path.Combine(flow.Bin, "state.json")))
                comment = snapshot["request_comments"]?.AsArray()[0]?.DeepClone()
                if comment != nil {
                    break
                }
                select {
                    case let result = <- output {
                        Check.Success(result)
                        throw Exception("Acquisition completed without posting its claim")
                    }
                    case <- after(TimeSpan.FromMilliseconds(20)) { }
                }
                Check.That(DateTime.UtcNow < deadline, "Claim did not reach coordinator rendezvous")
            }
            let run = RunPath(flow)
            let pending = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(pending["state"]) == "claim_pending" && pending["id"] == nil,
                "Pending claim granted local authority"
            )
            Check.That(
                File.GetUnixFileMode(Path.Combine(run, "run.json")) == (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                "Pending claim is not private"
            )
            Check.That(
                pending["claim_request"]?["metadata"]?.AsObject().Count == 0,
                "Claim exposes private readiness settings"
            )
            flow.NoInference()
            test.Coordinate(PostedEvent(test, comment ?? throw Exception("Missing posted comment")))
            let result = <-output
            Check.That(result.Code == code, result.Output + result.Error)
            return run
        }

        private func Acquisition(binary string) {
            for command in[]string{"claim", "work"} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                let run = Acquiring(test, command)
                let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                let uuid = Check.Text(saved["claim_request"]?["uuid"])
                Check.That(
                    Check.Text(saved["attempt"]) == uuid && Path.GetFileName(run) == uuid,
                    "Acquisition changed the exact attempt"
                )
                test.Flow.Reload()
                Check.That(Check.Text(test.Flow.State["request_count"]) == "1", "Acquisition duplicated its claim POST")
                if command == "claim" {
                    Check.That(Check.Text(saved["state"]) == "claimed", "Reserve-only claim did not prepare")
                    test.Flow.NoInference()
                    test.Flow.State["dependency_pages"] = Check.Map(
                        "1",
                        Check.Json(
                            "[[{\"id\":2,\"number\":2,\"url\":\"https://api.github.com/repos/owner/project/issues/2\",\"state\":\"open\"}]]"
                        )
                    )
                    test.Flow.Save()
                    test.Flow.Call([]string{"work", "--run", run}, 1)
                    test.Flow.NoInference()
                } else {
                    Check.That(Check.Text(saved["state"]) == "generated", "Composed work did not save verified work")
                    Check.That(Check.Text(test.Flow.State["exec_count"]) == "1", "Composed work did not execute once")
                    test.Flow.Call([]string{"work", "--run", run}, 1)
                    test.Flow.Reload()
                    Check.That(Check.Text(test.Flow.State["exec_count"]) == "1", "Saved work restarted inference")
                }
                test.Flow.NoPr()
            }
        }

        private func PendingClaim(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let flow = test.Flow
            flow.Call(
                []string{
                    "defaults",
                    "set",
                    "--profile",
                    "ready",
                    "--harness",
                    "codex",
                    "--provider",
                    "openai",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "high"
                }
            )
            let result = flow.Call(
                []string{
                    "work",
                    "https://github.com/owner/project/issues/1",
                    "--profile",
                    "ready",
                    "--seconds",
                    "60",
                    "--verification-reserve",
                    "20",
                    "--runs",
                    Path.Combine(flow.Temp.Root, "runs"),
                    "--json"
                },
                8
            )
            let run = RunPath(flow)
            let pending = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            let envelope = Check.Json(result.Output)
            Check.That(
                Check.Text(envelope["status"]) == "pending" && Check.Text(
                    envelope["data"]?["state"]
                ) == "claim_pending",
                "Pending JSON omitted its saved state"
            )
            Check.Contains(envelope["next_actions"]?.ToJsonString() ?? "", "prepare")
            Check.Contains(envelope["next_actions"]?.ToJsonString() ?? "", "work")
            Check.Contains(envelope["next_actions"]?.ToJsonString() ?? "", run)
            let uuid = Check.Text(pending["claim_request"]?["uuid"])
            flow.Reload()
            Check.That(
                Check.Text(flow.State["request_count"]) == "1" && flow.State["fork_creations"] == nil,
                "Pending claim posted or prepared twice"
            )
            flow.NoInference()
            flow.Call(
                []string{
                    "defaults",
                    "set",
                    "--profile",
                    "ready",
                    "--harness",
                    "codex",
                    "--provider",
                    "openai",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "minimal"
                }
            )
            flow.Reload()
            let comment = flow.State["request_comments"]?.AsArray()[0] ?? throw Exception("Missing posted claim")
            let body = Check.Text(comment["body"])
            Check.That(body.StartsWith("/tokate claim\n"), "Claim did not expose its action")
            Check.Contains(body, "Pending coordinator review.")
            Check.Contains(body, "Requested by the author of this comment.")
            Check.Contains(body, "<summary>Coordination data</summary>")
            Check.Contains(body, "`tokate status`")
            let id = Check.Text(comment["id"])
            for changed in[]string{
                body.Replace("Pending coordinator review.", "Reservation accepted."),
                body.Replace("/tokate claim\n", "/tokate publish\n"),
                body + "\nExtra request",
                body.Replace("\n```\n</details>", " trailing\n```\n</details>")
            } {
                comment["body"] = JsonValue.Create(changed)
                flow.Reload()
                (flow.State["comments"] ?? throw Exception("Missing comments"))[id] = comment.DeepClone()
                flow.Save()
                test.Coordinate(PostedEvent(test, comment), 1)
            }
            comment["body"] = JsonValue.Create(body)
            flow.Reload()
            (flow.State["comments"] ?? throw Exception("Missing comments"))[id] = comment.DeepClone()
            flow.Save()
            test.Coordinate(PostedEvent(test, comment))
            flow.Call([]string{"work", "--run", run})
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["attempt"]) == uuid && Check.Text(saved["effort"]) == "high",
                "Resume changed the frozen request or profile"
            )
            flow.Reload()
            Check.That(
                Check.Text(flow.State["request_count"]) == "1" && Check.Text(flow.State["exec_count"]) == "1",
                "Resume duplicated posting or inference"
            )
            Check.That(File.Exists(Path.Combine(run, "claim.posting.json")), "Promotion lost the posting journal")
            flow.NoPr()
        }

        private func ClaimGates(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let flow = test.Flow
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for gate in[]string{"budget", "dependency", "capability", "competing", "revoked", "missing"} {
                baseline.Restore()
                flow.Reload()
                let args = List[string](AcquisitionArgs(flow, "work"))
                if gate == "budget" {
                    args.RemoveAt(args.IndexOf("--seconds") + 1)
                    args.Remove("--seconds")
                } else if gate == "dependency" {
                    flow.Reload()
                    flow.State["dependency_pages"] = Check.Map(
                        "1",
                        Check.Json(
                            "[[{\"id\":2,\"number\":2,\"url\":\"https://api.github.com/repos/owner/project/issues/2\",\"state\":\"open\"}]]"
                        )
                    )
                    flow.Save()
                } else if gate == "capability" {
                    flow.Mode("missing_controls")
                } else if gate == "competing" {
                    test.Claim()
                } else if gate == "revoked" {
                    flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                } else {
                    flow.Git("-C", flow.Upstream, "update-ref", "-d", "refs/heads/tokate/contributions/1")
                }
                flow.Call(args.ToArray(), 1)
                flow.Reload()
                Check.That(
                    flow.State["request_count"] == nil && flow.State["fork_creations"] == nil,
                    "Failed readiness mutated a request or fork"
                )
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func PendingAuthority(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let flow = test.Flow
            flow.Call(AcquisitionArgs(flow, "claim"), 8)
            let run = RunPath(flow)
            let baselineComment = test.Comment
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for gate in[]string{"expired", "revoked", "stale", "actor", "unrecorded", "evicted"} {
                baseline.Restore()
                test.Comment = baselineComment
                flow.Reload()
                let comment = flow.State["request_comments"]?.AsArray()[0] ?? throw Exception("Missing posted claim")
                if gate == "stale" {
                    flow.Approve()
                } else if gate == "actor" {
                    flow.State["viewer_id"] = JsonValue.Create(999)
                    flow.Save()
                } else if gate == "unrecorded" {
                    test.Claim()
                } else {
                    test.Coordinate(PostedEvent(test, comment))
                    if gate == "expired" {
                        test.Expire()
                    } else if gate == "revoked" {
                        flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                    } else {
                        let state = test.State()["state"] ?? throw Exception("Missing state")
                        state["outcomes"] = JsonArray()
                        test.RewriteState(state)
                    }
                }
                flow.Call([]string{"work", "--run", run}, 1)
                flow.Reload()
                Check.That(
                    Check.Text(flow.State["request_count"]) == "1" && flow.State["fork_creations"] == nil,
                    "Changed authority posted or prepared new work"
                )
                Check.That(
                    Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["state"]) == "claim_pending",
                    "Changed authority promoted pending work"
                )
                flow.NoInference()
                flow.NoPr()
            }
        }

        private func ClaimRecovery(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            test.Flow.Reload()
            test.Flow.State["preparation_interrupt"] = JsonValue.Create("fetch")
            test.Flow.Save()
            let run = Acquiring(test, "work", 1)
            let original = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(original["state"]) == "preparing" && Directory.Exists(Path.Combine(run, "checkout.staging")),
                "Failed preparation lost partial work"
            )
            Check.That(File.Exists(Path.Combine(run, "claim.posting.json")), "Failed preparation lost its journal")
            test.Flow.NoInference()
            Resume(test.Flow, run)
            test.Flow.NoInference()
            test.Flow.Call([]string{"work", "--run", run})
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["attempt"]) == Check.Text(original["attempt"]),
                "Recovery changed the execution attempt"
            )
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["request_count"]) == "1" && Check.Text(test.Flow.State["exec_count"]) == "1",
                "Recovery repeated a request or inference"
            )
            test.Flow.NoPr()
        }

        private func Guided(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let flow = test.Flow
            flow.Temp.Env["TERM"] = "dumb"
            flow.Temp.Env["NO_COLOR"] = "1"
            flow.Call([]string{"defaults", "set", "--profile", "ready", "--model", "gpt-6.1-sol", "--effort", "high"})
            flow.Call(
                []string{"defaults", "set", "--profile", "rejected", "--model", "not-allowed", "--effort", "high"}
            )
            flow.Temp.Env["XDG_STATE_HOME"] = Path.Combine(flow.Temp.Root, "new state")
            let runRoot = Path.Combine(flow.Temp.Env["XDG_STATE_HOME"], "tokate/runs")
            let args = []string{"work", "owner/project"}
            let cancelled = TestTerminal.Pty(binary, args, flow.Temp, 80, "q\n")
            Check.That(cancelled.Code == 1, cancelled.Output + cancelled.Error)
            Check.Contains(cancelled.Output, "Choose an issue")
            Check.Contains(cancelled.Output, "Cancelled")
            let declined = TestTerminal.Pty(binary, args, flow.Temp, 80, "1\n1\n1\n1\nq\n")
            Check.That(declined.Code == 1, declined.Output + declined.Error)
            Check.Contains(declined.Output, "Review donation")
            Check.Contains(declined.Output, "owner/project #1")
            Check.Contains(declined.Output, "1 minutes")
            Check.Contains(declined.Output, "Project commands offline")
            Check.Contains(declined.Output, "Cancelled")
            Check.That(!declined.Output.Contains("rejected |"), "Guided menu offered an owner-rejected profile")
            flow.Reload()
            Check.That(
                flow.State["request_count"] == nil && flow.State["fork_creations"] == nil,
                "Cancelled wizard wrote remotely"
            )
            Check.That(!Directory.Exists(runRoot), "Cancelled wizard created a run")
            flow.NoInference()
            {
                using let baseline = FixtureSnapshot(flow.Temp.Root)
                for limit in[]int32{14400, 3659} {
                    baseline.Restore()
                    let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                    let policy = Check.Json(File.ReadAllText(path))
                    policy["max_seconds"] = JsonValue.Create(limit)
                    File.WriteAllText(path, policy.ToJsonString())
                    flow.Commit("Set owner budget")
                    flow.Approve()
                    let budget = TestTerminal.Pty(binary, args, flow.Temp, 80, "1\n1\n1\n1\nq\n")
                    Check.That(budget.Code == 1, budget.Output + budget.Error)
                    Check.Contains(budget.Output, "Owner limit: " + (limit / 60).ToString() + " minutes")
                    Check.Contains(budget.Output, "Review donation")
                    Check.That(!budget.Output.Contains("No time limit"), "Wizard advertised forbidden unlimited coding")
                    let refused = TestTerminal.Pty(binary, args, flow.Temp, 80, "1\n1\n240\n1\nq\n")
                    Check.That(refused.Code == 1, refused.Output + refused.Error)
                    Check.Contains(refused.Output, "Use positive whole minutes.")
                    Check.That(!refused.Output.Contains("Review donation"), "Wizard accepted an excessive budget")
                    flow.NoInference()
                }
                baseline.Restore()
                flow.Reload()
            }
            let owner = TestTerminal.Pty(binary, []string{}, flow.Temp, 60, "2\nq\n")
            Check.Success(owner)
            Check.Contains(owner.Output, "Project")
            Check.That(
                !Directory.Exists(Path.Combine(flow.Temp.Root, ".github")),
                "Cancelled owner setup wrote configuration"
            )
            flow.Call([]string{"work", "owner/project", "--non-interactive"}, 1)
            flow.Call([]string{"work", "owner/project", "--json"}, 1)
            let accepted = TestTerminal.Pty(binary, args, flow.Temp, 80, "1\n1\n1\n1\n1\n")
            Check.That(accepted.Code == 8, accepted.Output + accepted.Error)
            let runs = Directory.GetDirectories(runRoot)
            Check.That(runs.Length == 1, "Guided claim did not use the selected state root")
            let run = runs[0]
            let pending = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(Check.Text(pending["state"]) == "claim_pending", "Guided work lost pending state")
            Check.That(
                Check.Text(pending["seconds"]) == "120" && Check.Text(pending["verification_reserve"]) == "60",
                "Guided budget changed"
            )
            flow.Reload()
            let comment = flow.State["request_comments"]?[0] ?? throw Exception("Missing guided claim")
            Check.That(Check.Text(flow.State["request_count"]) == "1", "Guided work posted more than once")
            flow.NoInference()
            test.Coordinate(PostedEvent(test, comment))
            let unavailable = TestTerminal.Pty(binary, args, flow.Temp, 40, "1\n1\n1\n1\n1\n")
            Check.That(unavailable.Code == 1, unavailable.Output + unavailable.Error)
            Check.Contains(
                unavailable.Output.Replace("\r\n", " ").Replace("\n", " "),
                "An unexpired reservation already owns"
            )
            flow.NoInference()
            flow.NoPr()
        }

        internal func All(binary string, selected string = "") {
            for test in[]TestCase[string]{
                TestCase[string]("Guided", async (value string) -> Guided(value)),
                TestCase[string]("ExternalClaim", async (value string) -> ExternalClaim(value)),
                TestCase[string]("Reservation", async (value string) -> Reservation(value)),
                TestCase[string]("Partial", async (value string) -> Partial(value)),
                TestCase[string]("Acquisition", async (value string) -> Acquisition(value)),
                TestCase[string]("PendingClaim", async (value string) -> PendingClaim(value)),
                TestCase[string]("ClaimGates", async (value string) -> ClaimGates(value)),
                TestCase[string]("PendingAuthority", async (value string) -> PendingAuthority(value)),
                TestCase[string]("ClaimRecovery", async (value string) -> ClaimRecovery(value)),
                TestCase[string]("Creation", async (value string) -> Creation(value)),
                TestCase[string]("Selection", async (value string) -> Selection(value)),
                TestCase[string]("Interruptions", async (value string) -> Interruptions(value)),
                TestCase[string]("Preservation", async (value string) -> Preservation(value)),
                TestCase[string]("External", async (value string) -> External(value)),
                TestCase[string]("Ownership", async (value string) -> Ownership(value)),
                TestCase[string]("Authority", async (value string) -> Authority(value)),
                TestCase[string]("LinkedControls", async (value string) -> LinkedControls(value))
            } {
                let name = test.Name
                if selected != "" && selected != name {
                    continue
                }
                test.Run(binary)
                Console.WriteLine("PASS preparation " + name)
            }
        }
    }
}
