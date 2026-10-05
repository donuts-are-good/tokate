package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes
import Tokate

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
            for check in Saved(Path.Combine(run, "original-evidence"))["verification"]?.AsArray() ?? JsonArray() {
                for field in[]string{"output_file", "error_file"} {
                    let relative = Check.Text(check[field])
                    Check.That(relative != "", "Original check lacks recorded evidence")
                    Check.That(
                        File
                            .ReadAllBytes(Path.Combine(run, relative))
                            .AsSpan()
                            .SequenceEqual(File.ReadAllBytes(Path.Combine(run, "original-evidence", relative))),
                        "Original verification artifact lost: " + relative
                    )
                }
            }
            Check.That(
                File.Exists(Path.Combine(run, "original-evidence/manifest.json")),
                "Original archive is unsealed"
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

        private func ArchiveRefusals(binary string) {
            using let prepared = PublishedContribution.Create(binary)
            let flow = prepared.Coordination.Flow
            let run = prepared.Run
            for fault in[]string{
                "record",
                "verification-directory",
                "verification-file",
                "broken-verification",
                "missing-verification",
                "archive-directory"
            } {
                prepared.Restore()
                let original = File.ReadAllText(Path.Combine(run, "run.json"))
                let commit = Edit(flow, run)
                let secret = Path.Combine(flow.Temp.Root, "outside-evidence")
                File.WriteAllText(secret, "synthetic private evidence")
                let evidence = Directory.GetDirectories(run, "verification-*")[0]
                switch fault {
                    case "record" {
                        let record = Path.Combine(run, "report.md")
                        File.Delete(record)
                        File.CreateSymbolicLink(record, secret)
                    }
                    case "verification-directory" {
                        Directory.Delete(evidence, true)
                        Directory.CreateSymbolicLink(evidence, flow.Temp.Root)
                    }
                    case "verification-file", "broken-verification" {
                        let output = Path.Combine(evidence, "stdout.log")
                        File.Delete(output)
                        File.CreateSymbolicLink(output, fault == "verification-file" ? secret: secret + "-missing")
                    }
                    case "missing-verification" {
                        File.Delete(Path.Combine(evidence, "stdout.log"))
                    }
                    case "archive-directory" {
                        Directory.CreateSymbolicLink(Path.Combine(run, "original-evidence"), flow.Temp.Root)
                    }
                }
                Amend(flow, run, commit, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "run.json")) == original,
                    "Linked evidence rewrote saved run"
                )
                Check.That(
                    !Directory.Exists(Path.Combine(run, "amendments", commit)),
                    "Linked evidence reached verification"
                )
                Check.That(
                    Directory.GetDirectories(run, "archive-*").Length == 0,
                    "Rejected archive left partial staging"
                )
                Check.That(File.ReadAllText(secret) == "synthetic private evidence", "Archive changed linked target")
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Archive refusal repeated inference")
            }
        }

        private func ArchiveIdentity(binary string) {
            using let first = PublishedContribution.Create(binary)
            using let second = PublishedContribution.Create(binary)
            let flow = first.Coordination.Flow
            let run = first.Run
            let commit = Edit(flow, run)
            Amend(flow, run, commit)
            let otherFlow = second.Coordination.Flow
            let otherRun = second.Run
            Amend(otherFlow, otherRun, Edit(otherFlow, otherRun))
            let archive = Path.Combine(run, "original-evidence")
            Directory.Delete(archive, true)
            Directory.Move(Path.Combine(otherRun, "original-evidence"), archive)
            let saved = File.ReadAllText(Path.Combine(run, "run.json"))
            Amend(flow, run, commit, 1)
            Amend(flow, run, Edit(flow, run, "Another amendment\n"), 1)
            Check.That(
                File.ReadAllText(Path.Combine(run, "run.json")) == saved,
                "Another run's sealed archive was accepted"
            )
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Archive identity check repeated inference")
        }

        private func ArchiveIntegrity(binary string) {
            using let prepared = PublishedContribution.Create(binary)
            let flow = prepared.Coordination.Flow
            let run = prepared.Run
            for fault in[]string{"record-link", "verification-link", "tampered", "missing", "unsealed"} {
                prepared.Restore()
                let original = File.ReadAllText(Path.Combine(run, "run.json"))
                let commit = Edit(flow, run)
                Amend(flow, run, commit)
                AssertOriginal(run, original)
                let archive = Path.Combine(run, "original-evidence")
                let saved = File.ReadAllText(Path.Combine(run, "run.json"))
                let manifest = File.ReadAllText(Path.Combine(archive, "manifest.json"))
                let secret = Path.Combine(flow.Temp.Root, "outside-evidence")
                File.WriteAllText(secret, "synthetic private evidence")
                switch fault {
                    case "record-link" {
                        let record = Path.Combine(archive, "report.md")
                        File.Delete(record)
                        File.CreateSymbolicLink(record, secret)
                    }
                    case "verification-link" {
                        let evidence = Directory.GetDirectories(archive, "verification-*")[0]
                        Directory.Delete(evidence, true)
                        Directory.CreateSymbolicLink(evidence, flow.Temp.Root)
                    }
                    case "tampered" {
                        let evidence = Directory.GetDirectories(archive, "verification-*")[0]
                        File.AppendAllText(Path.Combine(evidence, "stdout.log"), "Changed original evidence")
                    }
                    case "missing" {
                        Directory.Delete(Directory.GetDirectories(archive, "verification-*")[0], true)
                    }
                    case "unsealed" {
                        File.Delete(Path.Combine(archive, "manifest.json"))
                        File.Delete(Path.Combine(archive, "seal.json"))
                        for evidence in Directory.EnumerateDirectories(archive) {
                            Directory.Delete(evidence, true)
                        }
                    }
                }
                Amend(flow, run, commit, 1)
                let second = Edit(flow, run, "Another amendment\n")
                Amend(flow, run, second, 1)
                flow.Call([]string{"publish", "--run", run}, 1)
                Check.That(File.ReadAllText(Path.Combine(run, "run.json")) == saved, "Changed archive was accepted")
                Check.That(
                    fault == "unsealed" ? !File.Exists(Path.Combine(archive, "manifest.json")):
                    File.ReadAllText(Path.Combine(archive, "manifest.json")) == manifest,
                    "Changed archive was resealed"
                )
                Check.That(File.ReadAllText(secret) == "synthetic private evidence", "Archive followed linked path")
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Archive validation repeated inference")
            }
        }

        private func LegacyArchives(binary string) {
            for mode in[]string{"v1-published", "v1-interrupted", "v2-published", "v2-requested"} {
                let v2 = mode.StartsWith("v2")
                using let prepared = PublishedContribution.Create(binary, v2: v2)
                let coordination = prepared.Coordination
                let flow = coordination.Flow
                let run = prepared.Run
                let commit = Edit(flow, run)
                if mode == "v1-interrupted" {
                    flow.Mode("lost_body_response")
                }
                Amend(flow, run, commit, mode == "v1-interrupted" ? 1: 0)
                flow.Mode("")
                if mode == "v2-published" {
                    flow.Reload()
                    coordination.Coordinate(coordination.Event(Check.PostedRequest(flow.State)))
                    Amend(flow, run, commit)
                }
                let archive = Path.Combine(run, "original-evidence")
                File.Delete(Path.Combine(archive, "manifest.json"))
                File.Delete(Path.Combine(archive, "seal.json"))
                for evidence in Directory.EnumerateDirectories(archive) {
                    Directory.Delete(evidence, true)
                }
                let location = Path.Combine(run, "amendments", commit)
                let saved = Saved(location)
                saved.AsObject().Remove("original_evidence_sha256")
                File.WriteAllText(Path.Combine(location, "run.json"), saved.ToJsonString())
                let original = File.ReadAllText(Path.Combine(archive, "run.json"))
                let checks = File.ReadAllText(Path.Combine(location, "verification.json"))
                flow.ResetTraffic()
                let replay = Amend(flow, run, commit)
                Check.Contains(replay.Output, "Legacy original evidence is unsealed")
                Check.That(
                    File.ReadAllText(Path.Combine(location, "verification.json")) == checks,
                    "Legacy replay repeated verification"
                )
                if mode == "v2-requested" {
                    flow.Reload()
                    coordination.Coordinate(coordination.Event(Check.PostedRequest(flow.State)))
                    Amend(flow, run, commit)
                }
                let next = Edit(flow, run, "Legacy continuation\n")
                Amend(flow, run, next)
                if v2 {
                    flow.Reload()
                    coordination.Coordinate(coordination.Event(Check.PostedRequest(flow.State)))
                    Amend(flow, run, next)
                    flow.NoInference()
                } else {
                    flow.Call([]string{"publish", "--run", run})
                    flow.Reload()
                    Check.That(Check.Text(flow.State["exec_count"]) == "1", "Legacy amendment repeated inference")
                }
                Check.That(
                    File.ReadAllText(Path.Combine(archive, "run.json")) == original && !File.Exists(
                        Path.Combine(archive, "manifest.json")
                    ) &&
                        !File.Exists(Path.Combine(archive, "seal.json")),
                    "Legacy original evidence was rewritten or resealed"
                )
                Check.That(Directory.GetDirectories(archive).Length == 0, "Legacy evidence was reconstructed")
                let originalRecord = Path.Combine(archive, "report.md")
                File.WriteAllText(originalRecord, "Changed legacy evidence")
                Amend(flow, run, next, 1)
            }
        }

        private func ReceiptAuthority(binary string) {
            using let prepared = PublishedContribution.Create(binary)
            let flow = prepared.Coordination.Flow
            let run = prepared.Run
            let commit = Edit(flow, run)
            Amend(flow, run, commit)
            using let snapshot = FixtureSnapshot(flow.Temp.Root)
            for field in[]string{"issue", "head", "approval", "model", "original_head", "amendment"} {
                snapshot.Restore()
                flow.Reload()
                let location = Path.Combine(run, "amendments", commit)
                let saved = Saved(location)
                let body = Check.Text(saved["body"])
                let start = body.IndexOf("<!-- tokate-receipt:") + "<!-- tokate-receipt:".Length
                let encoded = body.Substring(start, body.IndexOf(" -->", start) - start)
                let receipt = Check.Json(encoded)
                if field == "issue" {
                    receipt[field] = JsonValue.Create(999)
                } else if field == "amendment" {
                    (receipt[field] ?? throw Exception("Missing amendment"))["seconds"] = JsonValue.Create(31)
                } else {
                    receipt[field] = JsonValue.Create(
                        field == "head" || field == "original_head" ? String('b', 40):
                        "changed"
                    )
                }
                let altered = body.Replace(encoded, receipt.ToJsonString())
                saved["body"] = JsonValue.Create(altered)
                File.WriteAllText(Path.Combine(location, "run.json"), saved.ToJsonString())
                (flow.State["pulls"]?[0] ?? throw Exception("Missing PR"))["body"] = JsonValue.Create(altered)
                flow.Save()
                let original = File.ReadAllText(Path.Combine(run, "run.json"))
                flow.ResetTraffic()
                flow.Call([]string{"publish", "--run", run}, 1)
                Check.That(File.ReadAllText(Path.Combine(run, "run.json")) == original, "Altered receipt was accepted")
                flow.Reload()
                for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    Check.That(Check.Text(call["method"]) == "GET", "Receipt refusal attempted publication")
                }
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Receipt refusal repeated inference")
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
            flow.ResetTraffic()
            flow.Call([]string{"publish", "--run", run}, owner: owner)
            flow.Reload()
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Published amendment replay repeated a write")
            }
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
                    let saved = Saved(Path.Combine(run, "amendments", amended))
                    Check.That(
                        Check.Text(saved["failure_stage"]) == "changed_candidate" && Check.Text(
                            saved["failure_reason"]
                        ) == "candidate_changed",
                        "Verifier mutation did not fail candidate validation"
                    )
                    Check.That(
                        flow.Git("-C", Path.Combine(run, "checkout"), "status", "--porcelain") == "",
                        "Verification changed the original candidate checkout"
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

        private func V2(
            binary string,
            mode string = "",
            native bool = false,
            modelPolicy string = "",
            legacy bool = false
        ) {
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
            var legacyBody = ""
            if mode == "lost_body_response" || mode == "lost_state_response" || mode == "interrupted_state_write" {
                flow.Flow.Mode(mode)
                flow.Coordinate(path, 1)
                flow.Flow.Call(
                    []string{"verify-pr", "--repo", "owner/project", "--pr", "10"},
                    mode == "lost_state_response" ? 0: 1
                )
                flow.Flow.Mode("")
                if legacy {
                    flow.Flow.Reload()
                    let pull = flow.Flow.State["pulls"]?[0] ?? throw Exception("Missing review PR")
                    let body = Check.Text(pull["body"])
                    let metadata = request["metadata"] ?? throw Exception("Missing amendment metadata")
                    let declared = J.Parse(metadata["tools"]?.ToJsonString() ?? "[]")
                    let legacyReport = "Review amendment: " + Check.Text(metadata["previous"]) + " → " + Check.Text(
                        metadata["head"]
                    ) +
                        ". Donor reports all original owner commands passed locally with a separate " +
                        Check.Text(metadata["seconds"]) +
                        " second verification budget; no inference was launched by amend.\n\n" +
                        "Original execution/model/effort/runtime/usage observations cover original work only. Amendment editing: " +
                        (
                        J.Items(declared).Count == 0 ? "manual; coding time and usage unknown":
                        "donor-reported tools " + RequestData.Canonical(declared) +
                            "; identity, coding time and usage not independently attested"
                    ) +
                        ". Owner CI and review must validate this exact amended commit."
                    let start = body.IndexOf("<!-- tokate-report:start -->", StringComparison.Ordinal) +
                        "<!-- tokate-report:start -->".Length
                    let end = body.IndexOf("<!-- tokate-report:end -->", StringComparison.Ordinal)
                    legacyBody = body.Remove(start, end - start).Insert(start, "\n" + legacyReport + "\n")
                    pull["body"] = JsonValue.Create(legacyBody)
                    flow.Flow.Save()
                }
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
            if legacy {
                Check.That(
                    Check.Text(flow.Flow.State["pulls"]?[0]?["body"]) == legacyBody,
                    "Legacy replay changed the exact applied body"
                )
                Check.Contains(legacyBody, "Owner review before")
                Check.Contains(legacyBody, "Owner review after")
                flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                AssertOriginal(run, original)
                Check.That(flow.State()["state"]?["amendments"]?.AsArray().Count == 1, "Legacy history missing")
                return
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
                "ArchiveRefusals",
                "ArchiveIntegrity",
                "ArchiveIdentity",
                "LegacyArchives",
                "ReceiptAuthority",
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
                "V2LegacyStateBefore",
                "V2Stale"
            } {
                if only != "" && only != name {
                    continue
                }
                matched = true
                switch name {
                    case "ArchiveRefusals" {
                        ArchiveRefusals(binary)
                    }
                    case "ArchiveIdentity" {
                        ArchiveIdentity(binary)
                    }
                    case "ArchiveIntegrity" {
                        ArchiveIntegrity(binary)
                    }
                    case "LegacyArchives" {
                        LegacyArchives(binary)
                    }
                    case "ReceiptAuthority" {
                        ReceiptAuthority(binary)
                    }
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
                    case "V2LegacyStateBefore" {
                        V2(binary, "interrupted_state_write", legacy: true)
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
