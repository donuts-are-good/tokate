package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class CheckGates {
    shared {
        private func Read(
            test PublishedContribution,
            code int32 = 0,
            saved bool = false,
            human bool = false,
            timeout bool = false,
            seconds string = "1"
        ) Result {
            let flow = test.Coordination.Flow
            flow.Reload()
            flow.State.AsObject().Remove("exec_count")
            flow.Save()
            flow.ResetTraffic()
            let args = saved ? List[string]{"checks", "--run", test.Run}:
            List[string]{"checks", "--repo", "owner/project", "--pr", "10"}
            if !human {
                args.Add("--json")
            }
            if timeout {
                args.AddRange([]string{"--watch", "--timeout", seconds})
            }
            let result = flow.Call(args.ToArray(), code)
            flow.NoInference()
            flow.Reload()
            for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(call["method"]) == "GET", "Checks mutated remote state")
                let path = Check.Text(call["path"])
                Check.That(!path.Contains("/actions/runs/"), "Checks inferred workflow approval")
                Check.That(!path.Contains("/pulls?"), "Checks scanned other contributions")
            }
            if !human {
                let value = Check.Json(result.Output)
                Check.Envelope(
                    result,
                    "checks",
                    code == 0 ? "ok": (code == 8 ? "pending": "error"),
                    Check.Text(value["error"]?["code"])
                )
            }
            return result
        }

        private func Data(result Result) JsonNode -> (
            Check.Json(result.Output)["data"] ?? throw Exception("Missing checks result")
        )

        private func Gate(data JsonNode, name string, status string, context string = "") {
            Check.That(
                Check.Text(data["gates"]?[name]?["status"]) == status,
                "Wrong " + name + " gate " + context + ": " + data.ToJsonString()
            )
        }

        private func Passing(test PublishedContribution) {
            let flow = test.Coordination.Flow
            flow.Reload()
            flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pass\"}]")
            flow.Save()
        }

        private func Success(test PublishedContribution) {
            let flow = test.Coordination.Flow
            Passing(test)
            let result = Data(Read(test))
            for name in[]string{"lifecycle", "receipt", "report", "checks", "dependencies", "freshness"} {
                Gate(result, name, "passed")
            }
            Check.That(
                Check.Text(result["machine_status"]) == "passed" && Check.Text(result["checks_status"]) == "passed",
                "Successful composition changed CI fields"
            )
            Check.That(
                Check.Text(result["pr_observation"]?["draft"]) == "true" && Check.Text(
                    result["owner_review"]
                ) == "required",
                "Draft success became owner acceptance"
            )
            let review = result["required_owner_actions"]?.ToJsonString() ?? ""
            for text in[]string{
                "scope",
                "acceptance criteria",
                "semantic compatibility",
                "limitations",
                "merge",
                "draft",
                "issue"
            } {
                Check.Contains(review, text)
            }
            Check.That(
                Check.Text(result["local_verification"]) == "donor_reported_not_remotely_attested",
                "Local checks presented as remotely attested"
            )
            Check.That(
                Check.Text(result["binding"]?["authority_revision"]).Length == 40 && Check.Text(
                    result["binding"]?["receipt_hash"]
                )
                    .Length == 64,
                "Receipt authority binding missing"
            )
            Check.That(
                Check.Text(result["target_revision"]) == Check.Text(result["binding"]?["base"]),
                "Wrong target revision"
            )
            let localRunPath = Path.Combine(test.Run, "run.json")
            let localRun = Check.Json(File.ReadAllText(localRunPath))
            localRun["pr"] = result["pr"]?.DeepClone()
            localRun["pr_url"] = result["pr_url"]?.DeepClone()
            File.WriteAllText(localRunPath, localRun.ToJsonString())
            let saved = Data(Read(test, saved: true))
            Check.That(saved.ToJsonString() == result.ToJsonString(), "Saved and direct results differ")
            let human = Read(test, saved: true, human: true)
            Check.Contains(human.Output, "Checks passed")
            Check.Contains(human.Output, "required_owner_actions")
            let local = Check.Json(File.ReadAllText(Path.Combine(test.Run, "checks.json")))
            Check.That(local["result"]?.ToJsonString() == result.ToJsonString(), "Human and JSON gates differ")
            flow.Reload()
            Check.That(Check.Text(flow.State["pulls"]?[0]?["draft"]) == "true", "Checks removed draft status")
        }

        private func CheckEvidence(test PublishedContribution) {
            let flow = test.Coordination.Flow
            for state in[]string{
                "missing",
                "queued",
                "in_progress",
                "skipped",
                "neutral",
                "cancelled",
                "failure",
                "timed_out",
                "unknown",
                "action_required",
                "conflicting",
                "reverse-conflict"
            } {
                test.Restore()
                let runs = JsonArray()
                if state != "missing" {
                    runs.Add(
                        Check.Map(
                            "name",
                            "verify",
                            "status",
                            state == "queued" || state == "in_progress" ? state: "completed",
                            "conclusion",
                            state == "conflicting" || state == "reverse-conflict" ? "skipped": state
                        )
                    )
                }
                if state == "conflicting" || state == "reverse-conflict" {
                    let pass = Check.Map("name", "verify", "status", "completed", "conclusion", "success")
                    if state == "conflicting" {
                        runs.Insert(0, pass)
                    } else {
                        runs.Add(pass)
                    }
                }
                flow.State["check_runs"] = Check.Map("total_count", runs.Count, "check_runs", runs)
                flow.Save()
                let failed = state == "cancelled" ||
                    state == "failure" ||
                    state == "timed_out" ||
                    state == "action_required"
                let result = Data(Read(test, failed ? 1: 8))
                Gate(result, "checks", failed ? "failed": "pending")
                Gate(result, "dependencies", "unread")
                Gate(result, "receipt", "passed")
                Gate(result, "freshness", "passed")
                Check.That(
                    Check.Text(result["machine_status"]) != "passed",
                    "Incomplete required check passed: " + state
                )
                if state == "conflicting" || state == "reverse-conflict" {
                    Check.That(
                        Check.Text(result["required_checks"]?[0]?["status"]) == "conflicting",
                        "Required check conflict hidden"
                    )
                }
                if state == "action_required" {
                    Check.That(
                        Check.Text(result["owner_inspection_required"]) == "true" && Check.Text(
                            result["action_required_cause"]
                        ) == "unknown",
                        "Workflow approval inferred from action_required"
                    )
                    Check.Contains(result["required_owner_actions"]?.ToJsonString() ?? "", "linked Actions")
                }
            }
            test.Restore()
            Passing(test)
            flow.State["statuses"] = Check.Json("[{\"context\":\"verify\",\"state\":\"pending\"}]")
            flow.Save()
            Gate(Data(Read(test, 8)), "checks", "pending")
            test.Restore()
            Passing(test)
            flow.Faults(
                "repos/owner/project/commits/" + Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"]) +
                    "/status?per_page=100&page=1",
                Check.Json("[{\"status\":404}]")
            )
            let partial = Data(Read(test, 1))
            Gate(partial, "checks", "unavailable")
            Check.That(
                Check.Text(partial["check_count"]) == "1" && Check.Text(partial["checks"]?[0]?["bucket"]) == "pass",
                "Partial check facts lost"
            )
            test.Restore()
            flow.State["check_runs"] = Check.Map("total_count", 1, "check_runs", JsonArray())
            flow.Save()
            Gate(Data(Read(test, 1)), "checks", "unavailable")
            test.Restore()
            flow.State["check_runs"] = Check.Map(
                "total_count",
                1,
                "check_runs",
                Check.Json(
                    "[{\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\",\"head_sha\":\"" +
                        String('a', 40) +
                        "\"}]"
                )
            )
            flow.Save()
            Gate(Data(Read(test, 1)), "checks", "stale")
            test.Restore()
            Passing(test)
            let checks = flow.State["checks"]?.AsArray() ?? throw Exception("Missing checks")
            for n in 0 ... 70 {
                checks.Add(Check.Map("name", "extra-" + n.ToString(), "bucket", "pass"))
            }
            flow.Save()
            let bounded = Check.Json(Read(test).Output)
            Check.That(
                Check.Text(bounded["truncated"]) == "true" && bounded["data"]?["checks"]?.AsArray()
                    .Count == 64 &&
                    Check.Text(bounded["data"]?["check_count"]) == "71",
                "Check output bounds changed"
            )
        }

        private func Report(test PublishedContribution, v2 bool) {
            let flow = test.Coordination.Flow
            let report = "<!-- tokate-report:start -->"
            let boundary = "<!-- tokate-report:end -->"
            for kind in[]string{
                "missing",
                "changes",
                "verification",
                "unavailable",
                "summary",
                "verification-claim",
                "observation",
                "limits"
            } {
                if !v2 &&
                    (kind == "summary" || kind == "verification-claim" || kind == "observation" || kind == "limits") {
                    continue
                }
                test.Restore()
                Passing(test)
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                let body = Check.Text(pull["body"])
                let start = body.IndexOf(report, StringComparison.Ordinal)
                let end = body.IndexOf(boundary, StringComparison.Ordinal) + boundary.Length
                Check.That(start >= 0 && end > start, "Published contribution lost its report region")
                let original = body.Substring(start + report.Length, end - boundary.Length - start - report.Length)
                let verified = "\nVerification:\n\n- Fixture report.\n- GitHub CI: not assessed here; missing or pending checks are not success."
                let region = switch kind {
                    case "missing": ""
                    case "changes": verified
                    case "verification": "\n- Add a result describing this candidate.\n"
                    case "summary": "\n- Add unrelated behavior from another candidate.\n" + verified
                    case "verification-claim": original.Replace(
                        "Fixture content check passed.",
                        "All platform tests passed."
                    )
                    case "observation": original.Replace(
                        "coordinator did not observe execution",
                        "coordinator verified all execution"
                    )
                    case "limits": original + "\n\nLimits:\n\n- No limitations remain.\n"
                    default: "\n- Change summary unavailable for this candidate; review the diff.\n" + verified
                }
                pull["body"] = JsonValue.Create(
                    body.Remove(start, end - start).Insert(start, report + region + boundary)
                )
                flow.Save()
                let refusal = Read(test, 1)
                let result = Data(refusal)
                Gate(result, "report", "failed")
                Gate(result, "receipt", "passed")
                Gate(result, "checks", "passed")
                Gate(result, "dependencies", "passed")
                Gate(result, "freshness", "passed")
                Check.That(
                    Check.Text(result["machine_status"]) == "failed" && Check.Text(result["checks_status"]) == "passed",
                    "Passing receipt and CI carried a refused public report: " + result.ToJsonString()
                )
                Check.Contains(
                    result["required_owner_actions"]?.ToJsonString() ?? "",
                    "public change and verification report"
                )
                Check.Contains(refusal.Error, "report")
            }
        }

        private func Dependencies(test PublishedContribution) {
            let flow = test.Coordination.Flow
            for kind in[]string{"open", "not_planned", "duplicate", "unavailable", "completed"} {
                test.Restore()
                Passing(test)
                let dependency = Check.Map(
                    "number",
                    7,
                    "url",
                    "https://api.github.com/repos/other/project/issues/7",
                    "state",
                    kind == "open" ? "open": "closed",
                    "state_reason",
                    kind == "duplicate" ? "completed": kind
                )
                if kind == "duplicate" {
                    dependency["duplicate_of"] = Check.Map("number", 9)
                }
                flow.State["dependency_pages"] = Check.Map("1", JsonArray(JsonArray(dependency)))
                flow.Save()
                if kind == "unavailable" {
                    flow.Faults(
                        "repos/owner/project/issues/1/dependencies/blocked_by?per_page=100&page=1",
                        Check.Json("[{\"status\":404}]")
                    )
                }
                let result = Data(Read(test, kind == "completed" ? 0: 1))
                Gate(result, "receipt", "passed")
                Gate(result, "checks", "passed")
                Gate(
                    result,
                    "dependencies",
                    kind == "completed" ? "passed": (kind == "unavailable" ? "unavailable": "failed")
                )
                Check.That(result["dependency_evidence"] != nil, "Native dependency evidence lost")
                if kind != "completed" {
                    Check.That(Check.Text(result["machine_status"]) == "failed", "Dependency refusal became success")
                    Gate(result, "freshness", "unread")
                }
            }
        }

        private func Movement(test PublishedContribution) {
            let flow = test.Coordination.Flow
            test.Restore()
            Passing(test)
            File.WriteAllText(Path.Combine(flow.Upstream, "already-advanced.txt"), "Target changed before checks\n")
            flow.Commit("Advance target before readiness read")
            let advanced = Data(Read(test, 1))
            Gate(advanced, "freshness", "stale")
            Check.That(
                Check.Text(advanced["reconciliation_required"]) == "true" && Check.Text(
                    advanced["machine_status"]
                ) == "failed",
                "Pre-existing target movement retained machine readiness"
            )
            Check.Contains(Check.Text(advanced["reconciliation_next"]), "current donor")
            for kind in[]string{
                "head",
                "approval",
                "retarget",
                "draft",
                "closed",
                "closed-reopen",
                "merged",
                "merged-issue",
                "merged-branch",
                "late-head",
                "late-merged",
                "receipt",
                "target"
            } {
                test.Restore()
                Passing(test)
                if kind == "target" {
                    let base = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
                    File.WriteAllText(Path.Combine(flow.Upstream, "later.txt"), "Target movement\n")
                    flow.Commit("Advance target")
                    let next = flow.Git("-C", flow.Upstream, "rev-parse", "HEAD")
                    flow.Git("-C", flow.Upstream, "update-ref", "refs/heads/main", base)
                    flow.State["overlap_move_target"] = Check.Map("branch", "main", "sha", next)
                } else {
                    flow.State["check_read_effect"] = JsonValue.Create(kind)
                }
                flow.Save()
                let result = Data(Read(test, 1))
                Gate(result, "freshness", kind == "merged-branch" ? "unavailable": "stale", kind)
                Gate(result, "report", "stale")
                Gate(result, "checks", "stale")
                Check.That(
                    Check.Text(result["checks_observed_status"]) == "passed" && Check.Text(
                        result["machine_status"]
                    ) == "failed",
                    "Movement retained successful result"
                )
                Check.That(
                    Check.Text(result["gates"]?["receipt"]?["observed_status"]) == "passed",
                    "Movement discarded prior receipt assessment"
                )
                if kind == "closed" || kind.StartsWith("merged") || kind == "late-merged" {
                    Check.That(
                        Check.Text(result["owner_review"]) == "historical" &&
                            result["required_owner_actions"]
                            ?.AsArray().Count == 0,
                        "Closed PR awaits new acceptance"
                    )
                } else {
                    Check.That(
                        Check.Text(result["owner_review"]) == "required" && result["required_owner_actions"]?.AsArray()
                            .Count > 0,
                        "Open PR lost required owner review after movement"
                    )
                }
            }
            for kind in[]string{"closed", "merged"} {
                test.Restore()
                Passing(test)
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                pull["state"] = JsonValue.Create("closed")
                if kind == "merged" {
                    pull["merged"] = JsonValue.Create(true)
                }
                flow.Save()
                let result = Data(Read(test, 1))
                Gate(result, "lifecycle", "failed")
                Gate(result, "receipt", "unread")
                Check.That(Check.Text(result["owner_review"]) == "historical", "Historical lifecycle hidden")
            }
        }

        private func Deadline(test PublishedContribution) {
            let flow = test.Coordination.Flow
            for kind in[]string{"receipt", "checks", "dependencies", "freshness", "poll"} {
                test.Restore()
                Passing(test)
                let head = Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"])
                let path = switch kind {
                    case "receipt": "repos/owner/project/issues/1"
                    case "checks": "repos/owner/project/commits/" + head + "/status?per_page=100&page=1"
                    case "dependencies": "repos/owner/project/issues/1/dependencies/blocked_by?per_page=100&page=1"
                    case "freshness": "repos/owner/project/pulls/10"
                    default: ""
                }
                if kind == "poll" {
                    flow.State["checks"] = JsonArray()
                    flow.State["poll_interval"] = JsonValue.Create("10")
                } else {
                    let faults = JsonArray()
                    if kind == "freshness" {
                        for n in 0 ... 1 {
                            faults.Add(Check.Map("passthrough", true))
                        }
                    }
                    faults.Add(Check.Map("status", 200, "pause_ms", 3000))
                    flow.State["fault_path"] = JsonValue.Create(path)
                    flow.State["faults"] = faults
                }
                flow.Save()
                let result = Data(Read(test, 8, timeout: true))
                Check.That(Check.Text(result["machine_status"]) == "pending", "Deadline did not exit pending")
                if kind == "dependencies" {
                    Gate(result, "checks", "passed")
                    Gate(result, "dependencies", "unavailable")
                }
                if kind == "checks" {
                    Check.That(Check.Text(result["check_count"]) == "1", "Deadline lost partial checks")
                }
            }
            test.Restore()
            Passing(test)
            let dependencies = JsonArray()
            for n in 1 ... 101 {
                dependencies.Add(
                    Check.Map(
                        "number",
                        n,
                        "url",
                        "https://api.github.com/repos/other/project/issues/" + n.ToString(),
                        "state",
                        "closed",
                        "state_reason",
                        "completed"
                    )
                )
            }
            flow.State["dependency_pages"] = Check.Map("1", JsonArray(dependencies))
            flow.Save()
            flow.Faults(
                "repos/owner/project/issues/1/dependencies/blocked_by?per_page=100&page=2",
                Check.Json("[{\"status\":200,\"pause_ms\":5000}]")
            )
            let partial = Data(Read(test, 8, timeout: true, seconds: "3"))
            Gate(partial, "dependencies", "unavailable")
            Check.That(
                Check.Text(partial["dependency_evidence"]?["dependency_count"]) == "100",
                "Deadline lost partial native dependency observations: " + partial.ToJsonString()
            )
        }

        private func WatchFailure(test PublishedContribution, v2 bool) {
            let flow = test.Coordination.Flow
            for deadline in[]bool{false, true} {
                test.Restore()
                flow.State["checks"] = Check.Json("[{\"name\":\"verify\",\"bucket\":\"pending\"}]")
                flow.Save()
                let faults = JsonArray(
                    Check.Map("passthrough", true),
                    Check.Map("passthrough", true),
                    Check.Map("passthrough", true)
                )
                faults.Add(deadline ? Check.Map("status", 200, "pause_ms", 8000): Check.Map("status", 404))
                flow.Faults("repos/owner/project/pulls/10", faults)
                let result = Data(Read(test, deadline ? 8: 1, saved: !v2, timeout: true, seconds: "5"))
                Gate(result, "lifecycle", "unavailable")
                Check.That(Check.Text(result["machine_status"]) != "passed", "Watch failure became success")
                let prior = result["previous_observation"] ?? throw Exception("Watch lost prior observation")
                Check.That(Check.Text(prior["current"]) == "false", "Prior watch evidence remained current")
                let known = prior["result"] ?? throw Exception("Watch lost prior result")
                Gate(known, "receipt", "passed")
                Gate(known, "checks", "pending")
                Check.That(
                    Check.Text(known["check_count"]) == "1" && Check.Text(known["checks"]?[0]?["name"]) == "verify" &&
                        Check.Text(known["binding"]?["commit"]) != "",
                    "Watch discarded bound check facts"
                )
                if !v2 {
                    let saved = Check.Json(File.ReadAllText(Path.Combine(test.Run, "checks.json")))
                    Check.That(
                        saved["result"]?["previous_observation"]?.ToJsonString() == prior.ToJsonString(),
                        "Saved watch result lost prior evidence"
                    )
                }
            }
        }

        private func PublicationAuthority(test PublishedContribution) {
            test.Restore()
            let coordination = test.Coordination
            let flow = coordination.Flow
            let previous = Check.Text(coordination.State()["sha"])
            let renew = coordination.ClaimRequest()
            renew["action"] = JsonValue.Create("renew")
            coordination.Coordinate(coordination.Event(renew))
            let next = Check.Text(coordination.State()["sha"])
            flow.Git("-C", flow.Upstream, "update-ref", "refs/heads/tokate/contributions/1", previous, next)
            Passing(test)
            flow.State["overlap_move_target"] = Check.Map("branch", "tokate/contributions/1", "sha", next)
            flow.Save()
            Gate(Data(Read(test, 1)), "freshness", "stale")
            test.Restore()
            let release = coordination.ClaimRequest()
            release["action"] = JsonValue.Create("release")
            coordination.Coordinate(coordination.Event(release))
            coordination.Expire()
            Passing(test)
            let result = Data(Read(test))
            Gate(result, "receipt", "passed")
            let state = coordination.State()["state"] ?? throw Exception("Missing state")
            let reservation = state["reservation"] ?? throw Exception("Missing reservation")
            Check.That(
                Check.Text(state["publication_revision"]) != "" && Check.Text(reservation["expires"]) == "1",
                "Fixture did not expire publication lease"
            )
            state["publication_revision"] = JsonValue.Create(Check.Text(coordination.State()["sha"]))
            coordination.RewriteState(state)
            Gate(Data(Read(test, 1)), "receipt", "stale")
        }

        internal func All(binary string) {
            for v2 in[]bool{false, true} {
                using let test = PublishedContribution.Create(binary, external: v2)
                Success(test)
                Report(test, v2)
                CheckEvidence(test)
                Dependencies(test)
                Movement(test)
                Deadline(test)
                WatchFailure(test, v2)
                if v2 {
                    PublicationAuthority(test)
                }
            }
            Console.WriteLine(
                "PASS composed check gates, required owner actions, exact-head conflicts, public report refusal, dependency refusal, movement, lifecycle, publication authority, deadlines and JSON/human consistency"
            )
        }
    }
}
