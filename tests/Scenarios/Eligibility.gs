package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class EligibilityChecks {
    shared {
        private func Access(
            test CoordinationFixture,
            operation string,
            donor string = "donor",
            issue string = "",
            code int32 = 0,
            owner bool = true,
            traffic bool = false
        ) Result {
            let args = List[string]{"access", "--repo", "owner/project", "--operation", operation}
            if operation != "init" && operation != "check" {
                args.Add("--donor")
                args.Add(donor)
            }
            if issue != "" {
                args.Add("--issue")
                args.Add(issue)
            }
            return test.Flow.Call(args.ToArray(), code, owner, traffic)
        }

        private func Policy(test CoordinationFixture, mode string) {
            let path = Path.Combine(test.Flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["approval_scope"] = JsonValue.Create("task")
            policy["eligibility"] = JsonValue.Create(mode)
            File.WriteAllText(path, policy.ToJsonString())
            test.Flow.Commit("Owner task eligibility " + mode)
        }

        private func Setup(test CoordinationFixture, mode string) {
            Access(test, "init")
            Policy(test, mode)
            test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
            File.WriteAllText(
                test.Tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            let approval = test.State()["state"]?["approval"] ?? throw Exception("Missing approval")
            Check.That(
                approval["donor"] == nil && Check.Text(approval["repo_id"]) == "1",
                "Task approval assigned a donor or lacks numeric identity"
            )
            test.Flow.Reload()
            let issue = test.Flow.State["issue"] ?? throw Exception("Missing issue")
            issue["assignees"] = JsonArray()
            test.Flow.Save()
        }

        private func Claim(test CoordinationFixture, code int32 = 0, actor int32 = 123) JsonNode {
            let request = test.ClaimRequest()
            test.Coordinate(test.Event(request, actor), code)
            return request
        }

        private func Modes(binary string) {
            for mode in[]string{"open", "trusted", "manual"} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                Setup(test, mode)
                Access(test, "check", issue: "1", code: mode == "open" ? 0: 1, owner: false)
                if mode != "open" {
                    Claim(test, 1)
                }
                Access(test, "trust")
                Access(test, "check", issue: "1", code: mode == "manual" ? 1: 0, owner: false)
                if mode == "manual" {
                    Claim(test, 1)
                }
                Access(test, "grant", issue: "2")
                Access(test, "check", issue: "1", code: mode == "manual" ? 1: 0, owner: false)
                Access(test, "grant", issue: "1")
                Access(test, "check", issue: "1", owner: false)
                Access(test, "deny")
                Access(test, "check", issue: "1", code: 1, owner: false)
                Claim(test, 1)
                Access(test, "restore")
                Access(test, "remove", issue: "1")
                Access(test, "check", issue: "1", code: mode == "manual" ? 1: 0, owner: false)
                Access(test, "untrust")
                Access(test, "check", issue: "1", code: mode == "open" ? 0: 1, owner: false)
                Access(test, "grant", donor: "renamed", issue: "1")
                if mode != "open" {
                    Claim(test, 1, 124)
                }
                let request = Claim(test)
                let run = test.Prepare()
                let commit = test.Candidate(request)
                test.Flow.Call([]string{"external", "--run", run, "--commit", commit})
                test.Flow.Call([]string{"submit", "--run", run})
                let publish = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
                test.Coordinate(test.Event(publish))
                test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                test.Flow.Reload()
                test.Flow.State["fork_owner_id"] = JsonValue.Create(124)
                test.Flow.Save()
                test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, true)
                test.Flow.Reload()
                test.Flow.State["fork_owner_id"] = nil
                test.Flow.Save()
                Access(test, "deny")
                test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, true)
                test.Flow.Call([]string{"submit", "--run", run}, 1)
                test.Coordinate(test.Event(publish), 1)
                test.Flow.NoInference()
            }
        }

        private func Revocation(binary string) {
            for operation in[]string{"remove", "untrust", "deny"} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                Setup(test, operation == "untrust" ? "trusted": "manual")
                Access(test, operation == "untrust" ? "trust": "grant", issue: operation == "untrust" ? "": "1")
                let claim = Claim(test)
                let run = test.Prepare("tokate")
                let saved = File.ReadAllText(Path.Combine(run, "run.json"))
                let state = Check.Text(test.State()["sha"])
                Access(test, operation, issue: operation == "remove" ? "1": "")
                test.Flow.Call([]string{"work", "--run", run}, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "run.json")) == saved,
                    "Eligibility failure rewrote saved work"
                )
                Check.That(Check.Text(test.State()["sha"]) == state, "Membership edit changed contribution state")
                test.Prepare("tokate", 1)
                test.Coordinate(test.Event(claim), 1)
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
            using let publication = CoordinationFixture(binary)
            publication.Initialize()
            Setup(publication, "manual")
            Access(publication, "grant", issue: "1")
            let request = Claim(publication)
            let run = publication.Prepare()
            let commit = publication.Candidate(request)
            publication.Flow.Call([]string{"external", "--run", run, "--commit", commit})
            publication.Flow.Call([]string{"submit", "--run", run})
            let publish = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
            Access(publication, "remove", issue: "1")
            publication.Coordinate(publication.Event(publish), 1)
            publication.Flow.NoPr()
            publication.Flow.NoInference()
        }

        private func Authority(binary string) {
            for fault in[]string{"missing", "unavailable", "repo", "actor", "malformed", "task", "policy"} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                Setup(test, "open")
                Claim(test)
                let run = test.Prepare("tokate")
                let saved = File.ReadAllText(Path.Combine(run, "run.json"))
                if fault == "missing" {
                    test.Flow.Git("-C", test.Flow.Upstream, "update-ref", "-d", "refs/heads/tokate/access")
                } else if fault == "malformed" {
                    let blob = test.Flow.Git("-C", test.Flow.Upstream, "rev-parse", "HEAD")
                    test.Flow.Git("-C", test.Flow.Upstream, "update-ref", "refs/heads/tokate/access", blob)
                } else if fault == "policy" {
                    Policy(test, "manual")
                } else {
                    test.Flow.Reload()
                    if fault == "unavailable" {
                        test.Flow.State["fault_path"] = JsonValue.Create(
                            "repos/owner/project/git/ref/heads/tokate/access"
                        )
                        test.Flow.State["faults"] = Check.Json("[{\"status\":403}]")
                    } else if fault == "repo" {
                        test.Flow.State["repo_id"] = JsonValue.Create(99)
                    } else if fault == "actor" {
                        test.Flow.State["viewer_id"] = JsonValue.Create("123")
                    } else {
                        let issue = test.Flow.State["issue"] ?? throw Exception("Missing issue")
                        issue["title"] = JsonValue.Create("Changed task")
                    }
                    test.Flow.Save()
                }
                test.Flow.Call([]string{"work", "--run", run}, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "run.json")) == saved,
                    "Unknown authority rewrote saved work"
                )
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
        }

        private func Transport(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            Setup(test, "open")
            Access(test, "trust", code: 1, owner: false)
            test.Flow.Mode("lost_access_response")
            test.Flow.ResetTraffic()
            let mutation = Access(test, "trust", traffic: true)
            test.Flow.Traffic(7, 3, 0, 0, mutation)
            let reference = test.Flow.Git("-C", test.Flow.Upstream, "rev-parse", "refs/heads/tokate/access")
            let parents = test.Flow.Git("-C", test.Flow.Upstream, "rev-list", "--parents", "-n", "1", reference)
            Check.That(parents.Split(' ').Length == 2, "Access write lacks single parent")
            test.Flow.ResetTraffic()
            let gate = Access(test, "check", issue: "1", owner: false, traffic: true)
            test.Flow.Traffic(11, 0, 1, 0, gate)
            test.Flow.Mode("lost_state_response")
            let request = Claim(test, 1)
            let sha = Check.Text(test.State()["sha"])
            test.Coordinate(test.Event(request))
            let output = Check.Envelope(
                test.Flow.Call(
                    []string{"access", "--repo", "owner/project", "--operation", "check", "--issue", "1", "--json"}
                ),
                "access",
                "ok"
            )
            Check.That(
                Check.Text(output["data"]?["eligible"]) == "true" && Check.Text(
                    output["data"]?["eligibility"]
                ) == "open",
                "Eligibility JSON lost bounded gate result"
            )
            Check.That(Check.Text(test.State()["sha"]) == sha, "Duplicate claim repeated effects")
            let denied = Check.Envelope(
                test.Flow.Call(
                    []string{"access", "--repo", "owner/project", "--operation", "deny", "--donor", "donor", "--json"},
                    owner: true
                ),
                "access",
                "ok"
            )
            Check.That(Check.Text(denied["data"]?["actor"]) == "123", "Owner JSON lacks numeric actor")
            let rejected = Check.Envelope(
                test.Flow.Call(
                    []string{"access", "--repo", "owner/project", "--operation", "check", "--issue", "1", "--json"},
                    1
                ),
                "access",
                "error",
                "invalid_state"
            )
            Check.That(
                Check.Text(rejected["data"]?["eligible"]) == "false" && rejected["next_actions"]?.AsArray().Count > 0,
                "Denied JSON lacks gate failure or next action"
            )
            test.Coordinate(test.Event(request), 1)
            test.Flow.NoInference()
            test.Flow.NoPr()
        }

        private func Traffic(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            Setup(test, "trusted")
            test.Flow.ResetTraffic()
            let trusted = Access(test, "trust", traffic: true)
            test.Flow.Traffic(5, 3, 0, 0, trusted)
            let claim = test.ClaimRequest()
            let path = test.Event(claim)
            test.Flow.ResetTraffic()
            let acquired = test.Coordinate(path, traffic: true)
            test.Flow.Traffic(32, 3, 20, 0, acquired)
            let run = test.Prepare("tokate")
            test.Flow.Call([]string{"work", "--run", run})
            test.Flow.Call([]string{"submit", "--run", run})
            let publish = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
            test.Coordinate(test.Event(publish))
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["exec_count"]) == "1",
                "Eligible managed work did not execute exactly once"
            )
        }

        private func LatePublication(binary string) {
            for amend in[]bool{true, false} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                Setup(test, "open")
                let claim = Claim(test)
                let previous = test.Candidate(claim)
                var request = test.PublishRequest(claim, previous)
                let branch = "tokate/v2-" + Check.Text(claim["uuid"])
                if amend {
                    test.Coordinate(test.Event(request))
                    let checkout = Path.Combine(test.Flow.Temp.Root, "donor-work")
                    File.AppendAllText(Path.Combine(checkout, "result.txt"), "Reviewed change\n")
                    test.Flow.Git("-C", checkout, "add", ".")
                    test.Flow.Git(
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
                    let head = test.Flow.Git("-C", checkout, "rev-parse", "HEAD")
                    test.Flow.Git(
                        "-C",
                        checkout,
                        "push",
                        Path.Combine(test.Flow.Bin, "fork"),
                        "HEAD:refs/heads/" + branch
                    )
                    test.Flow.Reload()
                    let pullHead = test.Flow.State["pulls"]?[0]?["head"] ?? throw Exception("Missing PR head")
                    pullHead["sha"] = JsonValue.Create(head)
                    test.Flow.Save()
                    let state = test.State()
                    request = Check.Map(
                        "uuid",
                        Guid.NewGuid().ToString("D"),
                        "expected",
                        Check.Text(state["sha"]),
                        "approval",
                        Check.Text(state["state"]?["approval_id"]),
                        "action",
                        "amend",
                        "metadata",
                        Check.Map(
                            "fork",
                            "donor/project",
                            "branch",
                            branch,
                            "previous",
                            previous,
                            "head",
                            head,
                            "pr",
                            10,
                            "seconds",
                            30,
                            "tools",
                            JsonArray(),
                            "verification",
                            "donor-reported-pass",
                            "attempt",
                            Check.Text(state["state"]?["reservation"]?["attempt"])
                        )
                    )
                }
                let stateBefore = Check.Text(test.State()["sha"])
                test.Flow.Reload()
                let bodyBefore = Check.Text(test.Flow.State["pulls"]?[0]?["body"])
                let path = amend ? "repos/owner/project/pulls/10": "repos/donor/project/git/ref/heads/" + branch
                test.Flow.State["access_revoke_after_path"] = JsonValue.Create(path)
                test.Flow.State["access_revoke_after_read"] = JsonValue.Create(2)
                test.Flow.Save()
                test.Flow.ResetTraffic()
                let failure = test.Coordinate(test.Event(request), 1)
                test.Flow.Reload()
                Check.That(
                    Check.Text(test.Flow.State["access_revoked_on_read"]) == "true",
                    "Late revocation did not run: " + failure.Error
                )
                for call in test.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                    Check.That(
                        Check.Text(call["method"]) == "GET" || !Check.Text(call["path"]).StartsWith(
                            "repos/owner/project/pulls"
                        ),
                        "Revoked donor wrote a PR after downstream evidence read: " + call?.ToJsonString()
                    )
                }
                if amend {
                    Check.That(
                        Check.Text(test.Flow.State["pulls"]?[0]?["body"]) == bodyBefore,
                        "Revoked amendment changed PR body"
                    )
                } else {
                    test.Flow.NoPr()
                }
                Check.That(
                    Check.Text(test.State()["sha"]) == stateBefore,
                    "Revoked publication changed contribution state"
                )
                test.Flow.NoInference()
            }
        }

        private func RevokeAt(test CoordinationFixture, read int32) {
            test.Flow.Reload()
            test.Flow.State["access_reads"] = JsonValue.Create(0)
            test.Flow.State["access_revoke_at"] = JsonValue.Create(read)
            test.Flow.Save()
        }

        private func Races(binary string) {
            for read in[]int32{2, 3} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                Setup(test, "open")
                RevokeAt(test, read)
                Claim(test, 1)
                test.Prepare("tokate", 1)
                test.Flow.NoInference()
                test.Flow.NoPr()
            }
            using let execution = CoordinationFixture(binary)
            execution.Initialize()
            Setup(execution, "open")
            Claim(execution)
            let run = execution.Prepare("tokate")
            RevokeAt(execution, 2)
            execution.Flow.Call([]string{"work", "--run", run}, 1)
            execution.Flow.NoInference()
            execution.Flow.NoPr()
            for read in[]int32{2, 4} {
                using let test = CoordinationFixture(binary)
                test.Initialize()
                Setup(test, "open")
                let claim = Claim(test)
                let saved = test.Prepare()
                let commit = test.Candidate(claim)
                test.Flow.Call([]string{"external", "--run", saved, "--commit", commit})
                test.Flow.Call([]string{"submit", "--run", saved})
                let publish = Check.Json(File.ReadAllText(Path.Combine(saved, "request.json")))
                RevokeAt(test, read)
                test.Coordinate(test.Event(publish), 1)
                test.Flow.Reload()
                if read == 2 {
                    test.Flow.NoPr()
                } else {
                    Check.That(
                        test.Flow.State["pulls"]?.AsArray().Count == 1,
                        "Uncertain publication did not preserve physical PR"
                    )
                    test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, true)
                }
                Check.That(test.State()["state"]?["contribution"] == nil, "Revoked access authorized publication")
                test.Flow.NoInference()
            }
            using let conflict = CoordinationFixture(binary)
            conflict.Initialize()
            Setup(conflict, "trusted")
            conflict.Flow.Mode("access_conflict")
            conflict.Flow.ResetTraffic()
            Access(conflict, "trust", code: 1, traffic: true)
            conflict.Flow.Reload()
            var patches int32
            for call in conflict.Flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                if Check.Text(call["path"]) == "repos/owner/project/git/refs/heads/tokate/access" {
                    patches++
                }
            }
            Check.That(patches == 1, "Conflicting access write was repeated")
            Access(conflict, "check", issue: "1", code: 1, owner: false)
        }

        private func Declarations(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            Access(test, "init")
            let path = Path.Combine(test.Flow.Upstream, ".github/tokate.json")
            let original = File.ReadAllText(path)
            for invalid in[]string{
                "\"eligibility\":\"open\"",
                "\"approval_scope\":\"task\"",
                "\"eligibility\":\"Open\",\"approval_scope\":\"task\"",
                "\"eligibility\":null,\"approval_scope\":\"task\"",
                "\"eligibility\":\"open\",\"approval_scope\":\"donor\"",
                "\"eligibility\":\"open\",\"eligibility\":\"manual\",\"approval_scope\":\"task\"",
                "\"eligibility\":\"open\",\"approval_scope\":\"task\",\"version\":2"
            } {
                File.WriteAllText(path, original.TrimEnd().TrimEnd('}') + "," + invalid + "}")
                test.Flow.Commit("Malformed owner declaration")
                test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, 1, true)
            }
            File.WriteAllText(path, original)
            test.Flow.Commit("Restore legacy policy")
            Policy(test, "open")
            test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"}, 1, true)
            test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
            for text in[]string{
                "{\"version\":1,\"repo_id\":99,\"members\":[]}",
                "{\"version\":1,\"repo_id\":1,\"members\":[{\"actor\":\"123\",\"trusted\":true,\"denied\":false,\"issues\":[]}]}",
                "{\"version\":1,\"repo_id\":1,\"members\":[],\"pending\":[]}",
                "{\"version\":1,\"repo_id\":1,\"members\":[{\"actor\":123,\"trusted\":true,\"denied\":false,\"issues\":[1,1]}]}"
            } {
                test.Flow.Reload()
                test.Flow.State["access_override"] = JsonValue.Create(text)
                test.Flow.Save()
                Access(test, "check", issue: "1", code: 1, owner: false)
                Claim(test, 1)
            }
            test.Flow.Reload()
            test.Flow.State["access_override"] = nil
            test.Flow.Save()
            let state = test.State()["state"] ?? throw Exception("Missing state")
            let approval = state["approval"] ?? throw Exception("Missing approval")
            approval["donor"] = JsonValue.Create("donor")
            test.RewriteState(state)
            Claim(test, 1)
            test.Flow.NoInference()
            test.Flow.NoPr()
        }

        internal func All(binary string, selected string) {
            switch selected {
                case "EligibilityTraffic" {
                    Traffic(binary)
                }
                case "EligibilityRaces" {
                    Races(binary)
                }
                case "EligibilityLatePublication" {
                    LatePublication(binary)
                }
                case "EligibilityDeclarations" {
                    Declarations(binary)
                }
                case "EligibilityModes" {
                    Modes(binary)
                }
                case "EligibilityRevocation" {
                    Revocation(binary)
                }
                case "EligibilityAuthority" {
                    Authority(binary)
                }
                case "EligibilityTransport" {
                    Transport(binary)
                }
                case "EligibilityConcurrency" {
                    using let test = CoordinationFlow(binary)
                    test.Initialize()
                    Setup(test, "open")
                    test.Flow.ResetTraffic()
                    test.SimultaneousClaims()
                }
            }
            Console.WriteLine("PASS V2 " + selected)
        }
    }
}
