package TokateTests

import System
import System.IO
import System.Text.Json.Nodes

internal class AdmissionChecks {
    shared {
        private func Access(test CoordinationFixture, operation string, issue string = "") {
            if issue == "" {
                test.Flow.Call(
                    []string{"access", "--repo", "owner/project", "--operation", operation, "--donor", "donor"},
                    owner: true
                )
            } else {
                test.Flow.Call(
                    []string{
                        "access",
                        "--repo",
                        "owner/project",
                        "--operation",
                        operation,
                        "--donor",
                        "donor",
                        "--issue",
                        issue
                    },
                    owner: true
                )
            }
        }

        private func Setup(test CoordinationFixture, mode string, message string? = nil) {
            test.Flow.Call([]string{"access", "--repo", "owner/project", "--operation", "init"}, owner: true)
            let path = Path.Combine(test.Flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["approval_scope"] = JsonValue.Create("task")
            policy["eligibility"] = JsonValue.Create(mode)
            if let text = message {
                policy["close_message"] = JsonValue.Create(text)
            }
            File.WriteAllText(path, policy.ToJsonString())
            test.Flow.Commit("Owner admission configuration")
            test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
        }

        private func Pull(
            test CoordinationFixture,
            body string = "",
            login string = "donor",
            actor int32 = 123,
            branch string = "draft",
            head string = "",
            bot bool = false
        ) {
            test.Flow.Reload()
            let pull = Check.Map(
                "number",
                10,
                "state",
                "open",
                "draft",
                true,
                "body",
                body,
                "user",
                Check.Map("login", login, "id", actor, "type", bot ? "Bot": "User"),
                "base",
                Check.Map("ref", "main", "repo", Check.Map("id", 1, "full_name", "owner/project")),
                "head",
                Check.Map(
                    "ref",
                    branch,
                    "sha",
                    head == "" ? String('a', 40): head,
                    "repo",
                    Check.Map("id", 2, "full_name", "donor/project", "owner", Check.Map("id", 123, "login", "donor"))
                )
            )
            test.Flow.State["pulls"] = JsonArray(pull)
            test.Flow.Save()
        }

        private func Admit(test CoordinationFixture, expected string, code int32 = 0, action string = "opened") {
            test.Flow.Reload()
            let initiallyOpen = Check.Text(test.Flow.State["pulls"]?[0]?["state"]) == "open"
            let path = Path.Combine(test.Flow.Temp.Root, "admission-event.json")
            File.WriteAllText(
                path,
                Check.Map(
                    "action",
                    action,
                    "repository",
                    Check.Map("full_name", "owner/project", "id", 1),
                    "pull_request",
                    Check.Map("number", 10, "user", Check.Map("login", "owner", "id", 1))
                )
                    .ToJsonString()
            )
            test.Flow.Temp.Env["GITHUB_EVENT_NAME"] = "pull_request_target"
            test.Flow.ResetTraffic()
            test.Flow.Call([]string{"admit", "--repo", "owner/project", "--event", path}, code, owner: true)
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["pulls"]?[0]?["state"]) == expected,
                "Admission state after " + action + ": expected " + expected + ", got " + Check.Text(
                    test.Flow.State["pulls"]?[0]?["state"]
                )
            )
            if code == 0 && initiallyOpen && expected == "closed" {
                var reads int32
                var authority int32
                for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    if Check.Text(call["method"]) == "GET" {
                        if Check.Text(call["path"]) == "repos/owner/project/pulls/10" {
                            reads++
                        }
                        if Check.Text(call["path"]) == "repos/owner/project/git/ref/heads/tokate/access" {
                            authority++
                        }
                    } else if Check.Text(call["method"]) == "PATCH" && Check.Text(
                        call["path"]
                    ) == "repos/owner/project/pulls/10" {
                        Check.That(reads >= 3 && authority >= 3, "Closure skipped fresh PR or authority reads")
                    }
                }
            }
            test.Flow.NoInference()
        }

        private func Reopen(test CoordinationFixture) {
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            pull["state"] = JsonValue.Create("open")
            test.Flow.Save()
        }

        private func Target(test CoordinationFixture, branch string) {
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            (pull["base"] ?? throw Exception("Missing base"))["ref"] = JsonValue.Create(branch)
            test.Flow.Save()
        }

        private func Authority(binary string) {
            for mode in[]string{"open", "trusted", "manual"} {
                using let test = CoordinationFixture(binary)
                test.Initialize(approve: false)
                Setup(test, mode)
                Pull(test, login: "owner", actor: 1)
                Admit(test, "open")
                Pull(test)
                Admit(test, mode == "open" ? "open": "closed")
                Access(test, "trust")
                Pull(test, "<!-- tokate-receipt:{\"repo\":\"other/project\",\"issue\":1,\"donor\":\"owner\"} -->")
                Admit(test, mode == "manual" ? "closed": "open")
                Access(test, "grant", "1")
                Pull(test, "Fixes #1\nIncomplete draft without a receipt or verification")
                Admit(test, "open")
                Target(test, "other")
                Admit(test, mode == "manual" ? "closed": "open", action: "edited")
                Pull(test, "Fixes #1\nIncomplete draft without a receipt or verification")
                Admit(test, "open")
                Pull(test, "Fixes #2")
                Admit(test, mode == "manual" ? "closed": "open")
                Access(test, "deny")
                Pull(test, "Fixes #1")
                Admit(test, "closed")
                Access(test, "restore")
                Access(test, "untrust")
                Pull(test, "Fixes #1")
                Admit(test, "open")
                test.Flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                Pull(test, "Fixes #1")
                Admit(test, mode == "open" ? "open": "closed")
                Pull(
                    test,
                    "Fixes #1\n<!-- tokate-receipt:{\"version\":2,\"repo\":\"owner/project\",\"issue\":1,\"donor\":\"donor\"} -->",
                    "outsider",
                    124
                )
                Admit(test, mode == "open" ? "open": "closed")
            }
            using let legacy = CoordinationFixture(binary)
            legacy.Flow.Initialize()
            legacy.Flow.Approve()
            Pull(legacy, "Fixes #1")
            Admit(legacy, "open")
            Target(legacy, "other")
            Admit(legacy, "closed", action: "edited")
            Target(legacy, "main")
            legacy.Flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
            Reopen(legacy)
            Admit(legacy, "closed", action: "reopened")
            using let assigned = CoordinationFixture(binary)
            assigned.Initialize()
            Pull(assigned, "Fixes #1")
            Admit(assigned, "open")
            assigned.Flow.Reload()
            let task = assigned.Flow.State["issue"] ?? throw Exception("Missing issue")
            task["assignees"] = Check.Json("[{\"login\":\"outsider\",\"id\":124}]")
            assigned.Flow.Save()
            Admit(assigned, "closed", action: "edited")
        }

        private func Coordinator(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize(approve: false)
            Setup(test, "manual")
            Access(test, "grant", "1")
            let request = test.ClaimRequest()
            test.Coordinate(test.Event(request))
            let head = test.Candidate(request)
            let branch = "tokate/v2-" + Check.Text(request["uuid"])
            Pull(test, "", "github-actions[bot]", 41898282, branch, head, bot: true)
            Admit(test, "open")
            let value = test.State()["state"] ?? throw Exception("Missing state")
            let reservation = value["reservation"] ?? throw Exception("Missing reservation")
            let saved = reservation.DeepClone()
            for fault in[]string{"expired", "paused", "released", "actor", "absent"} {
                value["reservation"] = saved.DeepClone()
                let current = value["reservation"] ?? throw Exception("Missing reservation")
                if fault == "expired" {
                    current["expires"] = JsonValue.Create(1)
                } else if fault == "paused" || fault == "released" {
                    current["status"] = JsonValue.Create(fault)
                    current["attempt"] = JsonValue.Create("")
                } else if fault == "actor" {
                    current["actor"] = JsonValue.Create(124)
                } else {
                    value["reservation"] = nil
                }
                test.RewriteState(value)
                Reopen(test)
                Admit(test, "closed")
            }
            value["reservation"] = saved.DeepClone()
            test.RewriteState(value)
            test.Flow.Reload()
            test.Flow.State["pulls"] = JsonArray()
            test.Flow.Save()
            test.Flow.Temp.Env["GITHUB_EVENT_NAME"] = "issue_comment"
            let publish = test.PublishRequest(request, head)
            test.Coordinate(test.Event(publish))
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            pull["user"] = Check.Map("login", "github-actions[bot]", "id", 41898282, "type", "Bot")
            pull["state"] = JsonValue.Create("open")
            test.Flow.Save()
            Admit(test, "open", action: "edited")
            test.Flow.Reload()
            let withoutClaims = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            withoutClaims["body"] = JsonValue.Create("<!-- tokate-receipt:forged -->")
            test.Flow.Save()
            Admit(test, "open", action: "edited")
            let work = Path.Combine(test.Flow.Temp.Root, "donor-work")
            File.AppendAllText(Path.Combine(work, "result.txt"), "Amended\n")
            test.Flow.Git("-C", work, "add", "result.txt")
            test.Flow.Git(
                "-C",
                work,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
                "commit",
                "-m",
                "Amend result"
            )
            let amended = test.Flow.Git("-C", work, "rev-parse", "HEAD")
            test.Flow.Git("-C", work, "push", Path.Combine(test.Flow.Bin, "fork"), "HEAD:refs/heads/" + branch)
            test.Flow.Reload()
            let advancing = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            (advancing["head"] ?? throw Exception("Missing head"))["sha"] = JsonValue.Create(amended)
            test.Flow.Save()
            Admit(test, "open", action: "synchronize")
            let recorded = test.State()["state"] ?? throw Exception("Missing state")
            for fault in[]string{"expired", "paused", "released", "actor", "reservation"} {
                recorded["reservation"] = saved.DeepClone()
                let current = recorded["reservation"] ?? throw Exception("Missing reservation")
                if fault == "expired" {
                    current["expires"] = JsonValue.Create(1)
                } else if fault == "paused" || fault == "released" {
                    current["status"] = JsonValue.Create(fault)
                    current["attempt"] = JsonValue.Create("")
                } else if fault == "actor" {
                    current["actor"] = JsonValue.Create(124)
                } else {
                    current["reservation"] = JsonValue.Create("other")
                }
                test.RewriteState(recorded)
                Reopen(test)
                Admit(test, "closed", action: "synchronize")
            }
            recorded["reservation"] = saved.DeepClone()
            test.RewriteState(recorded)
            Reopen(test)
            test.Flow.Reload()
            let physical = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            (physical["head"] ?? throw Exception("Missing head"))["sha"] = JsonValue.Create(String('b', 40))
            test.Flow.Save()
            Admit(test, "closed", action: "synchronize")
            (physical["head"] ?? throw Exception("Missing head"))["sha"] = JsonValue.Create(amended)
            physical["state"] = JsonValue.Create("open")
            test.Flow.State["pulls"] = JsonArray(physical.DeepClone())
            test.Flow.Save()
            test.Flow.Reload()
            test.Flow.State["fork_owner_id"] = JsonValue.Create(124)
            test.Flow.Save()
            Admit(test, "closed")
            test.Flow.Reload()
            test.Flow.State["fork_owner_id"] = nil
            test.Flow.Save()
            Reopen(test)
            test.Flow.Reload()
            test.Flow.State["fault_path"] = JsonValue.Create("repos/donor/project")
            test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
            test.Flow.Save()
            Admit(test, "open", 1)
            Access(test, "trust")
            let policyPath = Path.Combine(test.Flow.Upstream, ".github/tokate.json")
            let trusted = Check.Json(File.ReadAllText(policyPath))
            trusted["eligibility"] = JsonValue.Create("trusted")
            File.WriteAllText(policyPath, trusted.ToJsonString())
            test.Flow.Commit("Current global trust independent of stale issue claims")
            Admit(test, "open", action: "edited")
            Access(test, "deny")
            Admit(test, "closed")
            Pull(test, "Fixes #1", "github-actions[bot]", 41898282, "forged", head, bot: true)
            Admit(test, "closed")
        }

        private func Safety(binary string) {
            for fault in[]string{
                "api",
                "malformed",
                "coordination",
                "late-api",
                "forged",
                "missing",
                "missing-claims",
                "silent",
                "custom",
                "event"
            } {
                using let test = CoordinationFixture(binary)
                test.Initialize(approve: false)
                var message string? = nil
                if fault == "silent" {
                    message = ""
                } else if fault == "custom" {
                    message = "Owner **review** required.\n`$(touch injected)` {{issue}} $$HOME <script>literal</script>"
                }
                Setup(test, "trusted", message)
                Pull(test, "Fixes #1\n<!-- tokate-receipt:invalid -->", "outsider", 124)
                if fault == "api" {
                    test.Flow.Reload()
                    test.Flow.State["fault_path"] = JsonValue.Create("repos/owner/project/git/ref/heads/tokate/access")
                    test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
                    test.Flow.Save()
                } else if fault == "malformed" {
                    test.Flow.Git(
                        "-C",
                        test.Flow.Upstream,
                        "update-ref",
                        "refs/heads/tokate/access",
                        test.Flow.Git("-C", test.Flow.Upstream, "rev-parse", "HEAD")
                    )
                } else if fault == "missing" {
                    test.Flow.Git("-C", test.Flow.Upstream, "update-ref", "-d", "refs/heads/tokate/access")
                } else if fault == "coordination" {
                    let value = test.State()["state"] ?? throw Exception("Missing state")
                    let approval = value["approval"] ?? throw Exception("Missing approval")
                    approval["issue_hash"] = JsonValue.Create("")
                    test.RewriteState(value)
                } else if fault == "late-api" {
                    test.Flow.Reload()
                    test.Flow.State["fault_path"] = JsonValue.Create(
                        "repos/owner/project/issues/10/comments?per_page=100&page=1"
                    )
                    test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
                    test.Flow.Save()
                } else if fault == "missing-claims" {
                    Pull(test, "", "outsider", 124)
                } else if fault == "forged" {
                    test.Flow.Reload()
                    test.Flow.State["comments"] = Check.Map(
                        "77",
                        Check.Map(
                            "body",
                            "<!-- tokate-admission:v1 -->",
                            "user",
                            Check.Map("login", "outsider", "id", 124, "type", "User")
                        )
                    )
                    test.Flow.Save()
                }
                let failure = fault == "api" ||
                    fault == "malformed" ||
                    fault == "coordination" ||
                    fault == "late-api" ||
                    fault == "event"
                Admit(test, failure ? "open": "closed", failure ? 1: 0, action: fault == "event" ? "closed": "opened")
                if failure {
                    Check.That(test.Flow.State["request_count"] == nil, "Uncertainty posted a rejection comment")
                    continue
                }
                if fault == "silent" {
                    Check.That(test.Flow.State["request_count"] == nil, "Empty close message posted a comment")
                } else {
                    Check.That(
                        Check.Text(test.Flow.State["request_count"]) == "1",
                        "Rejection did not post exactly one explanation"
                    )
                    if fault == "custom" {
                        Check.Contains(Check.Text(test.Flow.State["posted_request"]?["body"]), message ?? "")
                        Check.That(
                            !File.Exists(Path.Combine(test.Flow.Upstream, "injected")),
                            "Custom message executed shell content"
                        )
                    }
                }
                Admit(test, "closed")
                Reopen(test)
                Admit(test, "closed", action: "reopened")
                Check.That(
                    Check.Text(test.Flow.State["request_count"]) == (fault == "silent" ? "": "1"),
                    "Duplicate events repeated the explanation"
                )
            }
            using let setup = CoordinationFixture(binary)
            setup.Initialize()
            setup.Flow.ReleaseReady()
            let output = Path.Combine(setup.Flow.Temp.Root, "coordinator.yml")
            setup.Flow.Reload()
            setup.Flow.State["actions_policy"] = Check.Map(
                "enforcement",
                "evaluate",
                "rules",
                Check.Json(
                    "[{\"type\":\"restrict_action_events\",\"parameters\":{\"allowed_events\":[\"issue_comment\"]}}]"
                )
            )
            setup.Flow.Save()
            Check.Contains(
                setup
                    .Flow
                    .Call(
                    []string{"coordinator-setup", "--repo", "owner/project", "--output", output, "--yes"},
                    1,
                    owner: true
                )
                    .Error,
                "November 2, 2026"
            )
            Check.That(!File.Exists(output), "Blocked event policy enabled automatic closure")
            setup.Flow.Reload()
            setup.Flow.State["actions_policy"] = nil
            setup.Flow.Save()
            setup.Flow.Call(
                []string{"coordinator-setup", "--repo", "owner/project", "--output", output, "--yes"},
                owner: true
            )
            Check.Contains(File.ReadAllText(output), "pull_request_target:")
            File.Delete(output)
            setup.Flow.Reload()
            setup.Flow.State["actions_policy"] = Check.Map(
                "enforcement",
                "active",
                "conditions",
                Check.Map(
                    "workflow_path",
                    Check.Map("include", Check.Json("[\".github/workflows/*\"]"), "exclude", JsonArray())
                ),
                "rules",
                Check.Json(
                    "[{\"type\":\"restrict_action_events\",\"parameters\":{\"allowed_events\":[\"issue_comment\",\"pull_request_target\",\"workflow_call\"]}}]"
                )
            )
            setup.Flow.Save()
            setup.Flow.Call(
                []string{"coordinator-setup", "--repo", "owner/project", "--output", output, "--yes"},
                owner: true
            )
            File.Delete(output)
            setup.Flow.Reload()
            let active = setup.Flow.State["actions_policy"] ?? throw Exception("Missing policy")
            let rules = active["rules"]?.AsArray() ?? throw Exception("Missing policy rules")
            rules.Add(
                Check.Map(
                    "type",
                    "restrict_actions_actors",
                    "parameters",
                    Check.Map("allowed_actors", Check.Json("[{\"id\":1,\"type\":\"User\"}]"))
                )
            )
            setup.Flow.Save()
            Check.Contains(
                setup
                    .Flow
                    .Call(
                    []string{"coordinator-setup", "--repo", "owner/project", "--output", output, "--yes"},
                    1,
                    owner: true
                )
                    .Error,
                "actor policy"
            )
            Check.That(!File.Exists(output), "Active actor policy enabled automatic closure")
            setup.Flow.Reload()
            setup.Flow.State["actions_policy"] = nil
            setup.Flow.State["actions_policies"] = Check.Map("total_count", 0, "policies", JsonArray())
            setup.Flow.Save()
            setup.Flow.Call(
                []string{"coordinator-setup", "--repo", "owner/project", "--output", output, "--yes"},
                1,
                owner: true
            )
            Check.That(!File.Exists(output), "Missing event policy enabled automatic closure")
            let central = NativeFixture.Template("coordinator.yml")
            Check.Contains(central, "contents: read")
            Check.Contains(central, "admit --repo")
            Check.That(
                !central.Contains("checkout") && !central.Contains("github.event.pull_request.body"),
                "Admission workflow consumed PR code or shell content"
            )
        }

        internal func All(binary string, selected string) {
            switch selected {
                case "AdmissionAuthority" {
                    Authority(binary)
                }
                case "AdmissionCoordinator" {
                    Coordinator(binary)
                }
                case "AdmissionSafety" {
                    Safety(binary)
                }
                default {
                    throw Exception("Unknown admission selector")
                }
            }
            Console.WriteLine("PASS " + selected)
        }
    }
}
