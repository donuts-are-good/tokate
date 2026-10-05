package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class AmendmentFlow {
    shared {
        private func Saved(run string) JsonNode -> Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))

        private func Amend(
            flow NativeFixture,
            run string,
            commit string,
            code int32 = 0,
            tools string = "",
            owner bool = false
        ) Result {
            let args = List[string]{"amend", "--run", run, "--commit", commit, "--seconds", "30"}
            if tools != "" {
                args.AddRange([]string{"--tools", tools})
            }
            return flow.Call(args.ToArray(), code, owner: owner)
        }

        private func Edit(
            flow NativeFixture,
            run string,
            text string = "Reviewed correction\n",
            file string = "result.txt"
        ) string {
            let checkout = Path.Combine(run, "checkout")
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(checkout, file)) ?? checkout)
            File.WriteAllText(Path.Combine(checkout, file), text)
            flow.Git("-C", checkout, "add", "-A")
            flow.Git(
                "-C",
                checkout,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
                "commit",
                "-m",
                "Review correction"
            )
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        private func Review(flow NativeFixture, legacy bool = false) {
            flow.Reload()
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing review PR")
            var body = Check.Text(pull["body"])
            if legacy {
                let start = body.IndexOf("<!-- tokate-report:start -->", StringComparison.Ordinal)
                let end = body.IndexOf("<!-- tokate-report:end -->", StringComparison.Ordinal)
                if body.Contains("<!-- tokate-run:") {
                    body = body.Remove(start, end + "<!-- tokate-report:end -->".Length - start).Insert(
                        start,
                        "Generated a patch for the approved issue. Independent owner verification: 2/2 checks passed.\n\nReview the changes against the issue\'s acceptance criteria and limitations."
                    )
                }
            }
            pull["body"] = JsonValue.Create("Owner review before\n" + body + "\nOwner review after")
            flow.Save()
        }

        private func AssertOriginal(run string, original string) {
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/run.json")) == original,
                "Original run evidence changed"
            )
            let before = Check.Json(original)
            let after = Saved(run)
            for field in[]string{
                "version",
                "approval",
                "model",
                "effort",
                "seconds",
                "usage",
                "elapsed_seconds",
                "source",
                "tools",
                "verification"
            } {
                Check.That(
                    Check.Text(before[field]) == Check.Text(after[field]),
                    "Original field reinterpreted: " + field
                )
            }
            for file in[]string{
                "events.jsonl",
                "changes.patch",
                "verification.json",
                "pr-body.md",
                "publication.json"
            } {
                if File.Exists(Path.Combine(run, file)) {
                    Check.That(
                        File.ReadAllText(Path.Combine(run, file)) == File.ReadAllText(
                            Path.Combine(run, "original-evidence", file)
                        ),
                        "Original evidence overwritten: " + file
                    )
                }
            }
        }

        private func AssertPublished(flow NativeFixture, run string, commit string, owner bool = false) {
            Check.That(Check.Text(Saved(run)["commit"]) == commit, "Saved amendment head differs")
            flow.Reload()
            Check.That(flow.State["pulls"]?.AsArray().Count == 1, "Amendment duplicated PR")
            let body = Check.Text(flow.State["pulls"]?[0]?["body"])
            Check.Contains(body, "Owner review before")
            Check.Contains(body, "Owner review after")
            Check.Contains(body, "cover original work only")
            Check.Contains(body, commit)
            Check.That(!body.Contains("synthetic-raw-"), "Detailed evidence was published")
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: owner)
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\",\"state\":\"SUCCESS\"}]")
            flow.Save()
            flow.Call([]string{"checks", "--run", run}, owner: owner)
            Check.That(
                Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "checks.json")))["head"]) == commit,
                "Owner checks were not bound to amendment"
            )
        }

        private func InterruptedVerification(binary string) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow, interruptible: true)
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let commit = Edit(flow, run, "slow-check", "slow")
            let args = []string{"amend", "--run", run, "--commit", commit, "--seconds", "1", "--json"}
            let failure = flow.Call(args, 1)
            Check.That(
                Check.Text(Check.Json(failure.Output)["error"]?["code"]) == "verification_failed",
                "Amendment interruption lost its structured failure classification"
            )
            Check.That(
                !(failure.Output + failure.Error).Contains("synthetic-amendment"),
                "Raw amendment output escaped"
            )
            let location = Path.Combine(run, "amendments", commit)
            let saved = Saved(location)
            Check.That(Check.Text(saved["state"]) == "failed", "Amendment failure state lost")
            Check.That(Check.Text(saved["failure_reason"]) == "verification_failed", "Amendment failure reason lost")
            Check.That(saved["verification"]?.AsArray().Count == 2, "Amendment prior or active check lost")
            Check.That(Check.Text(saved["verification"]?[0]?["exit_code"]) == "0", "Amendment prior pass lost")
            Check.That(saved["verification"]?[1]?["exit_code"] == nil, "Interrupted amendment fabricated exit code")
            Check.Contains(Check.Text(saved["verification"]?[1]?["output"]), "synthetic-amendment-prefix")
            Check.Contains(Check.Text(saved["verification"]?[1]?["error"]), "synthetic-amendment-error")
            let evidence = File.ReadAllText(Path.Combine(location, "run.json"))
            flow.Call(args, 1)
            Check.That(
                File.ReadAllText(Path.Combine(location, "run.json")) == evidence,
                "Interrupted amendment retried checks"
            )
            AssertOriginal(run, original)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Amendment launched inference")
            Check.That(
                Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"]) == Check.Text(Check.Json(original)["commit"]),
                "Failed amendment changed remote PR"
            )
        }

        private func V1(binary string, owner bool = false) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow, owner)
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            Review(flow, true)
            let commit = Edit(flow, run)
            Amend(flow, run, commit, owner: owner)
            let amended = Saved(Path.Combine(run, "amendments", commit))
            Check.That(
                Check.Text(amended["seconds"]) == "30" && Check.Text(Check.Json(original)["seconds"]) == "20",
                "Amendment budget was not separate from original execution"
            )
            Check.That(
                amended["verification"]?.AsArray().Count == 2,
                "Amendment did not run every original owner command"
            )
            AssertOriginal(run, original)
            AssertPublished(flow, run, commit, owner)
            flow.Reload()
            let pushes = Check.Text(flow.State["git_pushes"])
            flow.ResetTraffic()
            Amend(flow, run, commit, owner: owner)
            flow.Reload()
            Check.That(Check.Text(flow.State["git_pushes"]) == pushes, "Repeated applied amendment push")
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Repeated applied amendment body write")
            }
            Check.That(flow.State["exec_count"]?.ToString() == "1", "Amendment repeated inference")
            let tools = Path.Combine(flow.Temp.Root, "amend-tools.json")
            File.WriteAllText(
                tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\",\"coding_seconds\":12,\"usage\":{\"output_tokens\":9}}]"
            )
            let second = Edit(flow, run, "Second review correction\n")
            Amend(flow, run, second, tools: tools, owner: owner)
            AssertOriginal(run, original)
            AssertPublished(flow, run, second, owner)
            Check.That(Saved(run)["amendments"]?.AsArray().Count == 2, "Missing amendment history")
            flow.Reload()
            Check.Contains(Check.Text(flow.State["pulls"]?[0]?["body"]), "donor-reported tools")
        }

        private func V1Interrupted(binary string, mode string) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow)
            Review(flow)
            let commit = Edit(flow, run)
            flow.Mode(mode)
            Amend(flow, run, commit, 1)
            Check.That(
                File.Exists(Path.Combine(run, "amendments", commit, "publication.json")),
                "Publication intent lost"
            )
            flow.Mode("")
            Review(flow)
            flow.Reload()
            let pushes = Check.Text(flow.State["git_pushes"])
            flow.ResetTraffic()
            Amend(flow, run, commit)
            flow.Reload()
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                if mode == "lost_body_response" {
                    Check.That(Check.Text(call["method"]) != "PATCH", "Repeated applied body write")
                }
            }
            Check.That(Check.Text(flow.State["git_pushes"]) == pushes, "Interrupted response repeated an applied push")
            AssertPublished(flow, run, commit)
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Recovery repeated inference")
        }

        private func Rejections(binary string) {
            using let original = PublishedContribution.Create(binary)
            using let mutating = PublishedContribution.Create(binary, mutating: true)
            for failure in[]string{
                "checks",
                "protected",
                "protected-unicode",
                "protected-template",
                "hidden-index",
                "dirty",
                "changed-head",
                "remote",
                "issue",
                "revoked",
                "superseded",
                "tools",
                "budget",
                "mutating-check",
                "closed",
                "merged"
            } {
                let preparation = failure == "mutating-check" ? mutating: original
                preparation.Restore()
                let flow = preparation.Coordination.Flow
                let run = preparation.Run
                let before = Check.Text(Saved(run)["commit"])
                let commit = Edit(
                    flow,
                    run,
                    failure == "checks" ? "": "Reviewed\n",
                    failure == "protected" ? ".github/workflows/review.yml":
                    failure == "protected-unicode" ? ".github/workflows/é.yml":
                    failure == "protected-template" ? ".github/tokate-pr.md": "result.txt"
                )
                var tools string = ""
                if failure == "hidden-index" {
                    flow.Git("-C", Path.Combine(run, "checkout"), "update-index", "--assume-unchanged", "result.txt")
                    File.AppendAllText(Path.Combine(run, "checkout/result.txt"), "Hidden edit")
                } else if failure == "dirty" {
                    File.AppendAllText(Path.Combine(run, "checkout/result.txt"), "Dirty")
                } else if failure == "changed-head" {
                    Edit(flow, run, "Different head\n")
                } else if failure == "remote" {
                    flow.Git(
                        "-C",
                        Path.Combine(run, "checkout"),
                        "push",
                        Path.Combine(flow.Bin, "fork"),
                        "HEAD:refs/heads/" + Check.Text(Saved(run)["branch"])
                    )
                } else if failure == "issue" || failure == "revoked" {
                    flow.Reload()
                    let issue = flow.State["issue"] ?? throw Exception("Missing issue")
                    if failure == "issue" {
                        issue["body"] = JsonValue.Create("Changed acceptance")
                    } else {
                        issue["labels"] = JsonArray()
                    }
                    flow.Save()
                } else if failure == "superseded" {
                    flow.Approve()
                } else if failure == "tools" {
                    tools = Path.Combine(flow.Temp.Root, "bad-tools.json")
                    File.WriteAllText(
                        tools,
                        "[{\"harness\":\"claude\",\"provider\":\"anthropic\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
                    )
                } else if failure == "budget" {
                    flow.Call([]string{"amend", "--run", run, "--commit", commit, "--seconds", "3601"}, 1)
                    continue
                } else if failure == "closed" || failure == "merged" {
                    flow.Reload()
                    let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                    pull[failure == "closed" ? "state": "merged"] = failure == "closed" ? JsonValue.Create(
                        "closed"
                    ): JsonValue.Create(true)
                    flow.Save()
                } else if failure == "mutating-check" {
                    let amended = Edit(flow, run, "Trigger candidate mutation", "mutate")
                    Amend(flow, run, amended, 1)
                    Check.Contains(
                        Check.Text(Saved(Path.Combine(run, "amendments", amended))["error"]),
                        "clean checkout"
                    )
                    continue
                }
                Amend(flow, run, commit, 1, tools)
                Check.That(Check.Text(Saved(run)["commit"]) == before, "Rejected amendment changed saved publication")
                Check.That(Directory.Exists(Path.Combine(run, "checkout")), "Rejected amendment deleted checkout")
                if failure == "checks" {
                    let saved = Saved(Path.Combine(run, "amendments", commit))
                    Check.That(Check.Text(saved["state"]) == "failed", "Failed verification lost evidence")
                    Check.That(
                        Check.Text(saved["verification"]?[1]?["exit_code"]) != "0",
                        "Failed amendment accepted verification"
                    )
                    Amend(flow, run, commit, 1)
                }
            }
        }

        private func V2(binary string, mode string = "", native bool = false, modelPolicy string = "") {
            using let flow = CoordinationFixture(binary)
            let run = PublishedContribution.V2Original(flow, native, modelPolicy)
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let contribution = Check.Text(flow.State()["state"]?["contribution"])
            Review(flow.Flow, true)
            let commit = Edit(flow.Flow, run)
            if modelPolicy != "" {
                File.WriteAllText(
                    flow.Tools,
                    "[{\"harness\":\"claude\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"effort\":\"absent\"}]"
                )
            }
            let tools = native && modelPolicy == "" ? "": flow.Tools
            if mode == "lost_push_response" || mode == "lost_request_response" {
                flow.Flow.Mode(mode)
                Amend(flow.Flow, run, commit, mode == "lost_request_response" ? 0: 1, tools)
                flow.Flow.Mode("")
            }
            Amend(flow.Flow, run, commit, tools: tools)
            flow.Flow.Reload()
            let request = Check.PostedRequest(flow.Flow.State)
            Check.That(Check.Text(request["action"]) == "amend", "Wrong amendment request")
            Check.That(
                Check.Text(request["expected"]) != Check.Text(Saved(run)["state_sha"]),
                "Amend used stale original reservation revision"
            )
            Check.That(
                flow.Flow.State["request_comments"]?.AsArray().Count == 2,
                "Amendment repeated an applied request comment"
            )
            let path = flow.Event(request)
            if mode == "lost_body_response" || mode == "lost_state_response" || mode == "interrupted_state_write" {
                flow.Flow.Mode(mode)
                flow.Coordinate(path, 1)
                flow.Flow.Call(
                    []string{"verify-pr", "--repo", "owner/project", "--pr", "10"},
                    mode == "lost_state_response" ? 0: 1
                )
                flow.Flow.Mode("")
            }
            flow.Flow.ResetTraffic()
            flow.Coordinate(path)
            flow.Flow.Reload()
            if mode == "lost_body_response" || mode == "lost_state_response" || mode == "interrupted_state_write" {
                for call in flow.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    Check.That(
                        !(Check.Text(call["method"]) == "PATCH" && Check.Text(call["path"]).Contains("/pulls/")),
                        "Interrupted response repeated an applied body update"
                    )
                }
            }
            flow.Flow.ResetTraffic()
            flow.Coordinate(path)
            flow.Flow.Reload()
            for call in flow.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Applied amendment request repeated writes")
            }
            Amend(flow.Flow, run, commit, tools: tools)
            AssertOriginal(run, original)
            AssertPublished(flow.Flow, run, commit)
            Check.That(
                Check.Text(flow.State()["state"]?["contribution"]) == contribution,
                "V2 original contribution reinterpreted"
            )
            Check.That(flow.State()["state"]?["amendments"]?.AsArray().Count == 1, "V2 history missing")
            if mode == "" {
                let second = Edit(flow.Flow, run, "Second v2 correction\n")
                Amend(flow.Flow, run, second)
                flow.Flow.Reload()
                let nextRequest = Check.PostedRequest(flow.Flow.State)
                flow.Coordinate(flow.Event(nextRequest))
                Amend(flow.Flow, run, second)
                AssertPublished(flow.Flow, run, second)
                let current = Check.Envelope(
                    flow.Flow.Call([]string{"coordination", "--repo", "owner/project", "--issue", "1", "--json"}),
                    "coordination",
                    "ok"
                )
                Check.That(
                    Check.Text(current["data"]?["contribution"]?["head"]) == second,
                    "Structured coordination omitted current amended head"
                )
                Check.That(
                    flow.State()["state"]?["amendments"]?.AsArray().Count == 2,
                    "V2 continuation lost prior amendment"
                )
                Check.That(
                    Check.Text(flow.State()["state"]?["contribution"]) == contribution,
                    "V2 continuation changed original contribution"
                )
            }
            if native {
                Check.That(Check.Text(flow.Flow.State["exec_count"]) == "1", "Native amendment repeated inference")
            } else {
                flow.Flow.NoInference()
            }
        }

        private func V2Stale(binary string) {
            using let preparation = PublishedContribution.Create(binary, v2: true)
            for failure in[]string{
                "expired",
                "superseded",
                "remote",
                "revoked-after-push",
                "stale-state",
                "expired-after-checks",
                "body-edited",
                "report-edited"
            } {
                preparation.Restore()
                let flow = preparation.Coordination
                let run = preparation.Run
                let commit = Edit(flow.Flow, run)
                if failure == "expired" {
                    flow.Expire()
                } else if failure == "superseded" {
                    flow.Flow.Approve()
                } else if failure == "remote" {
                    flow.Flow.Git(
                        "-C",
                        Path.Combine(run, "checkout"),
                        "push",
                        Path.Combine(flow.Flow.Bin, "fork"),
                        "HEAD:refs/heads/" + Check.Text(Saved(run)["branch"])
                    )
                } else if failure == "revoked-after-push" {
                    flow.Flow.Mode("revoke_after_push")
                }
                if failure == "stale-state" ||
                    failure == "body-edited" ||
                    failure == "expired-after-checks" ||
                    failure == "report-edited" {
                    Amend(flow.Flow, run, commit)
                    flow.Flow.Reload()
                    let request = Check.PostedRequest(flow.Flow.State)
                    if failure == "expired-after-checks" {
                        flow.Expire()
                    } else if failure == "stale-state" {
                        flow.RewriteState(flow.State()["state"] ?? throw Exception("Missing state"))
                    } else {
                        let pull = flow.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                        pull["body"] = JsonValue.Create(
                            failure == "report-edited" ?
                            Check.Text(pull["body"]).Replace(
                                "coordinator did not observe execution.",
                                "Incorrect attribution."
                            ):
                            Check.Text(pull["body"]).Replace("tokate-receipt:", "edited-receipt:")
                        )
                        flow.Flow.Save()
                    }
                    flow.Coordinate(flow.Event(request), 1)
                    Amend(flow.Flow, run, commit, 1)
                } else {
                    Amend(flow.Flow, run, commit, 1)
                }
                Check.That(Directory.Exists(Path.Combine(run, "checkout")), "Stale amendment deleted progress")
                flow.Flow.NoInference()
            }
        }

        private func Structured(binary string) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow)
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let failedCommit = Edit(flow, run, "")
            let failed = Check.Envelope(
                flow.Call([]string{"amend", "--run", run, "--commit", failedCommit, "--seconds", "30", "--json"}, 1),
                "amend",
                "error",
                "verification_failed"
            )
            Check.That(
                Check.Text(failed["data"]?["amendment"]?["state"]) == "failed" && Check.Text(
                    failed["data"]?["amendment"]?["commit"]
                ) == failedCommit,
                "JSON amendment lost failed attempt"
            )
            let commit = Edit(flow, run)
            let published = Check.Envelope(
                flow.Call([]string{"amend", "--run", run, "--commit", commit, "--seconds", "30", "--json"}),
                "amend",
                "ok"
            )
            Check.That(
                Check.Text(published["data"]?["amendment"]?["state"]) == "published" && Check.Text(
                    published["data"]?["commit"]
                ) == commit,
                "JSON amendment lost published head"
            )
            AssertOriginal(run, original)
            flow.Reload()
            Check.That(
                Check.Text(flow.State["exec_count"]) == "1" && flow.State["pulls"]?.AsArray().Count == 1,
                "JSON amendment repeated inference or PR"
            )
            Check.Envelope(
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10", "--json"}, owner: true),
                "verify-pr",
                "ok"
            )
        }

        internal func All(binary string, only string = "") {
            var matched bool
            for name in[]string{
                "Structured",
                "V1",
                "V1Owner",
                "V1Push",
                "V1Body",
                "Rejections",
                "InterruptedVerification",
                "V2",
                "V2Absent",
                "V2Native",
                "V2Push",
                "V2Request",
                "V2Body",
                "V2State",
                "V2StateBefore",
                "V2Stale"
            } {
                if only != "" && only != name {
                    continue
                }
                matched = true
                switch name {
                    case "Structured" {
                        Structured(binary)
                    }
                    case "V1" {
                        V1(binary)
                    }
                    case "V1Owner" {
                        V1(binary, true)
                    }
                    case "V1Push" {
                        V1Interrupted(binary, "lost_push_response")
                    }
                    case "V1Body" {
                        V1Interrupted(binary, "lost_body_response")
                    }
                    case "InterruptedVerification" {
                        InterruptedVerification(binary)
                    }
                    case "Rejections" {
                        Rejections(binary)
                    }
                    case "V2" {
                        V2(binary)
                    }
                    case "V2Absent" {
                        for mode in[]string{"whitelist", "unrestricted"} {
                            V2(binary, "absent", native: true, modelPolicy: mode)
                        }
                    }
                    case "V2Native" {
                        V2(binary, native: true)
                    }
                    case "V2Push" {
                        V2(binary, "lost_push_response")
                    }
                    case "V2Request" {
                        V2(binary, "lost_request_response")
                    }
                    case "V2Body" {
                        V2(binary, "lost_body_response")
                    }
                    case "V2State" {
                        V2(binary, "lost_state_response")
                    }
                    case "V2StateBefore" {
                        V2(binary, "interrupted_state_write")
                    }
                    case "V2Stale" {
                        V2Stale(binary)
                    }
                }
                Console.WriteLine("PASS amendment " + name)
            }
            Check.That(matched, "Unknown amendment selector: " + only)
        }
    }
}
