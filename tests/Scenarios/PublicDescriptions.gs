package TokateTests

import System
import System.IO
import System.Text
import System.Text.Json.Nodes

internal class PublicDescriptions {
    shared {
        private func Summary(change string, head string = "") JsonNode {
            let value = Check.Map(
                "changes",
                Check.Json("[]"),
                "verification",
                Check.Json("[\"Fixture content check passed.\"]"),
                "limitations",
                Check.Json("[\"Browser behavior was not checked.\"]")
            )
            value["changes"]?.AsArray().Add(JsonValue.Create(change) as JsonNode)
            if head != "" {
                value["head"] = JsonValue.Create(head)
            }
            return value
        }

        private func Body(flow NativeFixture) string {
            flow.Reload()
            let body = Check.Text(flow.State["pulls"]?[0]?["body"])
            for marker in[]string{
                "<!-- tokate-receipt:",
                "<!-- tokate-report:start -->",
                "<!-- tokate-report:end -->"
            } {
                Check.That(body.Split(marker).Length == 2, "Missing or duplicate ownership marker")
            }
            Check.Contains(body, "missing or pending checks are not success")
            for text in[]string{"synthetic-raw-", "synthetic-usage-secret", flow.Temp.Root} {
                Check.That(!body.Contains(text), "Private output reached PR")
            }
            return body
        }

        private func Managed(binary string) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow)
            Check.Contains(Body(flow), "- Add a result containing the fixture completion text.")
            Check.That(
                !File.ReadAllText(Path.Combine(run, "changes.patch")).Contains("tokate-public-summary.json"),
                "Summary artifact committed"
            )
            let originalBody = Body(flow)
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            pull["body"] = JsonValue.Create("Maintainer before\n" + originalBody + "\nMaintainer after")
            flow.Save()
            let checkout = Path.Combine(run, "checkout")
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Final reviewed text\n")
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
                "Review result"
            )
            let head = flow.Git("-C", checkout, "rev-parse", "HEAD")
            let path = Path.Combine(flow.Temp.Root, "summary.json")
            File.WriteAllText(
                path,
                Summary("Update result content to show the final reviewed text.", head).ToJsonString()
            )
            let args = []string{"amend", "--run", run, "--commit", head, "--seconds", "30", "--summary", path}
            flow.Call(args)
            let body = Body(flow)
            Check.Contains(body, "- Update result content to show the final reviewed text.")
            Check.Contains(body, "Tokate observed locally")
            Check.Contains(body, "Donor-reported: Fixture content check passed.")
            Check.Contains(body, "Browser behavior was not checked.")
            Check.Contains(body, "Maintainer before")
            Check.Contains(body, "Maintainer after")
            Check.That(!body.Contains("- Add a result"), "Amendment retained abandoned summary")
            flow.Call(args)
            Check.That(Body(flow) == body, "Repeated amendment changed body")
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        }

        private func External(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            let claim = flow.Claim()
            let run = flow.Prepare()
            let head = flow.Candidate(claim)
            let path = Path.Combine(flow.Flow.Temp.Root, "summary.json")
            let ordinary = []string{
                "Infer change-summary wording from the final diff.",
                "Extend result text to name the verified behavior.",
                "Check the published report for the final result sentence.",
                "Require owner review before the candidate is merged."
            }
            let accepted = Summary("Add a result containing the external contribution text.", head)
            for bullet in ordinary {
                accepted["changes"]?.AsArray().Add(JsonValue.Create(bullet) as JsonNode)
            }
            File.WriteAllText(path, accepted.ToJsonString())
            let usable = File.ReadAllText(path)
            for invalid in[]string{
                "{\"head\":\"" +
                    head +
                    "\",\"changes\":[],\"changes\":[\"Add final result content.\"],\"verification\":[],\"limitations\":[]}",
                Summary("Add final result content.", head).ToJsonString().Replace(
                    "Browser behavior was not checked.",
                    "Private log at https://internal.example.test"
                ),
                "{\"head\":\"" + head + "\",\"changes\":[],\"verification\":[],\"limitations\":[]}",
                "{\"head\":\"" +
                    head +
                    "\",\"changes\":[\"Add final result content.\",7],\"verification\":[],\"limitations\":[]}",
                "{\"head\":\"" +
                    head +
                    "\",\"changes\":[\"Fix the result using credential material.\"],\"verification\":[],\"limitations\":[]}",
                "{\"head\":\"" +
                    head +
                    "\",\"changes\":[\"" +
                    String('x', 201) +
                    "\"],\"verification\":[],\"limitations\":[]}"
            } {
                File.WriteAllText(path, invalid)
                flow.Flow.Call([]string{"external", "--run", run, "--commit", head, "--summary", path}, 1)
                Check.That(
                    !Directory.Exists(Path.Combine(run, "checkout")),
                    "Invalid public summary reached verification"
                )
            }
            File.WriteAllText(path, usable)
            File.CreateSymbolicLink(path + ".link", path)
            flow.Flow.Call([]string{"external", "--run", run, "--commit", head, "--summary", path + ".link"}, 1)
            Check.That(!Directory.Exists(Path.Combine(run, "checkout")), "Linked public summary reached verification")
            File.WriteAllText(path, Summary("Add external contribution text.", String('a', 40)).ToJsonString())
            flow.Flow.Call([]string{"external", "--run", run, "--commit", head, "--summary", path}, 1)
            Check.That(!Directory.Exists(Path.Combine(run, "checkout")), "Stale summary reached verification")
            File.WriteAllText(path, usable)
            flow.Flow.Call([]string{"external", "--run", run, "--commit", head, "--summary", path})
            flow.Flow.Call([]string{"submit", "--run", run})
            flow.Flow.Reload()
            let request = Check.PostedRequest(flow.Flow.State)
            let event = flow.Event(request)
            flow.Flow.Mode("pr_fail_after_create")
            flow.Coordinate(event, 1)
            flow.Flow.Mode("")
            let changed = request.DeepClone()
            let metadata = changed["metadata"] ?? throw Exception("Missing metadata")
            metadata["summary"] = Summary("Remove final result content from the contribution.", head)
            flow.Coordinate(flow.Event(changed), 1)
            flow.Coordinate(event)
            let body = Body(flow.Flow)
            Check.Contains(body, "- Add a result containing the external contribution text.")
            for bullet in ordinary {
                Check.Contains(body, "- " + bullet)
            }
            Check.Contains(body, "coordinator did not observe execution")
            Check.Contains(body, "Original donor-reported tools")
            Check.That(!body.Contains("\"harness\""), "Raw tool JSON in public report")
            flow.Coordinate(event)
            Check.That(Body(flow.Flow) == body, "Repeated publication changed body")
            flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            let pull = flow.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            pull["body"] = JsonValue.Create("Maintainer before\n" + body + "\nMaintainer after")
            flow.Flow.Save()
            let checkout = Path.Combine(run, "checkout")
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Final external review text\n")
            flow.Flow.Git("-C", checkout, "add", "-A")
            flow.Flow.Git(
                "-C",
                checkout,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
                "commit",
                "-m",
                "Review external result"
            )
            let amended = flow.Flow.Git("-C", checkout, "rev-parse", "HEAD")
            File.WriteAllText(
                path,
                Summary("Update result content to show the external review text.", amended).ToJsonString()
            )
            let args = []string{
                "amend",
                "--run",
                run,
                "--commit",
                amended,
                "--seconds",
                "30",
                "--tools",
                flow.Tools,
                "--summary",
                path
            }
            flow.Flow.Call(args)
            flow.Flow.Reload()
            let amendmentEvent = flow.Event(Check.PostedRequest(flow.Flow.State))
            flow.Coordinate(amendmentEvent)
            let reviewed = Body(flow.Flow)
            Check.Contains(reviewed, "- Update result content to show the external review text.")
            Check.Contains(reviewed, "Original donor-reported tools")
            Check.Contains(reviewed, "Amendment donor-reported tools")
            Check.Contains(reviewed, "Maintainer before")
            Check.Contains(reviewed, "Maintainer after")
            Check.That(!reviewed.Contains("- Add a result"), "Coordinated amendment retained old summary")
            flow.Coordinate(amendmentEvent)
            Check.That(Body(flow.Flow) == reviewed, "Repeated coordinated amendment changed body")
            flow.Flow.Call(args)
            flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        }

        private func Recovery(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("verification_fail")
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Mode("")
            flow.Call([]string{"recover", "--run", run, "--prepare"})
            let checkout = Path.Combine(run, "checkout")
            File.Delete(Path.Combine(checkout, "other.txt"))
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Final corrected result text\n")
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
                "Correct result"
            )
            let head = flow.Git("-C", checkout, "rev-parse", "HEAD")
            let path = Path.Combine(flow.Temp.Root, "summary.json")
            File.WriteAllText(path, Summary("Add final corrected result text.", head).ToJsonString())
            let tools = "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            let toolsPath = Path.Combine(flow.Temp.Root, "correction-tools.json")
            File.WriteAllText(toolsPath, tools)
            flow.Call(
                []string{
                    "recover",
                    "--run",
                    run,
                    "--commit",
                    head,
                    "--seconds",
                    "30",
                    "--summary",
                    path,
                    "--tools",
                    toolsPath
                }
            )
            let body = Body(flow)
            Check.Contains(body, "- Add final corrected result text.")
            Check.Contains(body, "Tokate observed locally")
            Check.Contains(body, "Donor-reported correction tools")
            Check.Contains(body, "cover only the original completed turn")
            Check.That(!body.Contains("- Add a result containing"), "Correction reused original summary")
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            let receiptPrefix = "<!-- tokate-receipt:"
            let receiptStart = body.IndexOf(receiptPrefix, StringComparison.Ordinal) + receiptPrefix.Length
            let receiptEnd = body.IndexOf(" -->", receiptStart, StringComparison.Ordinal)
            guard let correction = Check.Json(body.Substring(receiptStart, receiptEnd - receiptStart))[
                "correction"
            ] else {
                throw Exception("Missing correction receipt")
            }
            let legacy = "Explicit donor correction " + Check.Text(correction["uuid"]) +
                ": donor-reported correction tools: " +
                tools +
                ". Original model, effort, execution runtime and reported usage cover only the original completed turn; correction edits are not attributed to that model. " +
                "Tokate observed independent verification locally on exact corrected commit " +
                head +
                ", tree " +
                Check.Text(correction["tree"]) +
                ". Separate verification budget: 30 seconds.\n\n" +
                "Generated a patch for the approved issue. Independent owner verification: 1/1 checks passed.\n\nReview the changes against the issue's acceptance criteria and limitations."
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            let start = body.IndexOf(prefix, StringComparison.Ordinal)
            let end = body.IndexOf(suffix, StringComparison.Ordinal) + suffix.Length
            flow.Reload()
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing corrected PR")
            pull["body"] = JsonValue.Create(
                "Maintainer before\n" + body.Remove(start, end - start).Insert(start, legacy) + "\nMaintainer after"
            )
            flow.Save()
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Final amended result text\n")
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
                "Review corrected result"
            )
            let amended = flow.Git("-C", checkout, "rev-parse", "HEAD")
            File.WriteAllText(path, Summary("Update final result text after review.", amended).ToJsonString())
            let args = []string{"amend", "--run", run, "--commit", amended, "--seconds", "30", "--summary", path}
            flow.Mode("lost_body_response")
            flow.Call(args, 1)
            flow.Mode("")
            flow.Call(args)
            let reviewed = Body(flow)
            Check.Contains(reviewed, "Maintainer before")
            Check.Contains(reviewed, "Maintainer after")
            Check.Contains(reviewed, "- Update final result text after review.")
            Check.That(
                !reviewed.Contains("Explicit donor correction " + Check.Text(correction["uuid"])),
                "Legacy correction prose survived outside the current report"
            )
            let reportStart = reviewed.IndexOf(prefix, StringComparison.Ordinal) + prefix.Length
            let reportEnd = reviewed.IndexOf(suffix, StringComparison.Ordinal)
            Check.That(
                !reviewed.Substring(reportStart, reportEnd - reportStart).Contains("\"harness\""),
                "Legacy tool JSON survived in the current report"
            )
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        }

        private func MissingAndUnsafe(binary string) {
            for missing in[]bool{true, false} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Reload()
                flow.State["public_summary"] = JsonValue.Create(
                    missing ? "missing": Summary("Fix content from /tmp/private.log").ToJsonString()
                )
                flow.Save()
                flow.Call([]string{"work", "--run", run}, missing ? 0: 1)
                if missing {
                    Check.Contains(Body(flow), "Change summary unavailable for this candidate")
                } else {
                    flow.NoPr()
                }
            }
        }

        private func Readiness(binary string) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow)
            let body = Body(flow)
            flow.Reload()
            flow.State.AsObject().Remove("exec_count")
            flow.Save()
            Check.Contains(body, "- Add a result containing the fixture completion text.")
            Check.Contains(body, "Verification:")
            Check.Contains(body, "Tokate observed locally")
            flow.Reload()
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            flow.Save()
            guard let ready = Check.Json(flow.Call([]string{"checks", "--run", run, "--json"}).Output)["data"] else {
                throw Exception("Missing readiness result")
            }
            Check.That(
                Check.Text(ready["gates"]?["report"]?["status"]) == "passed" && Check.Text(
                    ready["machine_status"]
                ) == "passed",
                "Current public report did not compose machine success: " + ready.ToJsonString()
            )
            Check.That(Check.Text(ready["owner_review"]) == "required", "Report readiness removed owner review")
            for kind in[]string{"missing", "altered"} {
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                let current = Check.Text(pull["body"])
                let start = current.IndexOf("<!-- tokate-report:start -->", StringComparison.Ordinal)
                let end = current.IndexOf("<!-- tokate-report:end -->", StringComparison.Ordinal) +
                    "<!-- tokate-report:end -->".Length
                Check.That(start >= 0 && end > start, "Managed contribution lost its report region")
                pull["body"] = JsonValue.Create(
                    current.Remove(start, end - start).Insert(
                        start,
                        kind == "missing" ?
                        "<!-- tokate-report:start --><!-- tokate-report:end -->":
                        "<!-- tokate-report:start -->\nOwner note without a change or verification report.\n<!-- tokate-report:end -->"
                    )
                )
                flow.Save()
                let refusal = flow.Call([]string{"checks", "--run", run, "--json"}, 1)
                Check.Envelope(refusal, "checks", "error", "invalid_state")
                let refused = Check.Json(refusal.Output)["data"] ?? throw Exception("Missing refusal result")
                Check.That(
                    Check.Text(refused["gates"]?["report"]?["status"]) == "failed" && Check.Text(
                        refused["machine_status"]
                    ) == "failed",
                    "Missing or altered public report returned machine success: " + refused.ToJsonString()
                )
                Check.That(
                    Check.Text(refused["gates"]?["receipt"]?["status"]) == "passed" && Check.Text(
                        refused["gates"]?["checks"]?["status"]
                    ) == "passed",
                    "Report refusal discarded current receipt or CI evidence"
                )
                Check.Contains(
                    refused["required_owner_actions"]?.ToJsonString() ?? "",
                    "public change and verification report"
                )
                flow.NoInference()
            }
        }

        private func BoundedArtifact() JsonNode {
            let value = Check.Map(
                "changes",
                Check.Json("[]"),
                "verification",
                Check.Json("[]"),
                "limitations",
                Check.Json("[]")
            )
            for key in[]string{"changes", "verification", "limitations"} {
                let items = value[key]?.AsArray() ?? throw Exception("Missing summary list")
                let prefix = key == "changes" ? "Fix final result behavior. ": "Fixture observation. "
                for i in 0 ... (key == "limitations" ? 4: 8) {
                    items.Add(JsonValue.Create(prefix + String('x', 200 - prefix.Length)) as JsonNode)
                }
            }
            let size = Encoding.UTF8.GetByteCount(value.ToJsonString())
            let limits = value["limitations"]?.AsArray() ?? throw Exception("Missing limits")
            let text = Check.Text(limits[0])
            limits[0] = JsonValue.Create(text.Substring(0, text.Length - size + 4046))
            return value
        }

        private func ManagedBounds(binary string) {
            for oversized in[]bool{false, true} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                let value = BoundedArtifact()
                if oversized {
                    let limits = value["limitations"]?.AsArray() ?? throw Exception("Missing limits")
                    limits[0] = JsonValue.Create(Check.Text(limits[0]) + "x")
                }
                flow.Reload()
                flow.State["public_summary"] = JsonValue.Create(value.ToJsonString())
                flow.Save()
                flow.Call([]string{"work", "--run", run}, oversized ? 1: 0)
                if oversized {
                    flow.NoPr()
                    Check.That(
                        Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["commit"] == nil,
                        "Oversized summary reached a publication commit"
                    )
                    Check.That(
                        !File.Exists(Path.Combine(run, "changes.patch")),
                        "Oversized summary reached independent verification"
                    )
                } else {
                    Check.Contains(Body(flow), "Fix final result behavior.")
                    flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                }
            }
        }

        private func UnsafeRequests(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize(false)
            flow.Flow.SetModelPolicy("unrestricted", "omit")
            flow.Flow.Approve()
            let claim = flow.Claim()
            let head = flow.Flow.Git("-C", flow.Flow.Upstream, "rev-parse", "HEAD")
            for action in[]string{"publish", "amend"} {
                for model in[]string{"ghp_SYNTHETIC", "sk-synthetic"} {
                    let request = flow.PublishRequest(claim, head)
                    let metadata = request["metadata"] ?? throw Exception("Missing metadata")
                    let tool = metadata["tools"]?[0] ?? throw Exception("Missing tool declaration")
                    tool["model"] = JsonValue.Create(model)
                    if action == "amend" {
                        request["action"] = JsonValue.Create(action)
                        metadata.AsObject().Remove("source")
                        metadata["previous"] = JsonValue.Create(head)
                        metadata["pr"] = JsonValue.Create(10)
                        metadata["seconds"] = JsonValue.Create(30)
                    }
                    let path = Path.Combine(flow.Flow.Temp.Root, "request.json")
                    File.WriteAllText(path, request.ToJsonString())
                    flow.Flow.ResetTraffic()
                    Check.Contains(
                        flow
                            .Flow
                            .Call([]string{"request", "--repo", "owner/project", "--issue", "1", "--file", path}, 1)
                            .Error,
                        "invalid public identifier"
                    )
                    flow.Flow.Reload()
                    Check.That(flow.Flow.State["request_comments"] == nil, "Unsafe tool data was posted")
                    Check.That(flow.Flow.State["api_calls"]?.AsArray().Count == 0, "Unsafe tool data reached GitHub")
                }
            }
        }

        internal func All(binary string, selected string = "") {
            if selected == "Managed" || (selected == "" && CiShard.Include("PublicDescriptions/Managed")) {
                Managed(binary)
                Console.WriteLine(
                    "PASS managed publication and amendment summaries, receipt and maintainer preservation"
                )
            }
            if selected == "External" || (selected == "" && CiShard.Include("PublicDescriptions/External")) {
                External(binary)
                Console.WriteLine("PASS external publication summary and compact provenance")
            }
            if selected == "Recovery" || (selected == "" && CiShard.Include("PublicDescriptions/Recovery")) {
                Recovery(binary)
                Console.WriteLine("PASS correction publication summary and distinct original provenance")
            }
            if selected == "MissingAndUnsafe" ||
                (selected == "" && CiShard.Include("PublicDescriptions/MissingAndUnsafe")) {
                MissingAndUnsafe(binary)
                Console.WriteLine("PASS missing summary fallback and unsafe publication refusal")
            }
            if selected == "Readiness" || (selected == "" && CiShard.Include("PublicDescriptions/Readiness")) {
                Readiness(binary)
                Console.WriteLine("PASS current public report readiness with missing and altered report refusal")
            }
            if selected == "ManagedBounds" || (selected == "" && CiShard.Include("PublicDescriptions/ManagedBounds")) {
                ManagedBounds(binary)
                Console.WriteLine("PASS managed summary byte boundary before candidate publication")
            }
            if selected == "UnsafeRequests" ||
                (selected == "" && CiShard.Include("PublicDescriptions/UnsafeRequests")) {
                UnsafeRequests(binary)
                Console.WriteLine("PASS unsafe public tool identifiers refused before request comments")
            }
        }
    }
}
