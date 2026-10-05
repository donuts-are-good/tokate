package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes
import Tokate

internal class OverlapFlow : IDisposable {
    internal let Test CoordinationFixture
    internal let Flow NativeFixture
    internal let Version int32
    internal let Heads List[string] = List[string]()
    internal let Bases List[string] = List[string]()

    internal init(binary string, version int32) {
        Test = CoordinationFixture(binary)
        Flow = Test.Flow
        Version = version
    }

    internal func Initialize(layout string) {
        let version = Version
        if version == 2 {
            Test.Initialize()
        } else {
            Flow.Initialize()
        }
        File.WriteAllText(Path.Combine(Flow.Upstream, "old.txt"), "Original rename endpoint\n")
        Flow.Commit("Original source")
        Flow.Git("-C", Flow.Bin + "/fork", "fetch", Flow.Upstream, "main")
        if layout == "targets" {
            Flow.Git("-C", Flow.Upstream, "branch", "release")
        }
        Flow.Reload()
        Flow.State["issues"] = Check.Map(
            "1",
            Flow.State["issue"]?.DeepClone(),
            "2",
            Check.Map(
                "number",
                2,
                "state",
                "open",
                "title",
                "Second task",
                "body",
                "Native dependencies only; blocked by #999 in prose is ignored.",
                "labels",
                JsonArray(),
                "assignees",
                JsonArray()
            )
        )
        Flow.State["multiple_pulls"] = JsonValue.Create(true)
        Flow.Save()
        for issue in 1 ... 3 {
            Test.Issue = issue
            let target = layout == "targets" && issue == 2 ? "release": "main"
            Flow.Call(
                []string{
                    "approve",
                    "--repo",
                    "owner/project",
                    "--issue",
                    issue.ToString(),
                    "--donor",
                    "donor",
                    "--base-branch",
                    target
                },
                owner: true
            )
            var approval JsonNode
            var revision string
            var claim JsonNode? = nil
            if version == 2 {
                let state = Test.State()
                approval = state["state"]?["approval"] ?? throw Exception("Missing approval")
                revision = Check.Text(state["state"]?["approval_id"])
                claim = Test.ClaimRequest()
                Test.Coordinate(Test.Event(claim))
            } else {
                revision = Flow.Git("-C", Flow.Upstream, "rev-parse", "tokate/approvals/" + issue.ToString())
                approval = Check.Json(Flow.Git("-C", Flow.Upstream, "show", revision + ":.github/tokate-approval.json"))
            }
            let base = Check.Text(approval["base"])
            Bases.Add(base)
            let branch = version == 2 ? "tokate/v2-" + Check.Text(claim?["uuid"]): "tokate/issue-" + issue.ToString() +
                "-" +
                revision.Substring(0, 12)
            let checkout = Path.Combine(Flow.Temp.Root, "candidate-" + issue.ToString())
            Flow.Git("clone", Flow.Upstream, checkout)
            Flow.Git("-C", checkout, "checkout", "-b", branch, base)
            if layout == "rename" && issue == 1 {
                Flow.Git("-C", checkout, "mv", "old.txt", "new.txt")
            } else if layout == "rename" {
                File.AppendAllText(Path.Combine(checkout, "old.txt"), "Second edit\n")
                File.WriteAllText(Path.Combine(checkout, "new.txt"), "Second new endpoint\n")
            } else {
                File.WriteAllText(
                    Path.Combine(checkout, layout == "disjoint" ? "file-" + issue.ToString() + ".txt": "result.txt"),
                    "Contribution " + issue.ToString() + "\n"
                )
            }
            Flow.Git("-C", checkout, "add", ".")
            Flow.Git(
                "-C",
                checkout,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
                "commit",
                "-m",
                "Candidate"
            )
            let head = Flow.Git("-C", checkout, "rev-parse", "HEAD")
            Heads.Add(head)
            Flow.Git("-C", checkout, "push", Path.Combine(Flow.Bin, "fork"), "HEAD:refs/heads/" + branch)
            if version == 2 {
                Test.Coordinate(Test.Event(Test.PublishRequest(claim ?? throw Exception("Missing claim"), head)))
            } else {
                let receipt = Check.Map(
                    "version",
                    1,
                    "repo",
                    "owner/project",
                    "issue",
                    issue,
                    "donor",
                    "donor",
                    "approval",
                    revision,
                    "head",
                    head,
                    "model",
                    "gpt-6.1-sol",
                    "effort",
                    "high",
                    "seconds",
                    30,
                    "network",
                    false,
                    "policy",
                    Check.Text(approval["policy_hash"])
                )
                Flow.Reload()
                let pulls = Flow.State["pulls"]?.AsArray() ?? JsonArray()
                pulls.Add(
                    Check.Map(
                        "number",
                        issue + 9,
                        "body",
                        "<!-- tokate-receipt:" + receipt.ToJsonString() + " -->",
                        "html_url",
                        "https://github.com/owner/project/pull/" + (issue + 9).ToString(),
                        "user",
                        Check.Map("login", "donor"),
                        "head",
                        Check.Map(
                            "sha",
                            head,
                            "ref",
                            branch,
                            "repo",
                            Check.Map("full_name", "donor/project", "owner", Check.Map("login", "donor"))
                        ),
                        "base",
                        Check.Map("ref", target)
                    )
                )
                Flow.State["pulls"] = pulls
                Flow.Save()
            }
        }
        Flow.Reload()
        Flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
        Flow.Save()
        Flow.MetadataOnly()
        let saved = Path.Combine(Flow.Temp.Root, "saved-work")
        Directory.CreateDirectory(saved)
        File.WriteAllText(Path.Combine(saved, "run.json"), "synthetic-private-work-and-reservation")
        File.WriteAllText(Path.Combine(saved, "changes.patch"), "synthetic-saved-patch")
    }

    shared {
        internal func Create(binary string, version int32, layout string = "overlap") OverlapFlow {
            let test = OverlapFlow(binary, version)
            test.Initialize(layout)
            return test
        }
    }

    public func Dispose() -> Test.Dispose()

    internal func Report(prs string = "10,11") JsonNode {
        let references = Flow.Git("-C", Flow.Upstream, "show-ref") + Flow.Git("-C", Flow.Bin + "/fork", "show-ref")
        Flow.Reload()
        let authority = Flow.State["issues"]?.ToJsonString() + Flow.State["pulls"]?.ToJsonString() +
            Flow
            .State["comments"]
            ?.ToJsonString()
        Flow.ResetTraffic()
        let result = Flow.Call([]string{"overlaps", "--repo", "owner/project", "--prs", prs, "--json"})
        let envelope = Check.Envelope(result, "overlaps", "ok")
        Check.That(
            envelope["data"]?["accepted"] == nil && envelope["data"]?["ready_to_merge"] == nil,
            "Overlap report grants acceptance"
        )
        Flow.Reload()
        for call in Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
            Check.That(Check.Text(call["method"]) == "GET", "Overlap command wrote to GitHub")
            Check.That(!Check.Text(call["path"]).Contains("pulls?"), "Overlap discovered contributions")
        }
        Check.That(
            authority == Flow.State["issues"]?.ToJsonString() + Flow.State["pulls"]?.ToJsonString() +
                Flow
                .State["comments"]
                ?.ToJsonString(),
            "Overlap changed authority"
        )
        Check.That(
            references == Flow.Git("-C", Flow.Upstream, "show-ref") + Flow.Git("-C", Flow.Bin + "/fork", "show-ref"),
            "Overlap changed branches"
        )
        Flow.NoInference()
        Check.That(
            File.ReadAllText(
                Path.Combine(Flow.Temp.Root, "saved-work/run.json")
            ) == "synthetic-private-work-and-reservation" &&
                File.ReadAllText(Path.Combine(Flow.Temp.Root, "saved-work/changes.patch")) == "synthetic-saved-patch",
            "Overlap changed saved work"
        )
        return envelope
    }

    internal func Dependencies(items JsonArray) {
        Flow.Reload()
        Flow.State["dependency_pages"] = Check.Map("1", JsonArray(items), "2", JsonArray())
        Flow.Save()
    }
}

internal class OverlapChecks {
    shared {
        private func Dependency(number int32, state string, reason string) JsonNode -> Check.Map(
            "number",
            number,
            "id",
            number,
            "url",
            "https://api.github.com/repos/other/project/issues/" + number.ToString(),
            "html_url",
            "https://github.com/other/project/issues/" + number.ToString(),
            "state",
            state,
            "state_reason",
            reason,
            "closed_at",
            state == "closed" ? "2026-01-01T00:00:00Z" as Object: nil
        )

        private func Inputs(binary string) {
            using let flow = NativeFixture(binary)
            let invalid = List[string]{
                "1",
                "0,2",
                "-1,2",
                "1,1",
                "1,01",
                "1,",
                ",2",
                "1, 2",
                "1,2\n",
                "1,+2",
                "1,2147483648",
                "owner/project#1,2"
            }
            let many = List[string]()
            for number in 1 ... 18 {
                many.Add(number.ToString())
            }
            invalid.Add(String.Join(",", many))
            for prs in invalid {
                Check.Envelope(
                    flow.Call([]string{"overlaps", "--repo", "owner/project", "--prs=" + prs, "--json"}, 1),
                    "overlaps",
                    "error",
                    "invalid_arguments"
                )
            }
            for argv in[][]string{
                []string{"overlaps", "--repo", "owner/project", "--json"},
                []string{"overlaps", "--repo", "bad", "--prs", "1,2", "--json"},
                []string{"overlaps", "--repo", "owner/project", "--prs", "1,2", "--prs", "3,4", "--json"}
            } {
                Check.Envelope(flow.Call(argv, 1), "overlaps", "error", "invalid_arguments")
            }
            flow.Reload()
            Check.That(flow.State["api_calls"] == nil, "Invalid selection made remote reads")
            let help = Check.Envelope(flow.Call([]string{"overlaps", "--help", "--json"}), "overlaps", "ok")
            let effects = help["data"]?["commands"]?[0]?["effects"]
            Check.That(
                Check.Text(effects?["github_read"]) == "true" && Check.Text(effects?["github_write"]) == "false" &&
                    Check.Text(effects?["local_write"]) == "false",
                "Wrong overlap effects"
            )
            Console.WriteLine("PASS overlap input limits, duplicates, pre-read rejection and read-only metadata")
        }

        private func Files(binary string, version int32) {
            for layout in[]string{"overlap", "disjoint", "rename", "targets"} {
                using let test = OverlapFlow.Create(binary, version, layout)
                let data = test.Report()["data"] ?? throw Exception("Missing report")
                let pair = data["pairs"]?[0]
                let expected = layout == "disjoint" ? "no_filename_overlap": (
                    layout == "targets" ? "different_targets": "overlap"
                )
                Check.That(
                    Check.Text(pair?["status"]) == expected,
                    "Wrong filename overlap for " + layout + ": " + data.ToJsonString()
                )
                if layout == "rename" {
                    Check.That(
                        Check.Text(pair?["overlap_count"]) == "2" && pair?["paths"]?.ToJsonString().Contains(
                            "old.txt"
                        ) == true &&
                            pair?["paths"]
                            ?.ToJsonString().Contains("new.txt") == true,
                        "Rename endpoints lost"
                    )
                }
                for i in 0 ... 2 {
                    let item = data["contributions"]?[i]
                    Check.That(
                        Check.Text(item?["binding_status"]) == "validated" && Check.Text(
                            item?["binding"]?["version"]
                        ) == version.ToString() && Check.Text(item?["head"]) == test.Heads[i] && Check.Text(
                            item?["binding"]?["base"]
                        ) == test.Bases[i] &&
                            Check.Text(item?["checks_head"]) == test.Heads[i],
                        "Revision binding lost"
                    )
                }
                if layout == "overlap" {
                    let readable = test.Flow.Call([]string{"overlaps", "--repo", "owner/project", "--prs", "10,11"})
                    Check.Contains(readable.Output, "advisory")
                    Check.Contains(readable.Output, "dependency_gate")
                    Check.Contains(readable.Output, "verify")
                    let original = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing pull")
                    test.Flow.Reload()
                    let pulls = test.Flow.State["pulls"]?.AsArray() ?? throw Exception("Missing pulls")
                    for number in 12 ... 26 {
                        let copy = original.DeepClone()
                        copy["number"] = JsonValue.Create(number)
                        pulls.Add(copy)
                    }
                    test.Flow.Save()
                    if version == 1 {
                        let maximum = test.Report("10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25")
                        Check.That(maximum["data"]?["pairs"]?.AsArray().Count == 120, "16-PR limit lost pairs")
                    }
                }
                Console.WriteLine("PASS V" + version.ToString() + " overlap files: " + layout)
            }
        }

        private func Evidence(binary string, version int32) {
            using let test = OverlapFlow.Create(binary, version)
            for fault in[]string{
                "missing-files",
                "truncated-files",
                "wrong-base",
                "wrong-head",
                "missing-previous",
                "missing-status",
                "missing-commits"
            } {
                test.Flow.Reload()
                test.Flow.State["diff_fault"] = JsonValue.Create(fault)
                test.Flow.State["overlap_diff_fault_head"] = JsonValue.Create(test.Heads[0])
                test.Flow.Save()
                let data = test.Report()["data"]
                let contributions = data?["contributions"]
                Check.That(
                    Check.Text(data?["pairs"]?[0]?["status"]) == "unknown" && Check.Text(
                        contributions?[0]?["diff_status"]
                    ) == "unknown" &&
                        Check.Text(contributions?[1]?["diff_status"]) == "complete",
                    "Incomplete diff affected unrelated contribution"
                )
            }
            test.Flow.Reload()
            test.Flow.State["diff_fault"] = nil
            test.Flow.State["check_runs"] = Check.Map("total_count", 2, "check_runs", JsonArray())
            test.Flow.Save()
            let incomplete = test.Report()["data"]?["contributions"]?[0]
            Check.That(Check.Text(incomplete?["checks_status"]) == "unknown", "Incomplete check evidence passed")
            test.Flow.Reload()
            test.Flow.State["check_runs"] = Check.Map(
                "total_count",
                1,
                "check_runs",
                JsonArray(
                    Check.Map(
                        "name",
                        "verify",
                        "head_sha",
                        String('a', 40),
                        "status",
                        "completed",
                        "conclusion",
                        "success"
                    )
                )
            )
            test.Flow.Save()
            let staleChecks = test.Report()["data"]?["contributions"]?[0]
            Check.That(Check.Text(staleChecks?["checks_status"]) == "unknown", "Stale check head passed")
            test.Flow.Reload()
            test.Flow.State["check_runs"] = nil
            test.Flow.State["checks"] = JsonArray()
            test.Flow.Save()
            let missing = test.Report()["data"]?["contributions"]?[0]
            Check.That(
                Check.Text(missing?["check_count"]) == "0" && missing?["required_checks"]?.ToJsonString().Contains(
                    "verify"
                ) == true,
                "Missing exact-head checks hidden"
            )
            test.Flow.Faults(
                "repos/owner/project/issues/1/dependencies/blocked_by?per_page=100&page=1",
                Check.Json("[{\"status\":404}]")
            )
            let failed = test.Report()["data"]?["contributions"]
            Check.That(
                Check.Text(failed?[0]?["dependency_gate"]) == "unknown" && Check.Text(
                    failed?[1]?["dependencies_status"]
                ) == "complete",
                "Dependency API failure lost unrelated contribution"
            )
            test.Flow.Faults("repos/owner/project/pulls/10", Check.Json("[{\"status\":404}]"))
            let unavailable = test.Report()["data"]?["contributions"]
            Check.That(
                Check.Text(unavailable?[0]?["binding_status"]) == "unknown" && Check.Text(
                    unavailable?[1]?["binding_status"]
                ) == "validated",
                "PR API failure aborted report"
            )
            Console.WriteLine("PASS V" + version.ToString() + " incomplete diff/check evidence and API failures")
        }

        private func Gates(binary string, version int32) {
            using let test = OverlapFlow.Create(binary, version)
            for state in[]string{"open", "completed", "not_planned", "unknown", "missing", "duplicate"} {
                let dependency = Dependency(
                    7,
                    state == "open" ? "open": (state == "unknown" ? "unknown": "closed"),
                    state == "duplicate" ? "completed": state
                )
                if state == "missing" {
                    dependency.AsObject().Remove("state")
                    dependency.AsObject().Remove("state_reason")
                }
                if state == "duplicate" {
                    dependency["duplicate_of"] = Check.Map(
                        "number",
                        9,
                        "url",
                        "https://api.github.com/repos/other/project/issues/9"
                    )
                }
                test.Dependencies(JsonArray(dependency))
                let contributions = test.Report()["data"]?["contributions"]
                let expected = state == "open" ? "blocked": (
                    state == "completed" ? "no_open_dependencies": "owner_review"
                )
                Check.That(
                    Check.Text(contributions?[0]?["dependency_gate"]) == expected,
                    "Wrong native dependency gate for " + state
                )
                Check.That(
                    Check.Text(contributions?[1]?["dependency_gate"]) == "no_open_dependencies",
                    "Parsed dependency prose or traversed graph"
                )
                if state == "duplicate" {
                    Check.That(
                        Check.Text(
                            contributions?[0]?["dependencies"]?[0]?["resolution"]?["duplicate_of"]?["number"]
                        ) == "9",
                        "Native duplicate metadata lost"
                    )
                }
            }
            let pages = JsonArray()
            for page in 0 ... 10 {
                let entries = JsonArray()
                for n in 0 ... 100 {
                    entries.Add(Dependency(100 * page + n + 1, "closed", "completed"))
                }
                pages.Add(entries as JsonNode)
            }
            test.Flow.Reload()
            test.Flow.State["dependency_pages"] = Check.Map("1", pages)
            test.Flow.Save()
            let bounded = test.Report()
            let contribution = bounded["data"]?["contributions"]?[0]
            Check.That(
                Check.Text(bounded["truncated"]) == "true" && Check.Text(
                    contribution?["dependencies_status"]
                ) == "incomplete" &&
                    Check.Text(contribution?["dependency_gate"]) == "unknown",
                "Dependency cap claimed completeness"
            )
            test.Flow.Reload()
            var count int32
            for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                if Check.Text(call["path"]).Contains("issues/1/dependencies/") {
                    count++
                }
                Check.That(!Check.Text(call["path"]).Contains("other/project"), "Recursive dependency graph read")
            }
            Check.That(count == 10, "Dependency pagination exceeded cap")
            Console.WriteLine(
                "PASS V" + version.ToString() + " native dependency states, metadata, one-hop and capped output"
            )
        }

        private func Freshness(binary string, version int32, change string) {
            using let test = OverlapFlow.Create(
                binary,
                version,
                change == "target" || change == "retarget" ? "targets": "overlap"
            )
            let flow = test.Flow
            if change == "head" || change == "stale" || change == "retarget" {
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing pull")
                if change == "head" {
                    flow.State["check_read_effect"] = JsonValue.Create("head")
                } else if change == "retarget" {
                    flow.State["check_read_effect"] = JsonValue.Create("retarget")
                } else {
                    let head = pull["head"] ?? throw Exception("Missing head")
                    head["sha"] = JsonValue.Create(String('a', 40))
                }
                flow.Save()
            } else {
                File.WriteAllText(Path.Combine(flow.Upstream, "later.txt"), "Target advance\n")
                flow.Commit("Move selected target")
                let next = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
                if change == "target" {
                    flow.Git("-C", flow.Upstream, "update-ref", "refs/heads/main", test.Bases[0])
                    flow.Reload()
                    flow.State["overlap_move_target"] = Check.Map("branch", "main", "sha", next)
                    flow.Save()
                }
            }
            flow.ResetTraffic()
            let result = Check.Envelope(
                flow.Call([]string{"overlaps", "--repo", "owner/project", "--prs", "10,11", "--json"}),
                "overlaps",
                "ok"
            )
            let data = result["data"]
            let contributions = data?["contributions"]
            Check.That(
                Check.Text(contributions?[1]?["identity_status"]) == "stable",
                "Movement hid unrelated contribution"
            )
            if change == "moved-before" {
                Check.That(
                    Check.Text(contributions?[0]?["binding"]?["base"]) == test.Bases[0] && Check.Text(
                        contributions?[0]?["target_revision"]
                    ) != test.Bases[0] &&
                        Check.Text(contributions?[0]?["binding_status"]) == "validated",
                    "Target movement rewrote approved identity"
                )
            } else {
                Check.That(
                    Check.Text(contributions?[0]?["diff_status"]) == "unknown",
                    "Changing/stale identity retained overlap evidence"
                )
                Check.That(
                    Check.Text(data?["pairs"]?[0]?["status"]) == "unknown",
                    "Changing identity retained a known pair status: " + data?.ToJsonString()
                )
                if change == "retarget" {
                    Check.That(
                        Check.Text(contributions?[0]?["target_branch"]) == "main" && Check.Text(
                            contributions?[0]?["target_branch_after"]
                        ) == "release" &&
                            Check.Text(contributions?[0]?["identity_status"]) == "unknown",
                        "Fixture did not retarget the PR during collection"
                    )
                }
            }
            flow.NoInference()
            Console.WriteLine("PASS V" + version.ToString() + " overlap freshness: " + change)
        }

        internal func All(binary string) {
            if CiShard.Include("Overlaps/Inputs") {
                Inputs(binary)
            }
            for version in[]int32{1, 2} {
                let prefix = "Overlaps/V" + version.ToString() + "/"
                if CiShard.Include(prefix + "Files") {
                    Files(binary, version)
                }
                if CiShard.Include(prefix + "Evidence") {
                    Evidence(binary, version)
                }
                if CiShard.Include(prefix + "Gates") {
                    Gates(binary, version)
                }
                for change in[]string{"head", "retarget", "target", "stale", "moved-before"} {
                    if CiShard.Include(prefix + "Freshness/" + change) {
                        Freshness(binary, version, change)
                    }
                }
            }
        }
    }
}
