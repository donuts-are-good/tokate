package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class AttemptContinuationChecks {
    shared {
        private func Read(directory string) JsonNode -> Check.Json(
            File.ReadAllText(Path.Combine(directory, "run.json"))
        )

        private func Save(directory string, run JsonNode) -> File.WriteAllText(
            Path.Combine(directory, "run.json"),
            run.ToJsonString()
        )

        private func Pi(test CoordinationFlow, endpoint string) {
            let root = Path.Combine(test.Flow.Temp.Root, "runtime/node_modules")
            let installed = Path.Combine(root, "@earendil-works/pi-coding-agent")
            Directory.CreateDirectory(Path.Combine(installed, "dist"))
            File.WriteAllText(
                Path.Combine(installed, "package.json"),
                "{\"name\":\"@earendil-works/pi-coding-agent\",\"version\":\"fixture-continuation\",\"type\":\"module\"}"
            )
            File.WriteAllText(Path.Combine(installed, "dist/index.js"), TestResources.Template("PiContinuation.mjs"))
            let config = Path.Combine(test.Flow.Temp.Root, "pi-models")
            Directory.CreateDirectory(config)
            test.Flow.Temp.Env["PI_CODING_AGENT_DIR"] = config
            File.WriteAllText(
                Path.Combine(config, "models.json"),
                "{\"providers\":{\"local\":{\"baseUrl\":\"" +
                    endpoint +
                    "\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"fixture-model\",\"reasoning\":false,\"contextWindow\":32768,\"maxTokens\":4096}]}}}"
            )
        }

        private func Args(
            test CoordinationFlow,
            source string = "",
            harness string = "codex",
            consent bool = true,
            seconds string = "40",
            reserve string = "12",
            endpoint string = ""
        )[]string {
            let args = List[string]{
                "prepare",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--state",
                Check.Text(test.State()["sha"]),
                "--source",
                "tokate",
                "--harness",
                harness,
                "--provider",
                harness == "pi" ? "local-chat-completions": "openai",
                "--model",
                harness == "pi" ? "fixture-model": "gpt-6.1-sol",
                "--effort",
                harness == "pi" ? "absent": "high",
                "--seconds",
                seconds,
                "--verification-reserve",
                reserve,
                "--runs",
                Path.Combine(test.Flow.Temp.Root, "runs")
            }
            if harness == "pi" {
                args.AddRange(
                    []string{
                        "--pi-root",
                        Path.Combine(test.Flow.Temp.Root, "runtime/node_modules"),
                        "--node",
                        TestProcess.Node(),
                        "--endpoint",
                        endpoint
                    }
                )
            }
            if source != "" {
                args.AddRange([]string{"--continue-from", source})
            }
            if consent {
                args.Add("--yes")
            }
            return args.ToArray()
        }

        private func Prepare(test CoordinationFlow, args[]string, code int32 = 0) string {
            let result = test.Flow.Call(args, code)
            let index = result.Output.LastIndexOf("Run: ")
            return index < 0 ? "": result.Output.Substring(index + 5).Trim()
        }

        private func Setup(
            test CoordinationFlow,
            actual string = "",
            harness string = "codex",
            endpoint string = ""
        ) string {
            test.Initialize(approve: false)
            test.Flow.Call([]string{"access", "--repo", "owner/project", "--operation", "init"}, owner: true)
            test.Flow.Call(
                []string{"access", "--repo", "owner/project", "--operation", "trust", "--donor", "donor"},
                owner: true
            )
            File.WriteAllText(Path.Combine(test.Flow.Upstream, "tracked.txt"), "approved\n")
            File.WriteAllText(Path.Combine(test.Flow.Upstream, "baseline.txt"), "baseline\n")
            Directory.CreateDirectory(Path.Combine(test.Flow.Upstream, "folder"))
            File.WriteAllText(Path.Combine(test.Flow.Upstream, "folder/child"), "baseline\n")
            let path = Path.Combine(test.Flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["approval_scope"] = JsonValue.Create("task")
            policy["eligibility"] = JsonValue.Create("trusted")
            policy["allow_network"] = JsonValue.Create(true)
            policy["verification"] = Check.Json(
                "[[\"/bin/bash\",\"-c\",\"test -f result.txt && test \\\"$$(cat tracked.txt)\\\" = preserved && test \\\"$$(cat imported.txt)\\\" = untracked && test \\\"$$(git show HEAD:tracked.txt)\\\" = approved\"]]"
            )
            if harness == "pi" {
                Pi(test, endpoint)
                policy["model_policy"] = JsonValue.Create("whitelist")
                policy["allowed_tools"] = Check.Json("[{\"harness\":\"pi\",\"provider\":\"local-chat-completions\"}]")
                policy["models"] = Check.Json("{\"fixture-model\":[\"absent\"]}")
            }
            File.WriteAllText(path, policy.ToJsonString())
            test.Flow.Commit("Continuation authority and complete-diff verification fixture")
            test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
            test.Coordinate(test.Event(test.ClaimRequest()))
            let args = List[string](
                Args(
                    test,
                    harness: harness,
                    seconds: actual == "timeout" ? "3": "45",
                    reserve: actual == "timeout" ? "1": "15",
                    endpoint: endpoint
                )
            )
            args.Add("--allow-network")
            let source = Prepare(test, args.ToArray())
            if actual != "" {
                test.Flow.Reload()
                test.Flow.State["continuation_timeout"] = JsonValue.Create(true)
                test.Flow.Save()
                test.Flow.Mode(actual == "crash" || actual == "cancel" ? "timeout": actual)
                if actual == "crash" || actual == "cancel" {
                    Stop(test, source, actual)
                } else {
                    test.Flow.Call([]string{"work", "--run", source, "--yes"}, 1)
                }
                test.Flow.Mode("")
                if harness == "codex" {
                    File.SetUnixFileMode(
                        Path.Combine(test.Flow.Bin, "codex-impl"),
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    )
                }
            } else {
                let run = Read(source)
                run["state"] = JsonValue.Create("failed")
                run["failure_stage"] = JsonValue.Create("inference")
                run["failure_reason"] = JsonValue.Create("inference_interrupted")
                run[harness == "pi" ? "pi_version": "codex_version"] = JsonValue.Create("fixture-stopped")
                Save(source, run)
                File.WriteAllText(Path.Combine(source, "events.jsonl"), "{\"type\":\"partial")
                File.WriteAllText(Path.Combine(source, "stderr.log"), "preserved fixture log")
                File.WriteAllText(Path.Combine(source, "checkout/tracked.txt"), "preserved\n")
                File.WriteAllText(Path.Combine(source, "checkout/imported.txt"), "untracked\n")
            }
            return source
        }

        private func Stop(test CoordinationFlow, source string, mode string) {
            let info = TestProcess.StartInfo(
                test.Flow.Binary,
                []string{"work", "--run", source, "--yes"},
                test.Flow.Temp.Env
            )
            using let process = Process.Start(info) ?? throw Exception("Cannot start stopped-run fixture")
            process.StandardInput.Close()
            let output = Chan[string](1)
            let errors = Chan[string](1)
            go TestProcess.Read(process.StandardOutput, output)
            go TestProcess.Read(process.StandardError, errors)
            try {
                let deadline = DateTime.UtcNow.AddSeconds(20)
                while !File.Exists(Path.Combine(source, "checkout/imported.txt")) {
                    Check.That(
                        !process.HasExited && DateTime.UtcNow < deadline,
                        "Interrupted harness did not preserve fixture edits"
                    )
                    select {
                        case <- after(TimeSpan.FromMilliseconds(20)) { }
                    }
                }
                test.Lifecycle("pause")
                test.Lifecycle("resume")
                Prepare(test, Args(test, source), 1)
                Check.Success(
                    TestProcess.Run(
                        "/usr/bin/kill",
                        []string{mode == "crash" ? "-KILL": "-INT", process.Id.ToString()},
                        test.Flow.Temp.Env
                    )
                )
                Check.That(process.WaitForExit(10000), "Interrupted harness did not stop")
                Check.That(process.ExitCode != 0, "Stopped execution was reported as successful")
                let captured = <-output
                let error = <-errors
                if mode == "cancel" {
                    Check.Contains(error + captured, "cancelled")
                }
            } finally {
                if !process.HasExited {
                    process.Kill(true)
                    process.WaitForExit()
                }
            }
        }

        private func FreshAttempt(test CoordinationFlow, release bool = false) {
            test.Lifecycle(release ? "release": "pause")
            if release {
                test.Coordinate(test.Event(test.ClaimRequest()))
            } else {
                test.Lifecycle("resume")
            }
        }

        private func Bytes(directory string) Dictionary[string, string] {
            let evidence = Dictionary[string, string]()
            for path in Directory.GetFiles(directory, "*", SearchOption.AllDirectories) {
                evidence[path.Substring(directory.Length + 1)] = Check.Hash(path)
            }
            return evidence
        }

        private func Preserved(directory string, original Dictionary[string, string]) {
            let current = Bytes(directory)
            Check.That(current.Count == original.Count, "Continuation changed the source inventory")
            for pair in original {
                Check.That(current[pair.Key] == pair.Value, "Continuation rewrote source bytes: " + pair.Key)
            }
        }

        private func Flow(binary string, mode string, harness string = "codex") {
            using let test = CoordinationFlow(binary)
            using let catalog = harness == "pi" ? PiCatalog(): nil
            let endpoint = catalog?.Endpoint ?? ""
            if catalog != nil {
                let response = TestProcess.Run(
                    "/usr/bin/curl",
                    []string{"-qfsS", "--max-time", "2", endpoint + "/models"},
                    test.Flow.Temp.Env
                )
                Check.Success(response)
                Check.That(
                    Check.Text(Check.Json(response.Output)["data"]?[0]?["id"]) == "fixture-model",
                    "Pi catalog did not advertise the selected fixture model"
                )
            }
            let source = Setup(test, mode, harness, endpoint)
            let original = Bytes(source)
            let prior = Read(source)
            if mode != "crash" && mode != "cancel" {
                FreshAttempt(test, mode == "incomplete_turn")
            }
            let state = Check.Text(test.State()["sha"])
            let fresh = Prepare(test, Args(test, source, harness, endpoint: endpoint))
            let run = Read(fresh)
            Check.That(
                fresh != source && Check.Text(run["id"]) == Check.Text(prior["id"]) && Check.Text(
                    run["attempt"]
                ) != Check.Text(prior["attempt"]),
                "Continuation did not preserve identity with a new attempt directory"
            )
            Check.That(
                Check.Text(run["seconds"]) == "40" && Check.Text(run["verification_reserve"]) == "12" && Check.Text(
                    run["network"]
                ) == "false",
                "Continuation inherited budgets or network consent"
            )
            Check.That(
                run["usage"] == nil && run["turn_completed"] == nil && run["verification"] == nil && !File.Exists(
                    Path.Combine(fresh, "report.md")
                ),
                "Continuation inherited success evidence"
            )
            Check.That(Check.Text(run["base"]) == Check.Text(prior["base"]), "Continuation changed the approved base")
            Check.That(
                !Directory.Exists(Path.Combine(fresh, "checkout/.verification-data")),
                "Continuation imported generated source files"
            )
            test.Flow.Call([]string{"prepare", "--run", fresh})
            test.Flow.Call([]string{"prepare", "--run", fresh})
            Prepare(test, Args(test, source, harness, endpoint: endpoint), 1)
            test.Flow.Call([]string{"work", "--run", source, "--yes"}, 1)
            test.Flow.Call([]string{"work", "--run", fresh}, 1)
            Check.That(Check.Text(test.State()["sha"]) == state, "Preparation acquired or renewed authority")
            let copied = Path.Combine(test.Flow.Temp.Root, "runs/copied-attempt")
            Directory.CreateDirectory(copied)
            File.Copy(Path.Combine(fresh, "run.json"), Path.Combine(copied, "run.json"))
            test.Flow.Call([]string{"prepare", "--run", copied}, 1)
            test.Flow.Call([]string{"work", "--run", copied, "--yes"}, 1)
            Check.That(
                !File.Exists(Path.Combine(copied, "events.jsonl")),
                "Copied destination executed under a shared fence"
            )
            Directory.Delete(copied, true)
            test.Flow.Call([]string{"work", "--run", fresh, "--yes"})
            test.Flow.Call([]string{"work", "--run", fresh, "--yes"}, 1)
            Preserved(source, original)
            let complete = Read(fresh)
            Check.That(
                Check.Text(complete["state"]) == "generated" &&
                    complete["turn_completed"] != nil &&
                    complete["verification"]
                    ?.AsArray().Count == 1,
                "New attempt did not independently verify the complete resulting diff"
            )
            if harness == "codex" {
                test.Flow.Reload()
                Check.That(
                    Check.Text(test.Flow.State["exec_count"]) == "2",
                    "Continuation launched an extra coding turn"
                )
                Check.Contains(Check.Text(test.Flow.State["prompts"]?[1]), Check.Text(prior["attempt"]))
            } else {
                Check.Contains(File.ReadAllText(Path.Combine(fresh, "events.jsonl")), Check.Text(prior["attempt"]))
            }
            test.Flow.NoPr()
            Publish(test, source, fresh)
            Preserved(source, original)
        }

        private func Publish(test CoordinationFlow, source string, fresh string) {
            test.Flow.Call([]string{"submit", "--run", source}, 1)
            let preserved = File.ReadAllText(Path.Combine(fresh, "run.json"))
            let omitted = Read(fresh)
            for key in[]string{
                "continuation",
                "continuation_source",
                "continuation_source_metadata_sha256",
                "continuation_manifest_sha256"
            } {
                omitted.AsObject().Remove(key)
            }
            Save(fresh, omitted)
            test.Flow.Call([]string{"submit", "--run", fresh}, 1)
            File.WriteAllText(Path.Combine(fresh, "run.json"), preserved)
            test.Flow.Call([]string{"submit", "--run", fresh})
            let request = Check.Json(File.ReadAllText(Path.Combine(fresh, "request.json")))
            let metadata = request["metadata"] ?? throw Exception("Missing publication metadata")
            Check.That(
                JsonNode.DeepEquals(metadata["predecessor"], Read(fresh)["continuation"]),
                "Submission omitted predecessor evidence"
            )
            let late = request.DeepClone()
            let old = late["metadata"] ?? throw Exception("Missing metadata")
            late["uuid"] = JsonValue.Create(Guid.NewGuid().ToString("D"))
            old["attempt"] = JsonValue.Create(Check.Text(Read(source)["attempt"]))
            old.AsObject().Remove("predecessor")
            old.AsObject().Remove("import_manifest_sha256")
            test.Coordinate(test.Event(late), 1)
            for mode in[]string{"missing-hash", "donor", "lineage", "same-attempt", "external"} {
                let changed = request.DeepClone()
                changed["uuid"] = JsonValue.Create(Guid.NewGuid().ToString("D"))
                let data = changed["metadata"] ?? throw Exception("Missing metadata")
                let prior = data["predecessor"] ?? throw Exception("Missing predecessor")
                switch mode {
                    case "missing-hash" {
                        data.AsObject().Remove("import_manifest_sha256")
                    }
                    case "donor" {
                        prior["donor_id"] = JsonValue.Create(124)
                    }
                    case "lineage" {
                        prior["state_sha"] = JsonValue.Create(Check.Text(test.State()["sha"]))
                    }
                    case "same-attempt" {
                        prior["attempt"] = data["attempt"]?.DeepClone()
                    }
                    case "external" {
                        data["source"] = JsonValue.Create("external")
                    }
                }
                test.Coordinate(test.Event(changed), 1)
                test.Flow.NoPr()
            }
            test.Coordinate(test.Event(request))
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            test.Flow.Reload()
            let body = Check.Text(test.Flow.State["pulls"]?[0]?["body"])
            Check.Contains(
                body,
                "Fresh v2 attempt seeded from unpublished interrupted attempt " + Check.Text(Read(source)["attempt"])
            )
            Check.Contains(body, "not retroactively successful")
            for key in[]string{"predecessor", "import_manifest_sha256", "attempt"} {
                let receiptStart = body.IndexOf("<!-- tokate-receipt:") + "<!-- tokate-receipt:".Length
                let receiptEnd = body.IndexOf(" -->", receiptStart)
                let receipt = Check.Json(body.Substring(receiptStart, receiptEnd - receiptStart))
                receipt.AsObject().Remove(key)
                test.Flow.Reload()
                let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing pull")
                pull["body"] = JsonValue.Create(
                    body.Substring(0, receiptStart) + receipt.ToJsonString() + body.Substring(receiptEnd)
                )
                test.Flow.Save()
                test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
            }
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing pull")
            pull["body"] = JsonValue.Create(body)
            test.Flow.Save()
            test.Lifecycle("pause")
            test.Lifecycle("resume")
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        }

        private func Refusals(binary string) {
            using let test = CoordinationFlow(binary)
            let source = Setup(test)
            Prepare(test, Args(test, source), 1)
            FreshAttempt(test)
            {
                using let active = File.Open(
                    Path.Combine(source, ".lock"),
                    FileMode.Open,
                    FileAccess.ReadWrite,
                    FileShare.None
                )
                Prepare(test, Args(test, source), 1)
            }
            using let baseline = FixtureSnapshot(test.Flow.Temp.Root)
            for mode in[]string{
                "completed",
                "external",
                "publication",
                "pending",
                "generated",
                "donor",
                "repository",
                "issue",
                "approval",
                "base",
                "identity",
                "same-attempt",
                "lineage",
                "revoked",
                "task-changed",
                "denied",
                "expired",
                "paused",
                "reapproved",
                "legacy",
                "selection"
            } {
                baseline.Restore()
                test.Flow.Reload()
                let run = Read(source)
                switch mode {
                    case "completed" {
                        run["turn_completed"] = JsonValue.Create(true)
                    }
                    case "external" {
                        run["source"] = JsonValue.Create("external")
                    }
                    case "publication" {
                        run["commit"] = JsonValue.Create(String('a', 40))
                    }
                    case "pending" {
                        File.WriteAllText(Path.Combine(source, "publication.json"), "{}")
                    }
                    case "generated" {
                        run["state"] = JsonValue.Create("generated")
                    }
                    case "donor" {
                        run["donor_id"] = JsonValue.Create(124)
                    }
                    case "repository" {
                        run["preparation_repo_id"] = JsonValue.Create(999)
                    }
                    case "issue" {
                        run["issue"] = JsonValue.Create(2)
                    }
                    case "approval" {
                        run["approval"] = JsonValue.Create(String('a', 64))
                    }
                    case "base" {
                        run["base"] = JsonValue.Create(String('a', 40))
                    }
                    case "identity" {
                        run["id"] = JsonValue.Create(Guid.NewGuid().ToString("D"))
                    }
                    case "same-attempt" {
                        run["attempt"] = test.State()["state"]?["reservation"]?["attempt"]?.DeepClone()
                    }
                    case "lineage" {
                        run["state_sha"] = test.State()["sha"]?.DeepClone()
                    }
                    case "revoked" {
                        test.Flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                    }
                    case "task-changed" {
                        let issue = test.Flow.State["issue"] ?? throw Exception("Missing issue")
                        issue["body"] = JsonValue.Create("Changed approved scope")
                        test.Flow.Save()
                    }
                    case "denied" {
                        test.Flow.Call(
                            []string{"access", "--repo", "owner/project", "--operation", "deny", "--donor", "donor"},
                            owner: true
                        )
                    }
                    case "expired" {
                        test.Expire()
                    }
                    case "paused" {
                        test.Lifecycle("pause")
                    }
                    case "reapproved" {
                        test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
                        test.Coordinate(test.Event(test.ClaimRequest()))
                    }
                    case "legacy" {
                        let state = test.State()["state"] ?? throw Exception("Missing state")
                        state.AsObject().Remove("identity")
                        test.RewriteState(state)
                    }
                    case "selection" {
                        run["effort"] = JsonValue.Create("xhigh")
                    }
                }
                Save(source, run)
                let sourceBytes = Bytes(source)
                let revision = Check.Text(test.State()["sha"])
                Prepare(test, Args(test, source), 1)
                Check.That(Check.Text(test.State()["sha"]) == revision, "Refused continuation changed coordination")
                Check.That(
                    Directory.GetDirectories(Path.Combine(test.Flow.Temp.Root, "runs")).Length == 1,
                    "Refused continuation created a destination"
                )
                Preserved(source, sourceBytes)
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
        }

        private func Budget(binary string) {
            using let test = CoordinationFlow(binary)
            let source = Setup(test)
            FreshAttempt(test)
            let before = Check.Text(test.State()["sha"])
            for mode in[]string{
                "seconds",
                "verification-reserve",
                "zero",
                "equal",
                "consent",
                "selection",
                "external",
                "claim",
                "store"
            } {
                let args = List[string](Args(test, source, consent: mode != "consent"))
                switch mode {
                    case "seconds" {
                        args.RemoveRange(args.IndexOf("--seconds"), 2)
                    }
                    case "verification-reserve" {
                        args.RemoveRange(args.IndexOf("--verification-reserve"), 2)
                    }
                    case "zero" {
                        args[args.IndexOf("--verification-reserve") + 1] = "0"
                    }
                    case "equal" {
                        args[args.IndexOf("--verification-reserve") + 1] = "40"
                    }
                    case "selection" {
                        args[args.IndexOf("--effort") + 1] = "xhigh"
                    }
                    case "external" {
                        args[args.IndexOf("--source") + 1] = "external"
                    }
                    case "store" {
                        let other = Path.Combine(test.Flow.Temp.Root, "other-runs")
                        Directory.CreateDirectory(other)
                        args[args.IndexOf("--runs") + 1] = other
                    }
                    case "claim" {
                        test.Flow.Call(
                            []string{
                                "claim",
                                "--repo",
                                "owner/project",
                                "--issue",
                                "1",
                                "--continue-from",
                                source,
                                "--seconds",
                                "40",
                                "--verification-reserve",
                                "12"
                            },
                            1
                        )
                        continue
                    }
                }
                test.Flow.Call(args.ToArray(), 1)
                Check.That(
                    Directory.GetDirectories(Path.Combine(test.Flow.Temp.Root, "runs")).Length == 1,
                    "Budget or consent refusal prepared work"
                )
            }
            Check.That(Check.Text(test.State()["sha"]) == before, "Budget refusal acquired or renewed authority")
            test.Flow.NoInference()
            test.Flow.NoPr()
        }

        private func Interruptions(binary string) {
            using let test = CoordinationFlow(binary)
            let source = Setup(test)
            FreshAttempt(test)
            let state = Check.Text(test.State()["sha"])
            let args = Args(test, source)
            test.Flow.Reload()
            test.Flow.State["preparation_interrupt"] = JsonValue.Create("fetch")
            test.Flow.Save()
            Prepare(test, args, 1)
            let fresh = Path.Combine(
                test.Flow.Temp.Root,
                "runs",
                Check.Text(test.State()["state"]?["reservation"]?["attempt"])
            )
            Check.That(
                Check.Text(Read(fresh)["continuation_phase"]) == "captured",
                "Interrupted preparation lost capture evidence"
            )
            test.Flow.Call([]string{"prepare", "--run", fresh})
            test.Flow.Call([]string{"prepare", "--run", fresh})
            let sourceBytes = Bytes(source)
            using let baseline = FixtureSnapshot(test.Flow.Temp.Root)
            for mode in[]string{
                "partial",
                "write",
                "capture",
                "target-hardlink",
                "capture-hardlink",
                "dirty",
                "metadata",
                "events",
                "source-edit",
                "manifest",
                "same-attempt",
                "execution"
            } {
                baseline.Restore()
                test.Flow.Reload()
                let saved = Read(fresh)
                saved["state"] = JsonValue.Create("preparing")
                if mode == "capture" || mode == "capture-hardlink" {
                    saved.AsObject().Remove("continuation_phase")
                    saved.AsObject().Remove("continuation_manifest_sha256")
                    test.Flow.Git("-C", Path.Combine(fresh, "checkout"), "restore", "tracked.txt")
                    File.Delete(Path.Combine(fresh, "checkout/imported.txt"))
                    if mode == "capture-hardlink" {
                        File.Delete(Path.Combine(fresh, "continuation.json"))
                        let peer = Path.Combine(test.Flow.Temp.Root, "capture-peer")
                        File.WriteAllText(peer, "preserve synthetic peer")
                        Check.Success(
                            TestProcess.Run(
                                "/usr/bin/ln",
                                []string{peer, Path.Combine(fresh, "continuation.json.tmp")},
                                test.Flow.Temp.Env
                            )
                        )
                    }
                } else if mode == "target-hardlink" {
                    saved["continuation_phase"] = JsonValue.Create("importing")
                    let peer = Path.Combine(test.Flow.Temp.Root, "linked-peer")
                    File.WriteAllText(peer, "approved\n")
                    File.Delete(Path.Combine(fresh, "checkout/tracked.txt"))
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/ln",
                            []string{peer, Path.Combine(fresh, "checkout/tracked.txt")},
                            test.Flow.Temp.Env
                        )
                    )
                } else if mode == "partial" || mode == "write" {
                    saved["continuation_phase"] = JsonValue.Create("importing")
                    File.Delete(Path.Combine(fresh, "checkout/imported.txt"))
                    if mode == "write" {
                        saved["continuation_pending"] = JsonValue.Create("tracked.txt")
                        File.WriteAllText(Path.Combine(fresh, "continuation-write.tmp"), "preser")
                        test.Flow.Git("-C", Path.Combine(fresh, "checkout"), "restore", "tracked.txt")
                    }
                } else if mode == "dirty" {
                    File.WriteAllText(Path.Combine(fresh, "checkout/unrelated.txt"), "preserve unrelated edits")
                } else if mode == "metadata" {
                    File.AppendAllText(Path.Combine(source, "run.json"), " ")
                } else if mode == "events" {
                    File.AppendAllText(Path.Combine(source, "events.jsonl"), " changed")
                } else if mode == "source-edit" {
                    File.AppendAllText(Path.Combine(source, "checkout/imported.txt"), "changed\n")
                } else if mode == "manifest" {
                    File.AppendAllText(Path.Combine(fresh, "continuation.json"), " ")
                } else if mode == "same-attempt" {
                    saved["attempt"] = Read(source)["attempt"]?.DeepClone()
                } else if mode == "execution" {
                    saved["state"] = JsonValue.Create("claimed")
                    saved["codex_version"] = JsonValue.Create("fixture-already-executed")
                }
                Save(fresh, saved)
                let rejected = mode != "partial" && mode != "write" && mode != "capture"
                let targetBytes = Bytes(Path.Combine(fresh, "checkout"))
                test.Flow.Call([]string{"prepare", "--run", fresh}, rejected ? 1: 0)
                if rejected {
                    if mode == "target-hardlink" || mode == "capture-hardlink" {
                        let peer = Path.Combine(
                            test.Flow.Temp.Root,
                            mode == "target-hardlink" ? "linked-peer": "capture-peer"
                        )
                        Check.That(
                            File.ReadAllText(peer) == (
                                mode == "target-hardlink" ? "approved\n": "preserve synthetic peer"
                            ),
                            "Continuation wrote through an external hardlink"
                        )
                    }
                    Preserved(Path.Combine(fresh, "checkout"), targetBytes)
                    test.Flow.Call([]string{"work", "--run", fresh, "--yes"}, 1)
                } else {
                    test.Flow.Call([]string{"prepare", "--run", fresh})
                    Check.That(
                        File.ReadAllText(Path.Combine(fresh, "checkout/tracked.txt")) == "preserved\n" &&
                            File.ReadAllText(Path.Combine(fresh, "checkout/imported.txt")) == "untracked\n",
                        "Interrupted import did not converge to captured content"
                    )
                    Check.That(
                        !File.Exists(Path.Combine(fresh, "continuation-write.tmp")),
                        "Interrupted import left a pending write"
                    )
                    Preserved(source, sourceBytes)
                }
                Check.That(Check.Text(test.State()["sha"]) == state, "Interrupted preparation acquired new authority")
                Check.That(
                    Directory.GetDirectories(Path.Combine(test.Flow.Temp.Root, "runs")).Length == 2,
                    "Preparation duplicated a destination attempt"
                )
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
        }

        private func ImportBoundary(binary string) {
            using let test = CoordinationFlow(binary)
            let source = Setup(test)
            FreshAttempt(test)
            using let baseline = FixtureSnapshot(test.Flow.Temp.Root)
            for mode in[]string{
                "supported",
                "protected",
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
                "restored-worktree",
                "missing-staged-addition",
                "changed-head",
                "hooks",
                "generated-fifo",
                "staged-conflict",
                "excluded",
                "empty"
            } {
                baseline.Restore()
                test.Flow.Reload()
                let checkout = Path.Combine(source, "checkout")
                let rejected = mode != "supported" && mode != "excluded" && mode != "empty"
                if mode == "supported" {
                    File.Delete(Path.Combine(checkout, "baseline.txt"))
                    File.SetUnixFileMode(
                        Path.Combine(checkout, "tracked.txt"),
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    )
                    test.Flow.Git("-C", checkout, "add", "tracked.txt", "imported.txt", "baseline.txt")
                    File.WriteAllBytes(Path.Combine(checkout, "binary.dat"), []byte{0, 255, 10, 0})
                } else if mode == "protected" {
                    Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
                    File.WriteAllText(Path.Combine(checkout, ".github/workflows/owner.yml"), "protected")
                } else if mode == "symlink" {
                    File.CreateSymbolicLink(Path.Combine(checkout, "unsafe"), Path.Combine(source, "run.json"))
                } else if mode == "hardlink" {
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/ln",
                            []string{Path.Combine(source, "run.json"), Path.Combine(checkout, "unsafe")},
                            test.Flow.Temp.Env
                        )
                    )
                } else if mode == "fifo" {
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/mkfifo",
                            []string{Path.Combine(checkout, "unsafe")},
                            test.Flow.Temp.Env
                        )
                    )
                } else if mode == "staged-conflict" {
                    test.Flow.Git("-C", checkout, "add", "tracked.txt")
                    File.WriteAllText(Path.Combine(checkout, "tracked.txt"), "conflicting evidence\n")
                } else if mode == "unchanged-hardlink" {
                    let peer = Path.Combine(test.Flow.Temp.Root, "linked-peer")
                    File.WriteAllText(peer, "baseline\n")
                    File.Delete(Path.Combine(checkout, "baseline.txt"))
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/ln",
                            []string{peer, Path.Combine(checkout, "baseline.txt")},
                            test.Flow.Temp.Env
                        )
                    )
                } else if mode == "tracked-fifo" {
                    File.Delete(Path.Combine(checkout, "tracked.txt"))
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/mkfifo",
                            []string{Path.Combine(checkout, "tracked.txt")},
                            test.Flow.Temp.Env
                        )
                    )
                } else if mode == "directory-file" {
                    Directory.Delete(Path.Combine(checkout, "folder"), true)
                    File.WriteAllText(Path.Combine(checkout, "folder"), "replacement\n")
                } else if mode == "file-directory" {
                    File.Delete(Path.Combine(checkout, "baseline.txt"))
                    Directory.CreateDirectory(Path.Combine(checkout, "baseline.txt"))
                    File.WriteAllText(Path.Combine(checkout, "baseline.txt/child"), "replacement\n")
                } else if mode == "source-repo-id" || mode == "source-head-id" || mode == "missing-source-id" {
                    let saved = Read(source)
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
                    Save(source, saved)
                    File.WriteAllText(markerPath, marker.ToJsonString())
                } else if mode == "unsafe-path" {
                    File.WriteAllText(Path.Combine(checkout, "unsafe\nname"), "unsafe")
                } else if mode == "restored-worktree" {
                    test.Flow.Git("-C", checkout, "add", "tracked.txt")
                    File.WriteAllText(Path.Combine(checkout, "tracked.txt"), "approved\n")
                } else if mode == "missing-staged-addition" {
                    test.Flow.Git("-C", checkout, "add", "imported.txt")
                    File.Delete(Path.Combine(checkout, "imported.txt"))
                } else if mode == "changed-head" {
                    test.Flow.Git("-C", checkout, "checkout", "--quiet", "-b", "unrelated")
                } else if mode == "hooks" {
                    Directory.CreateDirectory(Path.Combine(checkout, ".git/hooks"))
                    File.WriteAllText(Path.Combine(checkout, ".git/hooks/pre-commit"), "untrusted")
                } else if mode == "generated-fifo" {
                    Directory.CreateDirectory(Path.Combine(checkout, ".verification-data"))
                    let cache = Path.Combine(checkout, ".verification-data/private")
                    File.WriteAllText(cache, "source-only output")
                    test.Flow.Git("-C", checkout, "add", ".verification-data/private")
                    File.Delete(cache)
                    Check.Success(TestProcess.Run("/usr/bin/mkfifo", []string{cache}, test.Flow.Temp.Env))
                } else if mode == "excluded" {
                    Directory.CreateSymbolicLink(
                        Path.Combine(checkout, ".verification-data"),
                        Path.Combine(test.Flow.Temp.Root, "home")
                    )
                    for name in[]string{".env", ".ENV", ".npmrc"} {
                        File.WriteAllText(Path.Combine(checkout, name), "synthetic credential")
                    }
                } else if mode == "empty" {
                    test.Flow.Git("-C", checkout, "restore", "tracked.txt")
                    File.Delete(Path.Combine(checkout, "imported.txt"))
                }
                let bytes Dictionary[string, string]? = mode.Contains("fifo") ? nil: Bytes(source)
                let args = Args(test, source)
                let fresh = Prepare(test, args, rejected ? 1: 0)
                if !rejected {
                    Check.That(
                        !File.Exists(Path.Combine(fresh, "checkout/.env")) && !File.Exists(
                            Path.Combine(fresh, "checkout/.ENV")
                        ) &&
                            !File.Exists(Path.Combine(fresh, "checkout/.npmrc")) && !Directory.Exists(
                            Path.Combine(fresh, "checkout/.verification-data")
                        ),
                        "Continuation imported excluded data"
                    )
                    if mode == "supported" {
                        Check.That(
                            !File.Exists(Path.Combine(fresh, "checkout/baseline.txt")),
                            "Import lost a captured deletion"
                        )
                        Check.That(
                            (
                                File.GetUnixFileMode(
                                    Path.Combine(fresh, "checkout/tracked.txt")
                                ) & UnixFileMode.UserExecute
                            ) != 0,
                            "Import lost executable mode"
                        )
                        Check.That(
                            Check.Hash(Path.Combine(fresh, "checkout/binary.dat")) == Check.Hash(
                                Path.Combine(checkout, "binary.dat")
                            ),
                            "Import changed binary content"
                        )
                    }
                }
                if let original = bytes {
                    Preserved(source, original)
                }
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
        }

        internal func All(binary string, selected string = "") {
            for test in[]TestCase[string]{
                TestCase[string]("Timeout", async (value string) -> Flow(value, "timeout")),
                TestCase[string]("Crash", async (value string) -> Flow(value, "crash")),
                TestCase[string]("Cancel", async (value string) -> Flow(value, "cancel")),
                TestCase[string]("Failure", async (value string) -> Flow(value, "incomplete_turn")),
                TestCase[string]("Pi", async (value string) -> Flow(value, "timeout", "pi")),
                TestCase[string]("Refusals", async (value string) -> Refusals(value)),
                TestCase[string]("Budget", async (value string) -> Budget(value)),
                TestCase[string]("Interruptions", async (value string) -> Interruptions(value)),
                TestCase[string]("ImportBoundary", async (value string) -> ImportBoundary(value))
            } {
                let name = test.Name
                if selected != "" && selected != name || selected == "" && !CiShard.Include("Continuation/" + name) {
                    continue
                }
                test.Run(binary)
                Console.WriteLine("PASS continuation " + name)
            }
        }
    }
}
