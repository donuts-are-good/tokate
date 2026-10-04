package TokateTests

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
                    "high"
                }
                let success = mode == "renamed" || mode == "explicit"
                if mode == "explicit" {
                    args.AddRange([]string{"--fork", "donor/custom"})
                }
                args.AddRange([]string{"--runs", Path.Combine(flow.Temp.Root, "runs")})
                flow.Call(args.ToArray(), success ? 0: 1)
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
            let unrelated = flow.Git(
                "-C",
                flow.Upstream,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
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

        private func External(binary string) {
            using let test = CoordinationFlow(binary)
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
            using let v1 = NativeFixture(binary)
            v1.Initialize()
            v1.ApproveSelf()
            let claimed = v1.SameRepositoryClaim()
            let index = claimed.Output.LastIndexOf("Run: ")
            Check.That(index >= 0, "Owner v1 preparation failed")
            let directory = claimed.Output.Substring(index + 5).Trim()
            let path = Path.Combine(directory, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            saved.AsObject().Remove("preparation_version")
            saved.AsObject().Remove("preparation_identity")
            File.WriteAllText(path, saved.ToJsonString())
            let old = File.ReadAllText(path)
            Resume(v1, directory, 1)
            Check.That(File.ReadAllText(path) == old, "Old v1 record was migrated")
            for owner in[]bool{true, false} {
                using let test = CoordinationFlow(binary)
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
            using let external = CoordinationFlow(binary)
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
            external.Flow.Call([]string{"external", "--run", directory, "--commit", commit})
            external.Flow.NoInference()
            external.Flow.NoPr()
        }

        internal func All(binary string, selected string = "") {
            for name in[]string{
                "Creation",
                "Selection",
                "Interruptions",
                "Preservation",
                "External",
                "Ownership",
                "Authority"
            } {
                if selected != "" && selected != name {
                    continue
                }
                switch name {
                    case "Creation" {
                        Creation(binary)
                    }
                    case "Selection" {
                        Selection(binary)
                    }
                    case "Interruptions" {
                        Interruptions(binary)
                    }
                    case "Preservation" {
                        Preservation(binary)
                    }
                    case "External" {
                        External(binary)
                    }
                    case "Ownership" {
                        Ownership(binary)
                    }
                    case "Authority" {
                        Authority(binary)
                    }
                }
                Console.WriteLine("PASS preparation " + name)
            }
        }
    }
}
