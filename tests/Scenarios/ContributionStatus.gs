package TokateTests

import System
import System.IO
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

        private func Close(test CoordinationFixture, merged bool = true, deleted bool = false) {
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            pull["state"] = JsonValue.Create("closed")
            pull["merged"] = JsonValue.Create(merged)
            pull["merged_at"] = merged ? JsonValue.Create("2026-10-01T00:00:00Z"): nil
            test.Flow.Save()
            if deleted {
                test.Flow.Git(
                    "-C",
                    Path.Combine(test.Flow.Bin, "fork"),
                    "update-ref",
                    "-d",
                    "refs/heads/" + Check.Text(pull["head"]?["ref"])
                )
            }
        }

        private func Historical(binary string) {
            using let published = PublishedContribution.Create(binary, external: true)
            let test = published.Coordination
            for merged in[]bool{true, false} {
                for deleted in[]bool{false, true} {
                    published.Restore()
                    Close(test, merged, deleted)
                    let result = Read(test, index: true)
                    let row = Row(result)
                    let lifecycle = merged ? "merged": "closed_unmerged"
                    Check.That(
                        Check.Text(row["state"]) == lifecycle + "_contribution",
                        "Closed contribution lifecycle omitted"
                    )
                    Check.That(
                        Check.Text(row["drafts"]?[0]?["binding"]) == "historical" && Check.Text(
                            row["drafts"]?[0]?["lifecycle"]
                        ) == lifecycle,
                        "History required a live donor branch"
                    )
                    Check.Contains(Check.Text(row["drafts"]?[0]?["receipt"]), "current readiness is not established")
                    Check.Contains(Check.Text(row["next"]?["action"]), "remaining open issue")
                    Check.That(
                        Check.Text(row["next"]?["command"]?[1]) == "issue",
                        "History suggested completion or PR review"
                    )
                    for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                        let path = Check.Text(call["path"])
                        Check.That(
                            !path.StartsWith("repos/donor/project/git/ref/heads/") && !path.Contains("/check-runs?") &&
                                !path.Contains("/reviews?"),
                            "History used current branch or readiness authority"
                        )
                    }
                    let human = test.Flow.Call([]string{"status", "--repo", "owner/project", "--issue", "1", "--plain"})
                    Check.Contains(human.Output, "State: " + (lifecycle + "_contribution").Replace('_', ' '))
                    Check.Contains(human.Output, "Contribution: " + lifecycle.Replace('_', ' '))
                    Check.Contains(human.Output, Check.Text(row["next"]?["action"]))
                    let owner = Row(Read(test, owner: true))
                    Check.That(
                        Check.Text(owner["state"]) == Check.Text(row["state"]) && owner["next"]?.ToJsonString() == row[
                            "next"
                        ]?.ToJsonString(),
                        "Owner and donor history or next actions differ"
                    )
                }
            }
            for stale in[]string{"issue", "revoked", "expired"} {
                published.Restore()
                Close(test, deleted: true)
                if stale == "issue" {
                    test.Flow.Reload()
                    (test.Flow.State["issue"] ?? throw Exception("Missing issue"))["title"] = JsonValue.Create(
                        "Remaining work changed"
                    )
                    test.Flow.Save()
                } else if stale == "revoked" {
                    let value = test.State()["state"] ?? throw Exception("Missing state")
                    value["revoked"] = JsonValue.Create(true)
                    test.RewriteState(value)
                } else {
                    test.Expire()
                }
                let row = Row(Read(test))
                Check.That(
                    Check.Text(row["state"]) == "merged_contribution",
                    "Stale execution authority hid historical merge"
                )
                Check.That(
                    stale == "expired" || Check.Text(row["approval_status"]) == "stale",
                    "History revived stale approval"
                )
                Check.That(
                    Check.Text(row["next"]?["command"]?[1]) == "issue",
                    "History granted work or publication authority"
                )
            }
            for mismatch in[]string{
                "repository",
                "repository_id",
                "pr",
                "donor",
                "actor",
                "head",
                "fork",
                "fork_id",
                "branch",
                "receipt",
                "recorded"
            } {
                published.Restore()
                Close(test, deleted: true)
                test.Flow.Reload()
                let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                let head = pull["head"] ?? throw Exception("Missing head")
                let upstream = pull["base"]?["repo"] ?? throw Exception("Missing upstream")
                if mismatch == "repository" {
                    upstream["full_name"] = JsonValue.Create("other/project")
                } else if mismatch == "repository_id" {
                    upstream["id"] = JsonValue.Create(3)
                } else if mismatch == "pr" {
                    let response = pull.DeepClone()
                    response["number"] = JsonValue.Create(11)
                    test.Flow.State["pull_response_override"] = response
                } else if mismatch == "donor" || mismatch == "actor" {
                    let owner = head["repo"]?["owner"] ?? throw Exception("Missing donor")
                    owner[mismatch == "donor" ? "login": "id"] = mismatch == "donor" ? JsonValue.Create(
                        "other"
                    ): JsonValue.Create(456)
                } else if mismatch == "head" || mismatch == "branch" {
                    head[mismatch == "head" ? "sha": "ref"] = JsonValue.Create(
                        mismatch == "head" ? String('a', 40): "other"
                    )
                } else if mismatch == "fork" || mismatch == "fork_id" {
                    (head["repo"] ?? throw Exception("Missing fork"))[
                        mismatch == "fork" ? "full_name": "id"
                    ] = mismatch == "fork" ? JsonValue.Create("donor/other"): JsonValue.Create(3)
                } else if mismatch == "receipt" {
                    pull["body"] = JsonValue.Create(
                        Check.Text(pull["body"]).Replace("\"donor\":\"donor\"", "\"donor\":\"other\"")
                    )
                }
                test.Flow.Save()
                if mismatch == "recorded" {
                    let value = test.State()["state"] ?? throw Exception("Missing state")
                    (value["contribution"]?["metadata"] ?? throw Exception("Missing metadata"))[
                        "head"
                    ] = JsonValue.Create(String('a', 40))
                    test.RewriteState(value)
                }
                let row = Row(
                    Read(test, mismatch == "repository" || mismatch == "repository_id" || mismatch == "pr" ? 1: 0)
                )
                Check.That(
                    Check.Text(row["state"]) == "binding_mismatch" || Check.Text(row["state"]) == "unavailable",
                    "Mismatched history was accepted: " + mismatch
                )
                Check.That(
                    row["drafts"]?.AsArray().Count == 0 || Check.Text(row["drafts"]?[0]?["lifecycle"]) != "merged",
                    "Mismatched history displayed a merge"
                )
            }
            for missing in[]string{"merged", "fork", "remote_fork", "receipt", "ambiguous_receipt", "contribution"} {
                published.Restore()
                Close(test, deleted: true)
                test.Flow.Reload()
                let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                if missing == "merged" {
                    pull.AsObject().Remove("merged")
                } else if missing == "fork" {
                    (pull["head"] ?? throw Exception("Missing head"))["repo"] = nil
                } else if missing == "remote_fork" {
                    test.Flow.State["missing_fork"] = JsonValue.Create(true)
                } else if missing == "receipt" || missing == "ambiguous_receipt" {
                    pull["body"] = JsonValue.Create(
                        missing == "receipt" ? "Missing receipt": Check.Text(pull["body"]) + "\n" + Check.Text(
                            pull["body"]
                        )
                    )
                }
                test.Flow.Save()
                if missing == "contribution" {
                    let value = test.State()["state"] ?? throw Exception("Missing state")
                    value["contribution"] = nil
                    test.RewriteState(value)
                }
                let row = Row(Read(test, missing == "merged" ? 0: 1))
                Check.That(
                    Check.Text(row["state"]) == "unknown" || Check.Text(row["state"]) == "unavailable",
                    "Missing history became a known lifecycle: " + missing
                )
            }
            for changed in[]string{"merged", "state", "head", "base", "body"} {
                published.Restore()
                Close(test, deleted: true)
                test.Flow.Reload()
                let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                let patch = JsonObject()
                if changed == "merged" {
                    patch["merged"] = JsonValue.Create(false)
                    patch["merged_at"] = nil
                } else if changed == "head" || changed == "base" {
                    let part = pull[changed]?.DeepClone() ?? throw Exception("Missing PR identity")
                    part[changed == "head" ? "sha": "ref"] = JsonValue.Create(
                        changed == "head" ? String('a', 40): "release"
                    )
                    patch[changed] = part
                } else {
                    patch[changed] = JsonValue.Create(changed == "state" ? "open": "Changed receipt")
                }
                test.Flow.State["pull_read_effect"] = patch
                test.Flow.Save()
                let row = Row(Read(test))
                Check.That(
                    Check.Text(row["state"]) == "stale_remote_data" && Check.Text(
                        row["drafts"]?[0]?["lifecycle"]
                    ) == "unknown",
                    "Changed remote history was presented as current"
                )
                Check.That(
                    Check.Text(row["next"]?["command"]?[1]) == "status",
                    "Changed history did not request a refresh"
                )
            }
            for mismatch in[]string{"deleted", "moved"} {
                published.Restore()
                test.Flow.Reload()
                let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                let branch = "refs/heads/" + Check.Text(pull["head"]?["ref"])
                if mismatch == "deleted" {
                    test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "update-ref", "-d", branch)
                } else {
                    (pull["head"] ?? throw Exception("Missing head"))["sha"] = JsonValue.Create(String('a', 40))
                    test.Flow.Save()
                }
                let row = Row(Read(test))
                Check.That(Check.Text(row["state"]) == "binding_mismatch", "Open PR bypassed live exact-head binding")
            }
            published.Restore()
            test.Flow.Reload()
            (test.Flow.State["issue"] ?? throw Exception("Missing issue"))["title"] = JsonValue.Create(
                "Open work changed"
            )
            test.Flow.Save()
            let staleOpen = Row(Read(test))
            Check.That(
                Check.Text(staleOpen["approval_status"]) == "stale" && Check.Text(
                    staleOpen["state"]
                ) == "approval_waiting",
                "Open PR revived stale approval"
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

        private func TerminalOutput(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            let structured = Read(test)
            let legacy = test.Flow.Call([]string{"status", "--repo", "owner/project", "--issue", "1"})
            let raw = Check.Json(legacy.Output)
            Check.That(raw.ToJsonString() == structured["data"]?.ToJsonString(), "Terminal and structured facts differ")
            test.Flow.Temp.Env["TERM"] = "xterm-256color"
            let narrow = TestTerminal.Pty(
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
            let args = []string{"status", "--repo", "owner/project", "--plain"}
            let truncated = Check.Success(TestTerminal.Pty(binary, args, test.Flow.Temp, 120))
            TestTerminal.Save("status-truncated", truncated)
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
            let failure = TestTerminal.Pty(binary, args, test.Flow.Temp, 120)
            Check.That(failure.Code == 1, "Failed status read did not report failure")
            let failed = failure.Output
            TestTerminal.Save("status-failed", failed)
            Check.Contains(failed, "unavailable; partial facts only")
            Check.Contains(failed, "GitHub read failed (HTTP 403).")
            Check.Contains(failed, "Issue: #1 " + title)
            Check.That(!failed.Contains("Bounded snapshot:"), "Failed status read retained earlier truncation")
            test.Flow.Reload()
            test.Flow.State["fault_path"] = nil
            test.Flow.State["comments"] = Check.Json("{}")
            test.Flow.Save()
            let healthy = Check.Success(TestTerminal.Pty(binary, args, test.Flow.Temp, 120))
            TestTerminal.Save("status-healthy", healthy)
            Check.Contains(healthy, "State: reservation needed")
            Check.Contains(healthy, "Role: donor")
            Check.That(
                !healthy.Contains("unavailable") && !healthy.Contains("Bounded snapshot:") && !healthy.Contains(
                    "Review donor access"
                ) &&
                    !healthy.Contains("Oversized title"),
                "Healthy status read retained failed or truncated facts or actions"
            )
            test.Flow.Reload()
            for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Repeated status reads wrote to GitHub")
            }
            test.Flow.NoInference()
        }

        internal func All(binary string) {
            Access(binary)
            Leases(binary)
            Drafts(binary)
            Published(binary)
            Historical(binary)
            Discovery(binary)
            TerminalOutput(binary)
            RepeatedReads(binary)
            Console.WriteLine(
                "PASS remote status access, discovery, leases, drafts, checks, historical lifecycle, stale authority, API failures, repeated status invocations, roles, narrow terminals and JSON"
            )
        }
    }
}
