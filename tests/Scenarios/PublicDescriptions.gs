package TokateTests

import System
import System.IO
import System.Text.Json
import System.Text.Json.Nodes
import Tokate

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

        private func Validation() {
            let valid = Summary("Fix result content to show the final reviewed text.", String('a', 40))
            PublicSummary.Validate(J.Parse(valid.ToJsonString()), String('a', 40))
            for unsafe in[]string{
                "Fix output using https://private.example.test/log",
                "Fix output from /tmp/private.log",
                "Fix output from C:\\private\\log",
                "Fix output from localhost:8080",
                "Fix output from 127.0.0.1:8080",
                "Fix output with sk-synthetic-never-valid",
                "Fix output with github_pat_synthetic",
                "Fix output for person@example.test",
                "Fix output <!-- tokate-receipt:duplicate -->",
                "Fix output {raw:tool-data}",
                "Fix output\nwith copied logs",
                "Generated a patch for the issue.",
                "result.txt",
                "Fix output " + String('x', 201)
            } {
                var refused bool
                try {
                    PublicSummary.Validate(J.Parse(Summary(unsafe).ToJsonString()))
                } catch {
                    refused = true
                }
                Check.That(refused, "Unsafe summary accepted")
            }
            for mutation in[]string{"stale", "unknown", "empty", "null", "many", "bytes"} {
                let value = valid.DeepClone()
                if mutation == "unknown" {
                    value["private_report"] = JsonValue.Create("private")
                } else if mutation == "empty" {
                    value["changes"] = Check.Json("[]")
                } else if mutation == "null" {
                    value["verification"] = nil
                } else if mutation == "many" {
                    for i in 0 ... 8 {
                        value["changes"]?.AsArray().Add(JsonValue.Create("Fix another observed behavior.") as JsonNode)
                    }
                } else if mutation == "bytes" {
                    value["head"] = JsonValue.Create(String('a', 4097))
                }
                var refused bool
                try {
                    PublicSummary.Validate(
                        J.Parse(value.ToJsonString()),
                        mutation == "stale" ? String('b', 40): String('a', 40)
                    )
                } catch {
                    refused = true
                }
                Check.That(refused, "Invalid summary accepted")
            }
            for key in[]string{"verification", "limitations"} {
                let value = valid.DeepClone()
                value[key] = Check.Json("[\"Private log from https://internal.example.test\"]")
                var refused bool
                try {
                    PublicSummary.Validate(J.Parse(value.ToJsonString()), String('a', 40))
                } catch {
                    refused = true
                }
                Check.That(refused, "Unsafe public field accepted")
            }
            var duplicateRefused bool
            try {
                PublicSummary.Validate(
                    J.Parse(
                        "{\"changes\":[],\"changes\":[\"Fix concrete final result content.\"],\"verification\":[],\"limitations\":[]}"
                    )
                )
            } catch {
                duplicateRefused = true
            }
            Check.That(duplicateRefused, "Duplicate summary key accepted")
            Check.That(
                PublicSummary.Usage(J.Parse("{\"input_tokens\":7,\"output_tokens\":\"unsafe\"}")) == "input: 7 tokens",
                "Invalid usage exposed"
            )
            let run = Data()
            run.Fields["public_summary"] = J.Parse(Summary("Add final reviewed result content.").ToJsonString())
            PublicSummary.Bind(run, "original candidate")
            PublicSummary.Bind(run, "changed candidate")
            Check.That(
                J.Get(run.Element(), "public_summary").ValueKind == JsonValueKind.Undefined,
                "Stale patch summary retained"
            )
            let fallback = PublicSummary.Report(JsonElement{}, "Local evidence unavailable.")
            Check.Contains(fallback, "summary unavailable")
            Check.That(!fallback.Contains("Limits:"), "Empty limits section")
            using let temp = Temp()
            let path = Path.Combine(temp.Root, "summary.json")
            File.WriteAllText(path, valid.ToJsonString())
            File.CreateSymbolicLink(path + ".link", path)
            var refused bool
            try {
                PublicSummary.FileSummary(path + ".link", String('a', 40))
            } catch {
                refused = true
            }
            Check.That(refused, "Summary symlink followed")
            File.WriteAllText(path, "")
            var emptyRefused bool
            try {
                PublicSummary.FileSummary(path, String('a', 40))
            } catch {
                emptyRefused = true
            }
            Check.That(emptyRefused, "Empty summary file accepted")
        }

        private func Managed(binary string) {
            using let flow = NativeFixture(binary)
            let run = PublishedContribution.Original(flow)
            Check.Contains(Body(flow), "- Add a result containing the fixture completion text.")
            Check.That(
                !File.ReadAllText(Path.Combine(run, "changes.patch")).Contains(PublicSummary.Artifact),
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
            File.WriteAllText(
                path,
                Summary("Add a result containing the external contribution text.", head).ToJsonString()
            )
            let usable = File.ReadAllText(path)
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
            flow.Call([]string{"recover", "--run", run, "--commit", head, "--seconds", "30", "--summary", path})
            let body = Body(flow)
            Check.Contains(body, "- Add final corrected result text.")
            Check.Contains(body, "Tokate observed locally")
            Check.Contains(body, "Donor-reported correction tools")
            Check.Contains(body, "cover only the original completed turn")
            Check.That(!body.Contains("- Add a result containing"), "Correction reused original summary")
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

        internal func All(binary string, selected string = "") {
            if selected == "" || selected == "Validation" {
                Validation()
                Console.WriteLine("PASS public summary validation, bounds, stale binding and unsafe synthetic text")
            }
            if selected == "" || selected == "Managed" {
                Managed(binary)
                Console.WriteLine(
                    "PASS managed publication and amendment summaries, receipt and maintainer preservation"
                )
            }
            if selected == "" || selected == "External" {
                External(binary)
                Console.WriteLine("PASS external publication summary and compact provenance")
            }
            if selected == "" || selected == "Recovery" {
                Recovery(binary)
                Console.WriteLine("PASS correction publication summary and distinct original provenance")
            }
            if selected == "" || selected == "MissingAndUnsafe" {
                MissingAndUnsafe(binary)
                Console.WriteLine("PASS missing summary fallback and unsafe publication refusal")
            }
        }
    }
}
