package TokateTests

import System
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class CommandTrafficChecks {
    shared {
        private func Budgets(
            flow NativeFlow,
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
            flow CoordinationFlow,
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
            using let flow = CoordinationFlow(binary)
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
            for kind in[]string{"link", "dangling", "existing", "partial", "race", "race-link"} {
                using let flow = CoordinationFlow(binary)
                flow.Initialize()
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

        private func LostRequest(binary string) {
            for mode in[]string{
                "lost_request_response",
                "request_fail_after_write",
                "request_rate_after_write",
                "request_fail_before_write",
                "request_ambiguous_after_write"
            } {
                using let flow = CoordinationFlow(binary)
                flow.Initialize()
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
            for fault in[]string{"other-author", "issue", "repository", "actor", "changed-payload", "string-actor"} {
                using let flow = CoordinationFlow(binary)
                flow.Initialize()
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
                Request(flow, request, fault == "other-author" ? 0: 1)
                flow.Flow.Reload()
                Check.That(
                    Check.Text(flow.Flow.State["request_count"]) == (fault == "other-author" ? "1": ""),
                    "Untrusted matching evidence caused a POST or suppressed useful work"
                )
            }
        }

        private func SubmitReuse(binary string) {
            using let flow = CoordinationFlow(binary)
            flow.Initialize()
            let claim = flow.Claim()
            let run = flow.Prepare()
            let commit = flow.Candidate(claim)
            flow.Flow.Call([]string{"external", "--run", run, "--commit", commit})
            flow.Flow.Mode("lost_request_response")
            flow.Flow.ResetTraffic()
            let first = flow.Flow.Call([]string{"submit", "--run", run}, traffic: true)
            Budgets(flow.Flow, first, 22, 1, 1, 11)
            flow.Flow.Mode("")
            flow.Flow.ResetTraffic()
            let duplicate = flow.Flow.Call([]string{"submit", "--run", run}, traffic: true)
            Budgets(flow.Flow, duplicate, 17, 0, 0, 7)
            flow.Flow.Reload()
            let request = Check.Json(Check.Text(flow.Flow.State["posted_request"]?["body"]).Substring(8))
            flow.Coordinate(flow.Event(request))
            flow.Flow.ResetTraffic()
            Budgets(flow.Flow, flow.Flow.Call([]string{"submit", "--run", run}, traffic: true), 8, 0, 0)
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

        private func Published(flow NativeFlow) string {
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Call([]string{"work", "--run", run})
            flow.Reload()
            return run
        }

        private func Watch(flow NativeFlow, run string, timeout string, code int32 = 8) Result -> flow.Call(
            []string{"checks", "--run", run, "--watch", "--timeout", timeout},
            code,
            traffic: true
        )

        private func WatchDeadline(binary string) {
            for kind in[]string{
                "initial-authority",
                "approval-read",
                "check-read",
                "rate-limit",
                "rate-reset",
                "poll-delay"
            } {
                using let flow = NativeFlow(binary)
                let run = Published(flow)
                let commit = Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"])
                let path = kind == "initial-authority" ? "repos/owner/project/pulls/10":
                (
                    kind == "approval-read" ? "repos/owner/project/issues/1":
                    "repos/owner/project/commits/" + commit + "/check-runs?per_page=100&page=1"
                )
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
                Check.That(timer.Elapsed.TotalSeconds < 1.7, "Entire watch exceeded timeout: " + kind)
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

        private func WatchTraffic(binary string) {
            using let flow = NativeFlow(binary)
            let run = Published(flow)
            flow.ResetTraffic()
            let pending = flow.Call([]string{"checks", "--run", run}, 8, traffic: true)
            Budgets(flow, pending, 24, 0, 0, 12)
            let path = Path.Combine(run, "checks.json")
            flow.Reload()
            flow.State["check_state_path"] = JsonValue.Create(path)
            flow.State["check_sequence"] = Check.Json("[[],[],[{\"name\":\"verify\",\"bucket\":\"pass\"}]]")
            flow.State["check_polls"] = JsonValue.Create(0)
            flow.Save()
            flow.ResetTraffic()
            let result = Watch(flow, run, "10", 0)
            Budgets(flow, result, 72, 0, 0, 59)
            Check.That(result.Output.Split("Checks pending").Length == 2, "Unchanged polls repeated output")
            flow.Reload()
            let times = flow.State["check_state_times"]?.AsArray() ??
                throw Exception("Missing local state observations")
            Check.That(
                times.Count == 3 && Check.Text(times[0]) == Check.Text(times[1]) && Check.Text(times[1]) == Check.Text(
                    times[2]
                ),
                "Unchanged pending polls rewrote local state"
            )
        }

        private func WatchChanges(binary string) {
            for kind in[]string{"head", "approval"} {
                using let flow = NativeFlow(binary)
                let run = Published(flow)
                flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
                flow.State["check_read_effect"] = JsonValue.Create(kind)
                flow.Save()
                flow.ResetTraffic()
                let result = Watch(flow, run, "5", 1)
                Check.Contains(result.Error, kind == "head" ? "PR changed": "Issue needs Tokate approval")
                Budgets(flow, result, kind == "head" ? 15: 17, 0, 0, kind == "head" ? 2: 4)
            }
        }

        internal func All(binary string, selected string = "") {
            for name in[]string{
                "RequestReuse",
                "JournalSafety",
                "LostRequest",
                "CanonicalRequest",
                "SubmitReuse",
                "WatchDeadline",
                "WatchTraffic",
                "WatchChanges"
            } {
                if selected != "" && selected != name {
                    continue
                }
                switch name {
                    case "RequestReuse" {
                        RequestReuse(binary)
                    }
                    case "JournalSafety" {
                        JournalSafety(binary)
                    }
                    case "LostRequest" {
                        LostRequest(binary)
                    }
                    case "CanonicalRequest" {
                        CanonicalRequest(binary)
                    }
                    case "SubmitReuse" {
                        SubmitReuse(binary)
                    }
                    case "WatchDeadline" {
                        WatchDeadline(binary)
                    }
                    case "WatchTraffic" {
                        WatchTraffic(binary)
                    }
                    case "WatchChanges" {
                        WatchChanges(binary)
                    }
                }
                Console.WriteLine("PASS command traffic " + name)
            }
        }
    }
}
