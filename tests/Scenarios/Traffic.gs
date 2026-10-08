package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class CommandTrafficChecks {
    shared {
        private func Budgets(
            flow NativeFixture,
            result Result,
            reads int32,
            writes int32,
            comments int32,
            conditional int32 = 0,
            retries int32 = 0
        ) {
            flow.Traffic(reads, writes, conditional, retries, result)
            flow.Reload()
            var posts int32
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                if Check.Text(call["method"]) == "POST" && Check.Text(call["path"]).EndsWith("/comments") {
                    posts++
                }
            }
            Check.That(posts == comments, "Comment POST budget exceeded")
            Console.WriteLine(
                "Comment attempts=" + posts.ToString() + " workflow records=" + Check.Text(
                    flow.State["workflow_records"] ?? JsonValue.Create(0)
                ) +
                    " privileged jobs=" +
                    Check.Text(flow.State["workflow_jobs"] ?? JsonValue.Create(0))
            )
        }

        private func Request(
            flow CoordinationFixture,
            request JsonNode,
            code int32 = 0,
            file string = "request-input.json"
        ) Result {
            let path = Path.Combine(flow.Flow.Temp.Root, file)
            File.WriteAllText(path, request.ToJsonString())
            return flow.Flow.Call(
                []string{"request", "--repo", "owner/project", "--issue", "1", "--file", path},
                code,
                traffic: true
            )
        }

        private func RequestReuse(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            let request = flow.ClaimRequest()
            flow.Flow.ResetTraffic()
            Budgets(flow.Flow, Request(flow, request), 10, 1, 1, 1)
            Check.That(
                File.GetUnixFileMode(Path.Combine(flow.Flow.Temp.Root, "request-input.json.posting.json")) ==
                (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                "Request posting journal is not private"
            )
            flow.Flow.ResetTraffic()
            Budgets(flow.Flow, Request(flow, request), 6, 0, 0)
            flow.Flow.Reload()
            Check.That(Check.Text(flow.Flow.State["request_count"]) == "1", "Identical request posted twice")
            let changed = request.DeepClone()
            changed["expected"] = JsonValue.Create(String('a', 40))
            flow.Flow.ResetTraffic()
            Check.Contains(Request(flow, changed, 1).Error, "binding changed")
            flow.Flow.Traffic(2, 0, 0, 0)
            flow.Coordinate(flow.Event(request))
            flow.Flow.ResetTraffic()
            Budgets(flow.Flow, Request(flow, request), 4, 0, 0)
            flow.Flow.ResetTraffic()
            Check.Contains(Request(flow, changed, 1, "new-file.json").Error, "UUID replay changed")
            flow.Flow.Traffic(4, 0, 0, 0)
            flow.Flow.NoInference()
            flow.Flow.NoPr()
        }

        private func JournalSafety(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            using let baseline = FixtureSnapshot(flow.Flow.Temp.Root)
            for kind in[]string{"link", "dangling", "existing", "partial", "race", "race-link"} {
                baseline.Restore()
                flow.Flow.Reload()
                let request = flow.ClaimRequest()
                let path = Path.Combine(flow.Flow.Temp.Root, "request-input.json.posting.json")
                let target = Path.Combine(flow.Flow.Temp.Root, "synthetic-journal-target")
                if kind == "link" {
                    File.WriteAllText(target, "synthetic-journal-sentinel")
                }
                if kind == "link" || kind == "dangling" {
                    File.CreateSymbolicLink(path, target)
                } else if kind == "existing" || kind == "partial" {
                    File.WriteAllText(path, kind == "partial" ? "{": "synthetic-journal-sentinel")
                } else {
                    flow.Flow.Reload()
                    flow.Flow.State["journal_race_path"] = JsonValue.Create(path)
                    flow.Flow.State["journal_race_link"] = JsonValue.Create(kind == "race-link")
                    flow.Flow.State["journal_race_target"] = JsonValue.Create(target)
                    flow.Flow.Save()
                }
                flow.Flow.ResetTraffic()
                Request(flow, request, 1)
                flow.Flow.Reload()
                Check.That(Check.Text(flow.Flow.State["request_count"]) == "", "Unsafe journal caused a POST")
                if kind == "link" || kind == "dangling" || kind == "race-link" {
                    Check.That(FileInfo(path).LinkTarget == target, "Journal link evidence was not preserved")
                }
                for call in flow.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    Check.That(Check.Text(call["method"]) == "GET", "Unsafe journal caused a GitHub write")
                }
                if kind == "link" {
                    Check.That(
                        File.ReadAllText(target) == "synthetic-journal-sentinel",
                        "Journal link changed its target"
                    )
                } else {
                    Check.That(!File.Exists(target), "Dangling journal created its target")
                }
                if kind == "existing" || kind == "race" || kind == "partial" {
                    Check.That(
                        File.ReadAllText(path) == (kind == "partial" ? "{": "synthetic-journal-sentinel"),
                        "Journal creation overwrote existing or partial evidence"
                    )
                }
            }
        }

        private func RequestAttempt(binary string, path string, env Dictionary[string, string], output Chan[Result]) {
            output <- TestProcess.Run(
                binary,
                []string{"request", "--repo", "owner/project", "--issue", "1", "--file", path},
                env
            )
        }

        private func SameFileRequest(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            let path = Path.Combine(flow.Flow.Temp.Root, "request-input.json")
            let request = flow.ClaimRequest()
            File.WriteAllText(path, request.ToJsonString())
            let target = Path.Combine(flow.Flow.Temp.Root, "synthetic-lock-target")
            File.CreateSymbolicLink(path + ".posting.lock", target)
            flow.Flow.Mode("lost_request_response")
            flow.Flow.ResetTraffic()
            let output = Chan[Result](2)
            let env = Dictionary[string, string](flow.Flow.Temp.Env)
            go RequestAttempt(binary, path, env, output)
            go RequestAttempt(binary, path, env, output)
            let first = <-output
            let second = <-output
            Check.That(
                (first.Code == 0 || first.Code == 1) &&
                    (second.Code == 0 || second.Code == 1) &&
                    (first.Code == 0 || second.Code == 0),
                "Same-file request had no reconciled winner: " + first.Error + second.Error
            )
            flow.Flow.Reload()
            var posts int32
            for call in flow.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                if Check.Text(call["method"]) == "POST" && Check.Text(call["path"]).EndsWith("/comments") {
                    posts++
                }
            }
            Check.That(
                posts == 1 && Check.Text(flow.Flow.State["request_count"]) == "1" && Check.Text(
                    flow.Flow.State["workflow_records"]
                ) == "1",
                "Concurrent lost-response request repeated its POST or workflow event"
            )
            Check.That(!File.Exists(target), "Request opened an untrusted posting lock link")
            Check.That(FileInfo(path + ".posting.lock").LinkTarget == target, "Request changed unrelated lock evidence")
            flow.Flow.ResetTraffic()
            Budgets(
                flow.Flow,
                flow.Flow.Call(
                    []string{"request", "--repo", "owner/project", "--issue", "1", "--file", path},
                    traffic: true
                ),
                6,
                0,
                0
            )
            flow.Flow.NoInference()
            flow.Flow.NoPr()
        }

        private func LostRequest(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            using let baseline = FixtureSnapshot(flow.Flow.Temp.Root)
            for mode in[]string{
                "lost_request_response",
                "request_fail_after_write",
                "request_rate_after_write",
                "request_fail_before_write",
                "request_ambiguous_after_write"
            } {
                baseline.Restore()
                flow.Flow.Reload()
                let request = flow.ClaimRequest()
                flow.Flow.Mode(mode)
                flow.Flow.ResetTraffic()
                let failed = mode == "request_fail_before_write" || mode == "request_ambiguous_after_write"
                let timer = Stopwatch.StartNew()
                let result = Request(flow, request, failed ? 1: 0)
                if mode == "request_rate_after_write" {
                    Check.That(
                        timer.Elapsed.TotalSeconds >= 1.0,
                        "Lost POST response ignored Retry-After before reconciliation"
                    )
                }
                Budgets(
                    flow.Flow,
                    result,
                    mode == "request_fail_before_write" ? 13:
                    (mode == "request_ambiguous_after_write" ? 15: 14),
                    1,
                    1,
                    mode == "request_fail_before_write" ? 4: 3
                )
                flow.Flow.Mode("")
                flow.Flow.ResetTraffic()
                let duplicate = Request(flow, request, failed ? 1: 0)
                Budgets(
                    flow.Flow,
                    duplicate,
                    mode == "request_fail_before_write" ? 5:
                    (mode == "request_ambiguous_after_write" ? 7: 6),
                    0,
                    0
                )
                flow.Flow.Reload()
                Check.That(
                    Check.Text(flow.Flow.State["request_count"]) == (mode == "request_fail_before_write" ? "": "1"),
                    "Uncertain response repeated a POST"
                )
                Check.That(
                    Check.Text(flow.Flow.State["workflow_records"]) == (mode == "request_fail_before_write" ? "": "1"),
                    "Uncertain response repeated a workflow record"
                )
            }
        }

        private func CanonicalRequest(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            using let baseline = FixtureSnapshot(flow.Flow.Temp.Root)
            for fault in[]string{
                "other-author",
                "issue",
                "repository",
                "actor",
                "changed-payload",
                "string-actor",
                "url-case",
                "url-path-case",
                "url-leading-zero",
                "url-query",
                "url-host-case"
            } {
                baseline.Restore()
                flow.Comment = 10
                let request = flow.ClaimRequest()
                let eventPath = flow.Event(request, fault == "other-author" ? 124: 123)
                let id = Check.Text(Check.Json(File.ReadAllText(eventPath))["comment"]?["id"])
                flow.Flow.Reload()
                let comment = flow.Flow.State["comments"]?[id] ?? throw Exception("Missing canonical comment")
                if fault == "issue" || fault == "repository" {
                    comment["issue_url"] = JsonValue.Create(
                        fault == "issue" ?
                        "https://api.github.com/repos/owner/project/issues/2": "https://api.github.com/repos/other/project/issues/1"
                    )
                } else if fault.StartsWith("url-") {
                    let urls = Check.Map(
                        "url-case",
                        "https://api.github.com/repos/OWNER/PROJECT/issues/1",
                        "url-path-case",
                        "https://api.github.com/repos/owner/project/Issues/1",
                        "url-leading-zero",
                        "https://api.github.com/repos/owner/project/issues/01",
                        "url-query",
                        "https://api.github.com/repos/owner/project/issues/1?extra",
                        "url-host-case",
                        "https://API.github.com/repos/owner/project/issues/1"
                    )
                    comment["issue_url"] = urls[fault]?.DeepClone()
                } else if fault == "actor" {
                    let altered = comment.DeepClone()
                    altered["user"] = Check.Map("id", 124, "login", "donor")
                    flow.Flow.State["canonical_comment_override"] = altered
                } else if fault == "changed-payload" {
                    let changed = request.DeepClone()
                    changed["expected"] = JsonValue.Create(String('a', 40))
                    comment["body"] = JsonValue.Create("/tokate " + changed.ToJsonString())
                } else if fault == "string-actor" {
                    flow.Flow.State["viewer_id"] = JsonValue.Create("123")
                }
                flow.Flow.Save()
                flow.Flow.ResetTraffic()
                let accepted = fault == "other-author" || fault == "url-case"
                let result = Request(flow, request, accepted ? 0: 1)
                if !accepted {
                    Check.Contains(
                        result.Error,
                        fault == "string-actor" ? "requires an element of type 'Number'": "Request UUID has changed actor, contents, repository or issue evidence"
                    )
                }
                flow.Flow.NoInference()
                flow.Flow.NoPr()
                flow.Flow.Reload()
                Check.That(
                    Check.Text(flow.Flow.State["request_count"]) == (fault == "other-author" ? "1": ""),
                    "Untrusted matching evidence caused a POST or suppressed useful work"
                )
            }
        }

        private func SubmitReuse(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            let claim = flow.Claim()
            let run = flow.Prepare()
            let commit = flow.Candidate(claim)
            flow.Flow.Call([]string{"external", "--run", run, "--commit", commit})
            flow.Flow.Mode("lost_request_response")
            flow.Flow.ResetTraffic()
            let first = flow.Flow.Call([]string{"submit", "--run", run}, traffic: true)
            Budgets(flow.Flow, first, 40, 1, 1, 26)
            flow.Flow.Mode("")
            flow.Flow.ResetTraffic()
            let duplicate = flow.Flow.Call([]string{"submit", "--run", run}, traffic: true)
            Budgets(flow.Flow, duplicate, 30, 0, 0, 17)
            flow.Flow.Reload()
            let request = Check.PostedRequest(flow.Flow.State)
            flow.Coordinate(flow.Event(request))
            flow.Flow.ResetTraffic()
            Budgets(flow.Flow, flow.Flow.Call([]string{"submit", "--run", run}, traffic: true), 30, 0, 0, 15)
            flow.Expire()
            flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1)
            flow.Flow.ResetTraffic()
            Budgets(flow.Flow, flow.Flow.Call([]string{"submit", "--run", run}, 1, traffic: true), 3, 0, 0)
            flow.Flow.Reload()
            Check.That(
                flow.Flow.State["pulls"]?.AsArray().Count == 1 && Check.Text(flow.Flow.State["request_count"]) == "1",
                "Recorded submission created another PR or comment"
            )
        }

        private func Published(flow NativeFixture, decree string = "") string {
            flow.Initialize()
            if decree != "" {
                File.WriteAllText(Path.Combine(flow.Upstream, "DECREE.md"), decree)
                flow.Commit("Owner instructions")
                flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, "main")
            }
            flow.Approve()
            let run = flow.Claim()
            flow.Call([]string{"work", "--run", run})
            flow.Reload()
            return run
        }

        private func Watch(
            flow NativeFixture,
            run string,
            timeout string,
            code int32 = 8,
            direct bool = false
        ) Result -> flow
            .Call(
            direct ? []string{"checks", "--repo", "owner/project", "--pr", "10", "--watch", "--timeout", timeout}:
            []string{"checks", "--run", run, "--watch", "--timeout", timeout},
            code,
            traffic: true
        )

        private func WatchDeadline(binary string) {
            using let flow = NativeFixture(binary)
            let run = Published(flow)
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for kind in[]string{
                "initial-authority",
                "approval-read",
                "check-read",
                "dependency-read",
                "rate-limit",
                "rate-reset",
                "poll-delay"
            } {
                baseline.Restore()
                flow.Reload()
                let commit = Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"])
                let path = switch kind {
                    case "initial-authority": "repos/owner/project/pulls/10"
                    case "approval-read": "repos/owner/project/issues/1"
                    case "dependency-read": "repos/owner/project/issues/1/dependencies/blocked_by?per_page=100&page=1"
                    default: "repos/owner/project/commits/" + commit + "/check-runs?per_page=100&page=1"
                }
                if kind == "dependency-read" {
                    flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
                }
                if kind == "poll-delay" {
                    flow.State["poll_interval"] = JsonValue.Create("10")
                } else {
                    flow.State["fault_path"] = JsonValue.Create(path)
                    flow.State["faults"] = kind == "rate-limit" ?
                    Check.Json("[{\"status\":429,\"headers\":\"Retry-After: 10\\r\\n\"}]"):
                    Check.Json("[{\"status\":200,\"pause_ms\":3000}]")
                }
                if kind == "rate-reset" {
                    let faults = JsonArray()
                    faults.Add(
                        Check.Map(
                            "status",
                            429,
                            "headers",
                            "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: " +
                                (DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 10).ToString() + "\r\n"
                        )
                    )
                    flow.State["faults"] = faults
                }
                flow.Save()
                flow.ResetTraffic()
                let timer = Stopwatch.StartNew()
                let result = kind == "initial-authority" ? flow.Call(
                    []string{"checks", "--repo", "owner/project", "--pr", "10", "--watch", "--timeout", "1"},
                    8,
                    traffic: true
                ): Watch(flow, run, "1")
                Check.Contains(result.Output, "timeout")
                flow.Reload()
                var checkReads int32
                for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    if Check.Text(call["path"]) == path {
                        checkReads++
                    }
                    Check.That(Check.Text(call["method"]) == "GET", "Watch mutated GitHub")
                }
                Check.That(checkReads == 1, "Deadline retried or polled past server delay")
                Console.WriteLine("Bounded watch " + kind + " elapsed=" + timer.Elapsed.TotalSeconds.ToString("F2"))
            }
        }

        private func MovedDecreeDeadline(binary string) {
            for kind in[]string{"tree", "blob"} {
                using let flow = NativeFixture(binary)
                let run = Published(flow, "Owner instructions\n")
                File.WriteAllText(Path.Combine(flow.Upstream, "later.txt"), "Unrelated target change\n")
                flow.Commit("Advance target with unchanged instructions")
                let object = flow.Git(
                    "-C",
                    flow.Upstream,
                    "rev-parse",
                    kind == "tree" ? "HEAD^{tree}": "HEAD:DECREE.md"
                )
                flow.State["fault_path"] = JsonValue.Create(
                    "repos/owner/project/git/" + (kind == "tree" ? "trees/": "blobs/") + object
                )
                flow.State["faults"] = Check.Json("[{\"status\":200,\"pause_ms\":3000}]")
                flow.Save()
                flow.ResetTraffic()
                let result = Watch(flow, run, "1")
                Check.Contains(result.Output, "timeout")
                flow.Reload()
                Check.That(
                    Check.Text(flow.State["fault_index"]) == "1",
                    "Instruction deadline was not exercised exactly once"
                )
                for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    Check.That(Check.Text(call["method"]) == "GET", "Instruction deadline caused a write")
                }
            }
        }

        private func WatchStructured(binary string) {
            using let flow = NativeFixture(binary)
            let run = Published(flow)
            let pending = Check.Envelope(flow.Call([]string{"checks", "--run", run, "--json"}, 8), "checks", "pending")
            Check.That(Check.Text(pending["data"]?["checks_status"]) == "pending", "Pending check projection missing")
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            flow.Save()
            let passed = Check.Envelope(flow.Call([]string{"checks", "--run", run, "--json"}), "checks", "ok")
            Check.That(
                Check.Text(passed["data"]?["checks_status"]) == "passed" && Check.Text(
                    passed["data"]?["check_count"]
                ) == "1" &&
                    Check.Text(passed["data"]?["checks"]?[0]?["name"]) == "verify" && Check.Text(
                    passed["data"]?["checks"]?[0]?["bucket"]
                ) == "pass",
                "REST checks did not use the shared public projection"
            )
            for kind in[]string{"open", "not_planned", "unavailable", "completed"} {
                flow.Reload()
                flow.State["dependency_pages"] = Check.Map(
                    "1",
                    JsonArray(
                        JsonArray(
                            Check.Map(
                                "number",
                                7,
                                "url",
                                "https://api.github.com/repos/other/project/issues/7",
                                "state",
                                kind == "open" ? "open": "closed",
                                "state_reason",
                                kind
                            )
                        )
                    )
                )
                flow.Save()
                flow.Faults(
                    kind == "unavailable" ? "repos/owner/project/issues/1/dependencies/blocked_by?per_page=100&page=1": "",
                    Check.Json("[{\"status\":404}]")
                )
                Check.Envelope(
                    flow.Call(
                        kind == "open" || kind == "not_planned" ?
                        []string{"checks", "--repo", "owner/project", "--pr", "10", "--json"}:
                        []string{"checks", "--run", run, "--json"},
                        kind == "completed" ? 0: 1
                    ),
                    "checks",
                    kind == "completed" ? "ok": "error",
                    kind == "completed" ? "": "invalid_state"
                )
            }
            flow.Reload()
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"fail\"}]")
            flow.Save()
            flow.ResetTraffic()
            let failed = flow.Call([]string{"checks", "--run", run, "--json"}, 1, traffic: true)
            Check.Envelope(failed, "checks", "error", "verification_failed")
            Budgets(flow, failed, 23, 0, 0, 12)
        }

        private func WatchTraffic(binary string) {
            using let flow = NativeFixture(binary)
            let run = Published(flow)
            flow.ResetTraffic()
            let pending = flow.Call([]string{"checks", "--run", run}, 8, traffic: true)
            Budgets(flow, pending, 23, 0, 0, 12)
            flow.ResetTraffic()
            let direct = flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10"}, 8, traffic: true)
            Budgets(flow, direct, 23, 0, 0, 12)
            let path = Path.Combine(run, "checks.json")
            flow.Reload()
            flow.State["check_state_path"] = JsonValue.Create(path)
            flow.State["check_sequence"] = Check.Json("[[],[],[{\"name\":\"verify\",\"bucket\":\"pass\"}]]")
            flow.State["check_polls"] = JsonValue.Create(0)
            flow.Save()
            flow.ResetTraffic()
            let result = Watch(flow, run, "10", 0)
            Budgets(flow, result, 70, 0, 0, 57)
            Check.That(result.Output.Split("Checks pending").Length == 2, "Unchanged polls repeated output")
            flow.Reload()
            let observations = flow.State["check_state_times"]
            let times = observations?.AsArray() ?? throw Exception("Missing local state observations")
            Check.That(
                times.Count == 3 && Check.Text(times[0]) == Check.Text(times[1]) && Check.Text(times[1]) == Check.Text(
                    times[2]
                ),
                "Unchanged pending polls rewrote local state"
            )
            flow.State["check_polls"] = JsonValue.Create(0)
            flow.Save()
            flow.ResetTraffic()
            Budgets(flow, Watch(flow, run, "10", 0, true), 70, 0, 0, 57)
        }

        private func WatchChanges(binary string) {
            using let flow = NativeFixture(binary)
            let run = Published(flow)
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for direct in[]bool{false, true} {
                for kind in[]string{"head", "approval"} {
                    baseline.Restore()
                    flow.Reload()
                    flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
                    flow.State["check_read_effect"] = JsonValue.Create(kind)
                    flow.Save()
                    flow.ResetTraffic()
                    let result = Watch(flow, run, "5", 1, direct)
                    Check.Contains(result.Error, kind == "head" ? "PR head changed": "Issue needs Tokate approval")
                    Budgets(flow, result, kind == "head" ? 14: 15, 0, 0, kind == "head" ? 1: 2)
                }
            }
        }

        private func CacheRetention(binary string) {
            using let flow = NativeFixture(binary)
            let run = Published(flow)
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for size in[]int32{1024 * 1024, 3 * 1024 * 1024} {
                for revoked in[]bool{false, true} {
                    baseline.Restore()
                    flow.Reload()
                    flow.State["response_padding"] = Check.Map(
                        "repos/owner/project",
                        size,
                        "repos/owner/project/issues/1",
                        size
                    )
                    flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
                    if revoked {
                        flow.State["check_read_effect"] = JsonValue.Create("approval")
                    }
                    flow.Save()
                    flow.ResetTraffic()
                    let result = flow.Call([]string{"checks", "--run", run}, revoked ? 1: 0, traffic: true)
                    if revoked {
                        Check.Contains(result.Error, "Issue needs Tokate approval")
                    }
                    flow.Reload()
                    for path in[]string{"repos/owner/project", "repos/owner/project/issues/1"} {
                        var full int32
                        for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                            if Check.Text(call["path"]) == path {
                                Check.That(
                                    Check.Text(call["conditional"]) == "false",
                                    "Evicted or oversized response supplied a validator"
                                )
                                Check.That(Check.Text(call["status"]) == "200", "Evicted read was not fully fetched")
                                full++
                            }
                        }
                        let expected = revoked && path == "repos/owner/project" ? 1: 2
                        Check.That(full >= expected, "Missing full fetch after cache eviction or non-admission")
                    }
                }
            }
            baseline.Restore()
            flow.Reload()
            flow.State["response_padding"] = Check.Map(
                "repos/owner/project",
                1024 * 1024,
                "repos/owner/project/issues/1",
                1024 * 1024
            )
            flow.State["etag_force_304"] = JsonValue.Create(true)
            flow.Save()
            flow.ResetTraffic()
            let unmatched = flow.Call([]string{"checks", "--run", run}, 1, traffic: true)
            Check.Contains(unmatched.Error, "HTTP 304 without a matching in-memory body")
            flow.Reload()
            let calls = flow.State["api_calls"]?.AsArray() ?? throw Exception("Missing traffic evidence")
            let last = calls[calls.Count - 1] ?? throw Exception("Missing last request")
            Check.That(
                Check.Text(last["status"]) == "304" && Check.Text(last["conditional"]) == "false",
                "Evicted body supplied a validator or authority for an unmatched 304"
            )
        }

        internal func All(binary string, selected string = "") {
            for test in[]TestCase[string]{
                TestCase[string]("RequestReuse", async (value string) -> RequestReuse(value)),
                TestCase[string]("JournalSafety", async (value string) -> JournalSafety(value)),
                TestCase[string]("SameFileRequest", async (value string) -> SameFileRequest(value)),
                TestCase[string]("LostRequest", async (value string) -> LostRequest(value)),
                TestCase[string]("CanonicalRequest", async (value string) -> CanonicalRequest(value)),
                TestCase[string]("SubmitReuse", async (value string) -> SubmitReuse(value)),
                TestCase[string]("WatchDeadline", async (value string) -> WatchDeadline(value)),
                TestCase[string]("MovedDecreeDeadline", async (value string) -> MovedDecreeDeadline(value)),
                TestCase[string]("WatchStructured", async (value string) -> WatchStructured(value)),
                TestCase[string]("ComposedChecks", async (value string) -> CheckGates.All(value)),
                TestCase[string]("WatchTraffic", async (value string) -> WatchTraffic(value)),
                TestCase[string]("WatchChanges", async (value string) -> WatchChanges(value)),
                TestCase[string]("CacheRetention", async (value string) -> CacheRetention(value))
            } {
                let name = test.Name
                if selected != "" && selected != name {
                    continue
                }
                if !CiShard.Include("Traffic/" + name) {
                    continue
                }
                test.Run(binary)
                Console.WriteLine("PASS command traffic " + name)
            }
        }
    }
}
