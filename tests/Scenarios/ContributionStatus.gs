package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.Json.Nodes

internal class ContributionStatusChecks {
    shared {
        private func Read(test CoordinationFixture, code int32 = 0, owner bool = false, index bool = false) JsonNode {
            let args = index ? []string{"status", "--repo", "owner/project", "--json"}: []string{
                "status",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--json"
            }
            test.Flow.ResetTraffic()
            let result = Check.Envelope(
                test.Flow.Call(args, code, owner),
                "status",
                code == 0 ? "ok": "error",
                code == 0 ? "": "command_failed"
            )
            test.Flow.Reload()
            for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Status wrote to GitHub")
            }
            Check.That(!result.ToJsonString().Contains("--run"), "Remote status invented a local run command")
            let next = result["data"]?["next"]?["command"]
            if next != nil && next.AsArray().Count > 0 {
                Check.That(
                    result["next_actions"]?[0]?.ToJsonString() == next.ToJsonString(),
                    "Structured next action differs from displayed command"
                )
            }
            test.Flow.NoInference()
            return result
        }

        private func Row(result JsonNode) JsonNode -> result["data"]?["work"]?[0] ??
            throw Exception("Missing status work")

        private func Access(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize(false)
            let waiting = Row(Read(test))
            Check.That(Check.Text(waiting["state"]) == "approval_waiting", "Absent approval is ready")
            test.Flow.Call([]string{"access", "--repo", "owner/project", "--operation", "init"}, owner: true)
            let path = Path.Combine(test.Flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["approval_scope"] = JsonValue.Create("task")
            policy["eligibility"] = JsonValue.Create("trusted")
            File.WriteAllText(path, policy.ToJsonString())
            test.Flow.Commit("Trusted status policy")
            test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
            let needsRequest = Row(Read(test))
            Check.That(
                Check.Text(needsRequest["next"]?["role"]) == "donor" && Check.Text(
                    needsRequest["next"]?["command"]?[5]
                ) == "request",
                "Missing donor access request action"
            )
            test.Flow.Call(
                []string{
                    "access",
                    "--repo",
                    "owner/project",
                    "--operation",
                    "request",
                    "--issue",
                    "1",
                    "--scope",
                    "trust"
                }
            )
            let pending = Read(test, owner: true, index: true)
            Check.That(pending["data"]?["pending_requests"]?.AsArray().Count == 1, "Status hid pending access")
            Check.That(Check.Text(pending["data"]?["next"]?["role"]) == "owner", "Request responsibility missing")
            Check.That(Check.Text(Row(pending)["approval_status"]) == "current", "Task approval was not validated")
            Check.That(Check.Text(Row(Read(test))["state"]) == "access_waiting", "Untrusted donor became eligible")
            test.Flow.Call(
                []string{"access", "--repo", "owner/project", "--operation", "trust", "--donor", "donor"},
                owner: true
            )
            let eligible = Read(test)
            Check.That(eligible["data"]?["pending_requests"]?.AsArray().Count == 0, "Granted access remained pending")
            Check.That(Check.Text(Row(eligible)["state"]) == "reservation_needed", "Trusted donor was not eligible")
            Check.That(Row(eligible)["next"]?["command"]?.AsArray().Count == 0, "Status invented a request file")
            let owner = Row(Read(test, owner: true))
            Check.That(
                Check.Text(owner["state"]) == "reservation_needed" && Check.Text(
                    owner["eligibility_scope"]
                ) == "viewer",
                "Owner eligibility was presented as task-wide access waiting"
            )
            Check.Contains(Check.Text(owner["next"]?["action"]), "An eligible donor must select the task")
            test.Flow.Reload()
            test.Flow.State["access_revoke_after_path"] = JsonValue.Create("repos/owner/project/issues/1")
            test.Flow.State["access_revoke_after_read"] = JsonValue.Create(1)
            test.Flow.Save()
            let changedAccess = Read(test)
            Check.That(
                Check.Text(changedAccess["data"]?["remote_status"]) == "stale" && Check.Text(
                    Row(changedAccess)["state"]
                ) == "stale_remote_data",
                "Access changed during status was presented as current"
            )
            test.Flow.Reload()
            test.Flow.State["access_revoke_after_path"] = nil
            test.Flow.Save()
            test.Flow.Call(
                []string{"access", "--repo", "owner/project", "--operation", "restore", "--donor", "donor"},
                owner: true
            )

            test.Flow.Reload()
            let task = test.Flow.State["issue"] ?? throw Exception("Missing task")
            task["title"] = JsonValue.Create("Task changed after approval")
            test.Flow.Save()
            let stale = Row(Read(test))
            Check.That(
                Check.Text(stale["approval_status"]) == "stale" && Check.Text(stale["state"]) == "approval_waiting",
                "Changed task is ready"
            )
            test.Flow.Reload()
            let comments = JsonObject()
            for number in 1 ... 201 {
                comments[number.ToString()] = Check.Map(
                    "id",
                    number,
                    "body",
                    "/tokate-access {\"version\":1,\"scope\":\"issue\",\"issue\":1}",
                    "user",
                    Check.Map("id", 1000 + number, "login", "donor" + number.ToString()),
                    "issue_url",
                    "https://api.github.com/repos/owner/project/issues/1"
                )
            }
            test.Flow.State["comments"] = comments
            test.Flow.Save()
            let bounded = Read(test)
            Check.That(
                Check.Text(bounded["truncated"]) == "true" && bounded["data"]?["pending_requests"]?.AsArray()
                    .Count == 20 &&
                    Check.Text(bounded["data"]?["pending_requests_observed"]) == "200",
                "Request bounds or truncation omitted"
            )
            test.Flow.Reload()
            test.Flow.State["fault_path"] = JsonValue.Create(
                "repos/owner/project/issues/1/comments?per_page=100&page=2"
            )
            test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
            test.Flow.State["fault_index"] = JsonValue.Create(0)
            test.Flow.Save()
            let partial = Read(test, 1)
            Check.That(
                Check.Text(partial["data"]?["requests_status"]) == "unavailable" && Check.Text(
                    partial["data"]?["pending_requests_observed"]
                ) == "100",
                "Later request failure discarded observed requests"
            )
        }

        private func Leases(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let request = test.ClaimRequest()
            test.Coordinate(test.Event(request))
            let active = Row(Read(test))
            Check.That(Check.Text(active["state"]) == "attempt_recorded", "Active attempt omitted")
            Check.Contains(Check.Text(active["reservation"]?["local_process"]), "does not prove")
            Check.That(
                Check.Text(active["reservation"]?["attempt"]) == Check.Text(request["uuid"]),
                "Attempt identity lost"
            )
            let state = test.State()
            let pause = Check.Map(
                "uuid",
                Guid.NewGuid().ToString("D"),
                "expected",
                Check.Text(state["sha"]),
                "approval",
                Check.Text(state["state"]?["approval_id"]),
                "action",
                "pause",
                "metadata",
                Check.Json("{}")
            )
            test.Coordinate(test.Event(pause))
            let paused = Row(Read(test))
            Check.That(
                Check.Text(paused["state"]) == "paused" && Check.Text(paused["reservation"]?["attempt"]) == "",
                "Paused attempt misrepresented"
            )
            test.Expire()
            let expired = Row(Read(test))
            Check.That(
                Check.Text(expired["state"]) == "lease_expired_or_released" && Check.Text(
                    expired["reservation"]?["expired"]
                ) == "true",
                "Lease expiry omitted"
            )
            Check.That(
                !Directory.Exists(Path.Combine(test.Flow.Temp.Root, "runs")),
                "Remote status required a local run"
            )
        }

        private func Draft(test CoordinationFixture, claim JsonNode, head string) {
            test.Flow.Reload()
            test.Flow.State["pulls"] = Check.Json("[]")
            test
                .Flow
                .State["pulls"]
                ?.AsArray()
                .Add(
                Check.Map(
                    "number",
                    10,
                    "html_url",
                    "https://github.com/owner/project/pull/10",
                    "state",
                    "open",
                    "draft",
                    true,
                    "body",
                    "Work in progress without a receipt",
                    "user",
                    Check.Map("login", "donor", "id", 123),
                    "base",
                    Check.Map("ref", "main", "repo", Check.Map("id", 1, "full_name", "owner/project")),
                    "head",
                    Check.Map(
                        "sha",
                        head,
                        "ref",
                        "tokate/v2-" + Check.Text(claim["uuid"]),
                        "repo",
                        Check.Map(
                            "id",
                            2,
                            "full_name",
                            "donor/project",
                            "owner",
                            Check.Map("login", "donor", "id", 123)
                        )
                    )
                )
            )
            test.Flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            test.Flow.Save()
        }

        private func Drafts(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let claim = test.ClaimRequest()
            test.Coordinate(test.Event(claim))
            let head = test.Candidate(claim)
            Draft(test, claim, head)
            let incomplete = Row(Read(test))
            Check.That(Check.Text(incomplete["state"]) == "incomplete_draft", "Incomplete receipt became readiness")
            Check.That(
                Check.Text(incomplete["drafts"]?[0]?["binding"]) == "canonical",
                "Incomplete canonical draft omitted"
            )
            Check.That(Check.Text(incomplete["drafts"]?[0]?["checks_head"]) == head, "Checks were not bound to PR head")
            test.Flow.Reload()
            test.Flow.State["checks"] = Check.Json("[]")
            test.Flow.Save()
            let missing = Row(Read(test))
            Check.That(
                Check.Text(missing["state"]) == "ci_pending" && Check.Text(
                    missing["drafts"]?[0]?["required_checks"]?[0]?["status"]
                ) == "missing",
                "Missing check became success"
            )
            for bucket in[]string{"pending", "fail"} {
                test.Flow.Reload()
                test.Flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"" + bucket + "\"}]")
                test.Flow.Save()
                let row = Row(Read(test))
                Check.That(Check.Text(row["state"]) == (bucket == "fail" ? "ci_failed": "ci_pending"), "CI state lost")
            }
            test.Flow.Reload()
            test.Flow.State["check_runs"] = Check.Map(
                "total_count",
                1,
                "check_runs",
                Check.Json(
                    "[{\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"action_required\",\"html_url\":\"https://github.com/owner/project/actions/runs/123\"}]"
                )
            )
            test.Flow.Save()
            let action = Read(test)
            Check.That(
                Check.Text(Row(action)["state"]) == "ci_blocked" && Check.Text(
                    Row(action)["drafts"]?[0]?["required_checks"]?[0]?["status"]
                ) == "blocked",
                "action_required became a test failure or approval waiting"
            )
            Check.Contains(Check.Text(Row(action)["drafts"]?[0]?["workflow_wait_reason"]), "unknown")
            Check.That(
                Check.Text(Row(action)["next"]?["role"]) == "owner" && Check.Text(
                    Row(action)["next"]?["command"]?[0]
                ) == "gh",
                "Unknown action_required reason did not direct owner to the PR"
            )
            test.Flow.Reload()
            test.Flow.State["check_runs"] = nil
            test.Flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            test.Flow.State["reviews"] = Check.Map(
                "10",
                Check.Json(
                    "[{\"user\":{\"login\":\"owner\"},\"state\":\"APPROVED\",\"commit_id\":\"" +
                        String('a', 40) +
                        "\"},{\"user\":{\"login\":\"owner\"},\"state\":\"CHANGES_REQUESTED\",\"commit_id\":\"" +
                        head +
                        "\"}]"
                )
            )
            test.Flow.Save()
            let review = Row(Read(test))
            Check.That(
                Check.Text(review["drafts"]?[0]?["review_status"]) == "changes_requested" && Check.Text(
                    review["next"]?["role"]
                ) == "donor",
                "Exact-head review state omitted"
            )
            test.Flow.Reload()
            test.Flow.State["fault_path"] = JsonValue.Create(
                "repos/owner/project/commits/" + head + "/status?per_page=100&page=1"
            )
            test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
            test.Flow.State["fault_index"] = JsonValue.Create(0)
            test.Flow.Save()
            let failed = Row(Read(test, 1))
            Check.That(
                Check.Text(failed["state"]) == "unavailable" && Check.Text(failed["drafts"]?[0]?["head"]) == head,
                "API failure discarded observed PR"
            )
            Check.That(
                Check.Text(failed["drafts"]?[0]?["checks_status"]) == "unavailable" &&
                    failed["drafts"]?[0]?["checks"]
                    ?.AsArray().Count == 1,
                "API failure discarded observed checks"
            )
            test.Flow.Reload()
            test.Flow.State["fault_path"] = nil
            test.Flow.State["check_read_effect"] = JsonValue.Create("head")
            test.Flow.Save()
            let moved = Row(Read(test))
            Check.That(Check.Text(moved["state"]) == "stale_remote_data", "Changed PR head became ready")
        }

        private func Published(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let claim = test.ClaimRequest()
            test.Coordinate(test.Event(claim))
            let head = test.Candidate(claim)
            test.Coordinate(test.Event(test.PublishRequest(claim, head)))
            test.Flow.Reload()
            test.Flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            test.Flow.Save()
            let published = Row(Read(test, owner: true))
            Check.That(Check.Text(published["state"]) == "owner_review", "Recorded contribution omitted owner review")
            Check.That(
                Check.Text(published["next"]?["command"]?[1]) == "verify-pr",
                "Owner receipt verification command omitted"
            )
            Check.Contains(Check.Text(published["drafts"]?[0]?["receipt"]), "unverified")
            test.Flow.Reload()
            test.Flow.State["reviews"] = Check.Map(
                "10",
                Check.Json(
                    "[{\"user\":{\"login\":\"owner\"},\"state\":\"APPROVED\",\"commit_id\":\"" +
                        head +
                        "\"},{\"user\":{\"login\":\"owner\"},\"state\":\"COMMENTED\",\"commit_id\":\"" +
                        head +
                        "\"}]"
                )
            )
            test.Flow.Save()
            let reviewed = Row(Read(test, owner: true))
            Check.That(
                Check.Text(reviewed["drafts"]?[0]?["review_status"]) == "approval_recorded" && Check.Text(
                    reviewed["state"]
                ) == "owner_review",
                "Comment cleared a recorded approval or made work ready"
            )

            test.Expire()
            let expired = Row(Read(test))
            Check.That(
                Check.Text(expired["state"]) == "owner_review" && expired["drafts"]?.AsArray().Count == 1 && Check.Text(
                    expired["next"]?["command"]?[1]
                ) == "verify-pr" &&
                    Check.Text(expired["reservation"]?["expired"]) == "true",
                "Expired lease replaced canonical published PR review"
            )
        }

        private func Discovery(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            test.Flow.Reload()
            let issue = test.Flow.State["issue"]?.DeepClone() ?? throw Exception("Missing issue")
            let issues = JsonObject()
            issues["1"] = issue.DeepClone()
            for number in 2 ... 21 {
                let row = issue.DeepClone()
                row["number"] = JsonValue.Create(number)
                if number == 2 {
                    row["pull_request"] = Check.Map("url", "synthetic PR row")
                }
                issues[number.ToString()] = row
            }
            test.Flow.State["issues"] = issues
            test.Flow.Save()
            let result = Read(test, index: true)
            Check.That(result["data"]?["work"]?.AsArray().Count == 1, "Labels or PR rows entered approved work")
            Check.That(
                Check.Text(result["truncated"]) == "true" && Check.Text(
                    result["data"]?["discovery_truncated"]
                ) == "true",
                "Bounded issue discovery hid truncation"
            )
            var queries int32
            for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                if Check.Text(call["path"]).StartsWith("repos/owner/project/issues?") {
                    queries++
                    Check.Contains(Check.Text(call["path"]), "per_page=20&page=1")
                }
                Check.That(Check.Text(call["path"]) != "repos/owner/project/issues/2", "PR row was inspected as work")
            }
            Check.That(queries == 1, "Discovery was unbounded")
            test.Flow.Reload()
            test.Flow.State["fault_path"] = JsonValue.Create(
                "repos/owner/project/issues?state=open&labels=tokate%3Aapproved&sort=updated&direction=desc&per_page=20&page=1"
            )
            test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
            test.Flow.State["fault_index"] = JsonValue.Create(0)
            test.Flow.Save()
            let unavailable = Read(test, 1, index: true)
            Check.That(
                Check.Text(unavailable["data"]?["discovery_status"]) == "unavailable" &&
                    unavailable["data"]?["viewer"] != nil,
                "Index failure discarded observed identity"
            )
        }

        private func LegacyAndTerminal(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let structured = Read(test)
            let legacy = test.Flow.Call([]string{"status", "--repo", "owner/project", "--issue", "1"})
            let raw = Check.Json(legacy.Output)
            Check.That(raw.ToJsonString() == structured["data"]?.ToJsonString(), "Terminal and structured facts differ")
            test.Flow.Temp.Env["TERM"] = "xterm-256color"
            let narrow = TerminalOutput.Pty(
                binary,
                []string{"status", "--repo", "owner/project", "--issue", "1", "--plain"},
                test.Flow.Temp,
                40
            )
            Check.Success(narrow)
            Check.Contains(narrow.Output, "Issue: #1 Implement fixture")
            Check.Contains(narrow.Output, "State: reservation needed")
            Check.Contains(narrow.Output, "Role: donor")
            Check.That(!narrow.Output.Contains('\u001b'), "Narrow plain status contains escapes")
            using let v1 = NativeFixture(binary)
            v1.Initialize()
            v1.Approve()
            let status = Check.Envelope(
                v1.Call([]string{"status", "--repo", "owner/project", "--issue", "1", "--json"}),
                "status",
                "ok"
            )
            Check.That(Check.Text(Row(status)["approval_status"]) == "current", "Legacy remote approval unsupported")
            v1.Call([]string{"access", "--repo", "owner/project", "--operation", "request", "--issue", "1"})
            let requested = Check.Envelope(
                v1.Call([]string{"status", "--repo", "owner/project", "--issue", "1", "--json"}, owner: true),
                "status",
                "ok"
            )
            Check.That(
                Check.Text(requested["data"]?["next"]?["command"]?[5]) == "init",
                "Absent access authority produced an unusable list command"
            )
        }

        private func Frames(reader StreamReader, frames Chan[string], completed Chan[Exception?]) {
            var failure Exception? = nil
            try {
                let prompt = "tokate> "
                let text = StringBuilder()
                var matched int32
                while true {
                    let next = reader.Read()
                    if next < 0 {
                        break
                    }
                    let value = Convert.ToChar(next)
                    text.Append(value)
                    matched = value == prompt[matched]? matched + 1: (value == prompt[0]? 1: 0)
                    if matched == prompt.Length {
                        frames <- text.ToString()
                        text.Clear()
                        matched = 0
                    }
                }
            } catch (error Exception) {
                failure = error
            }
            completed <- failure
        }

        private func Frame(frames Chan[string]) string {
            select {
                case let value = <- frames {
                    return value
                }
                case <- after(TimeSpan.FromSeconds(30)) {
                    throw Exception("Interactive status did not reach its next prompt")
                }
            }
        }

        private func RepeatedReads(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            test.Flow.Call([]string{"access", "--repo", "owner/project", "--operation", "init"}, owner: true)
            test.Flow.Reload()
            let title = Check.Text(test.Flow.State["issue"]?["title"])
            let issue = test.Flow.State["issue"] ?? throw Exception("Missing issue")
            issue["title"] = JsonValue.Create("Oversized title " + String('x', 2050))
            test.Flow.State["comments"] = Check.Map(
                "1",
                Check.Map(
                    "id",
                    1,
                    "body",
                    "/tokate-access {\"version\":1,\"scope\":\"issue\",\"issue\":1}",
                    "user",
                    Check.Map("id", 456, "login", "requester"),
                    "issue_url",
                    "https://api.github.com/repos/owner/project/issues/1"
                )
            )
            test.Flow.Save()
            test.Flow.ResetTraffic()
            test.Flow.Temp.Env["TERM"] = "dumb"
            let start = ProcessStartInfo("/usr/bin/script")
            start.UseShellExecute = false
            start.RedirectStandardInput = true
            start.RedirectStandardOutput = true
            start.RedirectStandardError = true
            start.WorkingDirectory = test.Flow.Temp.Root
            start.Environment.Clear()
            for entry in test.Flow.Temp.Env {
                start.Environment[entry.Key] = entry.Value
            }
            for arg in[]string{
                "-q",
                "-e",
                "-c",
                "stty cols 120 rows 24; exec '" + binary.Replace("'", "'\"'\"'") + "'",
                "/dev/null"
            } {
                start.ArgumentList.Add(arg)
            }
            using let process = Process.Start(start) ?? throw Exception("Cannot start interactive status")
            let frames = Chan[string](4)
            let completed = Chan[Exception?](1)
            let stderr = Chan[string](1)
            go Frames(process.StandardOutput, frames, completed)
            go TestProcess.Read(process.StandardError, stderr)
            var readFailure Exception? = nil
            var diagnostics = ""
            try {
                process.StandardInput.WriteLine("owner/project")
                process.StandardInput.Flush()
                let truncated = Frame(frames)
                TerminalOutput.Save("interactive-status-truncated", truncated)
                Check.Contains(truncated, "Bounded snapshot: some data was omitted.")
                Check.Contains(truncated, "Review donor access and grant eligibility if appropriate.")
                Check.Contains(truncated, "Command: tokate access --repo owner/project --operation list --issue 1")
                test.Flow.Reload()
                let current = test.Flow.State["issue"] ?? throw Exception("Missing issue")
                current["title"] = JsonValue.Create(title)
                test.Flow.State["fault_path"] = JsonValue.Create("user")
                test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
                test.Flow.State["fault_index"] = JsonValue.Create(0)
                test.Flow.Save()
                process.StandardInput.WriteLine("refresh")
                process.StandardInput.Flush()
                let failed = Frame(frames)
                TerminalOutput.Save("interactive-status-failed", failed)
                Check.Contains(failed, "unavailable; partial facts only")
                Check.Contains(failed, "GitHub read failed (HTTP 403).")
                Check.Contains(failed, "Issue: #1 " + title)
                Check.That(!failed.Contains("Bounded snapshot:"), "Failed refresh retained earlier truncation")
                test.Flow.Reload()
                test.Flow.State["fault_path"] = nil
                test.Flow.State["comments"] = Check.Json("{}")
                test.Flow.Save()
                process.StandardInput.WriteLine("refresh")
                process.StandardInput.Flush()
                let healthy = Frame(frames)
                TerminalOutput.Save("interactive-status-healthy", healthy)
                Check.Contains(healthy, "State: reservation needed")
                Check.Contains(healthy, "Role: donor")
                Check.That(
                    !healthy.Contains("unavailable") && !healthy.Contains("Bounded snapshot:") && !healthy.Contains(
                        "Review donor access"
                    ) &&
                        !healthy.Contains("Oversized title"),
                    "Healthy refresh retained failed or truncated status facts or actions"
                )
                process.StandardInput.WriteLine("exit")
                process.StandardInput.Flush()
                process.StandardInput.Close()
                Check.That(process.WaitForExit(10000), "Interactive status did not exit")
                test.Flow.Reload()
                for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    Check.That(Check.Text(call["method"]) == "GET", "Interactive status wrote to GitHub")
                }
                test.Flow.NoInference()
            } finally {
                if !process.HasExited {
                    process.Kill(true)
                    process.WaitForExit()
                }
                readFailure = <-completed
                diagnostics = <-stderr
            }
            if let failure = readFailure {
                throw failure
            }
            Check.That(process.ExitCode == 0, diagnostics)
        }

        internal func All(binary string) {
            Access(binary)
            Leases(binary)
            Drafts(binary)
            Published(binary)
            Discovery(binary)
            LegacyAndTerminal(binary)
            RepeatedReads(binary)
            Console.WriteLine(
                "PASS remote status access, discovery, leases, drafts, checks, stale authority, API failures, repeated reads, roles, narrow terminals and JSON"
            )
        }
    }
}
