package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class RepairCase {
    internal let Flow NativeFixture
    internal let Checkout string
    internal let Evidence string
    internal var Candidate string = ""
    internal var Grant string = ""
    internal let Previous string
    internal let Branch string

    private init(flow NativeFixture, checkout string, evidence string, previous string, branch string) {
        Flow = flow
        Checkout = checkout
        Evidence = evidence
        Previous = previous
        Branch = branch
    }

    shared {
        internal func Create(flow NativeFixture, run string, fault string = "", target bool = false) RepairCase {
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            let Previous = Check.Text(saved["commit"])
            let Branch = Check.Text(saved["branch"])
            let Checkout = Path.Combine(flow.Temp.Root, "repair-checkout")
            let Evidence = Path.Combine(flow.Temp.Root, "repair-evidence")
            flow.Git("clone", "-b", Branch, Path.Combine(flow.Bin, "fork"), Checkout)
            Directory.Delete(run, true)
            var upstream = flow.Git("-C", flow.Upstream, "rev-parse", "main")
            if target {
                PublishedContribution.Write(flow.Upstream, ".github/workflows/verify.yml", "timeout-minutes: 30\n")
                flow.Commit("Owner target update")
                upstream = flow.Git("-C", flow.Upstream, "rev-parse", "main")
                flow.Git("-C", Checkout, "fetch", flow.Upstream, upstream)
                flow.Git(
                    "-C",
                    Checkout,
                    "-c",
                    "user.name=Reviewed",
                    "-c",
                    "user.email=fixture@example.test",
                    "merge",
                    "--no-ff",
                    "--no-edit",
                    upstream
                )
            }
            PublishedContribution.Write(Checkout, "result.txt", fault == "verification" ? "": "Owner-reviewed repair\n")
            if fault == "protected" {
                PublishedContribution.Write(Checkout, ".github/workflows/donor.yml", "unapproved workflow\n")
            }
            if fault == "rename" {
                flow.Git("-C", Checkout, "mv", "protected/content", "stolen.txt")
            }
            if fault == "mutating" {
                PublishedContribution.Write(Checkout, "mutate", "trigger\n")
            }
            if fault == "interrupt" {
                PublishedContribution.Write(Checkout, "slow", "trigger\n")
            }
            let test = RepairCase(flow, Checkout, Evidence, Previous, Branch)
            test.Candidate = test.Commit()
            let result = flow.Call(
                []string{
                    "authorize-sync",
                    "--repo",
                    "owner/project",
                    "--pr",
                    "10",
                    "--commit",
                    test.Candidate,
                    "--upstream",
                    upstream,
                    "--json"
                },
                owner: true
            )
            test.Grant = Check.Text(Check.Json(result.Output)["data"]?["grant"])
            flow.Reload()
            let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing repair PR")
            pull["body"] = JsonValue.Create("Maintainer before\n" + Check.Text(pull["body"]) + "\nMaintainer after")
            flow.State["repair_directory"] = JsonValue.Create(Evidence)
            flow.Save()
            return test
        }
    }

    internal func Commit() string {
        Flow.Git("-C", Checkout, "add", "-A")
        Flow.Git(
            "-C",
            Checkout,
            "-c",
            "user.name=Reviewed",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "Reviewed repair"
        )
        return Flow.Git("-C", Checkout, "rev-parse", "HEAD")
    }

    internal func Call(code int32 = 0, seconds string = "30", candidate string = "") Result -> Flow.Call(
        []string{
            "repair",
            "--repo",
            "owner/project",
            "--pr",
            "10",
            "--run",
            Evidence,
            "--path",
            Checkout,
            "--commit",
            candidate == "" ? Candidate: candidate,
            "--sync",
            Grant,
            "--seconds",
            seconds,
            "--json"
        },
        code
    )

    internal func Saved() JsonNode -> Check.Json(File.ReadAllText(Path.Combine(Evidence, "repair.json")))

    internal func Unpublished() {
        Flow.Reload()
        Check.That(Check.Text(Flow.State["pulls"]?[0]?["head"]?["sha"]) == Previous, "Refused repair published")
        Check.That(Check.Text(Flow.State["exec_count"]) == "1", "Repair ran inference")
        Check.That(Check.Text(Flow.State["pr_create_count"]) == "1", "Repair created another PR")
    }
}

internal class RepairChecks {
    shared {
        private func Valid(test RepairCase) {
            let result = test.Call()
            Check.That(
                Check.Text(Check.Json(result.Output)["data"]?["repair"]?["state"]) == "published",
                "Missing repair result"
            )
            let saved = test.Saved()
            let checks = Check.Text(saved["verification"])
            let id = Check.Text(saved["id"])
            Check.That(saved["verification"]?.AsArray().Count == 2, "Repair omitted full owner verification")
            Check.That(
                !File.Exists(Path.Combine(test.Evidence, "run.json")) && !Directory.Exists(
                    Path.Combine(test.Evidence, "original-evidence")
                ),
                "Repair fabricated original private state"
            )
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing repaired PR")
            let body = Check.Text(pull["body"])
            Check.Contains(body, "Maintainer before")
            Check.Contains(body, "Maintainer after")
            Check.Contains(body, "original private state was unavailable")
            Check.That(
                body.Contains("<!-- tokate-run:") && Check.Text(pull["head"]?["sha"]) == test.Candidate,
                "Repair lost head or marker"
            )
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            test.Call()
            Check.That(
                Check.Text(test.Saved()["verification"]) == checks && Check.Text(test.Saved()["id"]) == id,
                "Repeated repair replaced intent or checks"
            )
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["exec_count"]) == "1" && Check.Text(
                    test.Flow.State["pr_create_count"]
                ) == "1",
                "Repair repeated inference/publication"
            )
            Check.That(Check.Text(test.Flow.State["git_pushes"]) == "2", "Repeated repair pushed again")
            let pending = test.Flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10", "--json"}, 8)
            Check.Contains(pending.Output, "pending")
        }

        private func Refuse(test RepairCase, fault string) {
            let flow = test.Flow
            switch fault {
                case "approval" {
                    flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                }
                case "replacement" {
                    flow.Approve()
                }
                case "target" {
                    PublishedContribution.Write(flow.Upstream, "later.txt", "Target moved\n")
                    flow.Commit("Moved target")
                }
                case "policy",
                "template",
                "issue",
                "numeric",
                "draft",
                "closed",
                "merged",
                "marker",
                "receipt",
                "report",
                "fork" {
                    flow.Reload()
                    let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
                    if fault == "policy" {
                        let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                        let policy = Check.Json(File.ReadAllText(path))
                        policy["max_seconds"] = JsonValue.Create(600)
                        File.WriteAllText(path, policy.ToJsonString())
                        flow.Commit("Changed policy")
                    } else if fault == "template" {
                        File.AppendAllText(Path.Combine(flow.Upstream, ".github/tokate-pr.md"), "Changed template\n")
                        flow.Commit("Changed template")
                    } else if fault == "issue" {
                        (flow.State["issue"] ?? throw Exception("Missing issue"))["body"] = JsonValue.Create(
                            "Changed task"
                        )
                    } else if fault == "numeric" {
                        (pull["user"] ?? throw Exception("Missing author"))["id"] = JsonValue.Create(999)
                    } else if fault == "fork" {
                        flow.State["fork_owner_id"] = JsonValue.Create(999)
                    } else if fault == "draft" {
                        pull["draft"] = JsonValue.Create(false)
                    } else if fault == "closed" {
                        pull["state"] = JsonValue.Create("closed")
                    } else if fault == "merged" {
                        pull["merged_at"] = JsonValue.Create("2026-01-01T00:00:00Z")
                    } else if fault == "marker" {
                        pull["body"] = JsonValue.Create(
                            Check.Text(pull["body"]) + "\n<!-- tokate-run:" + String('a', 32) + " -->"
                        )
                    } else if fault == "receipt" {
                        let body = Check.Text(pull["body"])
                        let start = body.IndexOf("<!-- tokate-receipt:")
                        let end = body.IndexOf(" -->", start)
                        pull["body"] = JsonValue.Create(body + "\n" + body.Substring(start, end + 4 - start))
                    } else if fault == "report" {
                        pull["body"] = JsonValue.Create(
                            Check.Text(pull["body"]) +
                                "\n<!-- tokate-report:start -->duplicate<!-- tokate-report:end -->"
                        )
                    }
                    flow.Save()
                }
                case "head", "branch" {
                    flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", test.Checkout, test.Candidate)
                    flow.Git(
                        "-C",
                        Path.Combine(flow.Bin, "fork"),
                        "update-ref",
                        "refs/heads/" + test.Branch,
                        test.Candidate
                    )
                    if fault == "head" {
                        flow.Reload()
                        let head = flow.State["pulls"]?[0]?["head"] ?? throw Exception("Missing head")
                        head["sha"] = JsonValue.Create(test.Candidate)
                        flow.Save()
                    }
                }
                case "candidate" {
                    File.AppendAllText(Path.Combine(test.Checkout, "result.txt"), "Unapproved edit\n")
                    test.Commit()
                }
                case "index" {
                    flow.Git("-C", test.Checkout, "update-index", "--assume-unchanged", "result.txt")
                    File.AppendAllText(Path.Combine(test.Checkout, "result.txt"), "Hidden edit\n")
                }
                case "metadata" {
                    File.WriteAllText(Path.Combine(test.Checkout, ".git/objects/info/alternates"), "/missing\n")
                }
                case "worktree" {
                    flow.Git("-C", test.Checkout, "config", "core.worktree", flow.Upstream)
                }
                case "revoked-grant" {
                    flow.Call([]string{"revoke-sync", "--repo", "owner/project", "--grant", test.Grant}, owner: true)
                }
            }
            test.Call(1)
            Check.That(
                !File.Exists(Path.Combine(test.Evidence, "verification.json")),
                "Refused authority reached verification"
            )
            if fault != "head" && fault != "branch" {
                test.Unpublished()
            }
        }

        private func Failed(test RepairCase) {
            test.Call(1)
            let saved = test.Saved()
            Check.That(
                Check.Text(saved["state"]) == "failed" && saved["verification"]?.AsArray().Count == 2,
                "Failed repair lost checks"
            )
            let checks = Check.Text(saved["verification"])
            test.Call(1)
            Check.That(Check.Text(test.Saved()["verification"]) == checks, "Failed verification retried implicitly")
            test.Unpublished()
        }

        private func InterruptedPublication(test RepairCase, mode string) {
            test.Flow.Mode(mode)
            test.Call(1)
            let saved = test.Saved()
            Check.That(Check.Text(saved["state"]) == "publishing", "Publication lost intent")
            let id = Check.Text(saved["id"])
            let checks = Check.Text(saved["verification"])
            if mode == "push_fail" || mode == "body_fail" {
                test.Flow.Mode("")
            }
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            pull["body"] = JsonValue.Create(Check.Text(pull["body"]) + "\nMaintainer during interruption")
            test.Flow.Save()
            test.Call()
            Check.That(
                Check.Text(test.Saved()["id"]) == id && Check.Text(test.Saved()["verification"]) == checks,
                "Resume replaced intent/checks"
            )
            test.Flow.Reload()
            Check.Contains(Check.Text(test.Flow.State["pulls"]?[0]?["body"]), "Maintainer during interruption")
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"})
            Check.That(Check.Text(test.Flow.State["exec_count"]) == "1", "Repair resume ran inference")
        }

        private func ChangedAfterVerification(test RepairCase, fault string) {
            test.Flow.Mode("push_fail")
            test.Call(1)
            let saved = test.Saved()
            let checks = Check.Text(saved["verification"])
            let id = Check.Text(saved["id"])
            test.Flow.Mode("")
            if fault == "candidate" {
                File.AppendAllText(Path.Combine(test.Checkout, "result.txt"), "Changed after checks\n")
                test.Commit()
            } else if fault == "approval" {
                test.Flow.Approve()
            } else if fault == "intent" {
                test.Call(1, "29")
                Check.That(Check.Text(test.Saved()["id"]) == id, "Changed inputs replaced intent")
                test.Unpublished()
                return
            } else {
                test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "fetch", test.Checkout, test.Candidate)
                test.Flow.Git(
                    "-C",
                    Path.Combine(test.Flow.Bin, "fork"),
                    "update-ref",
                    "refs/heads/" + test.Branch,
                    test.Candidate
                )
            }
            test.Call(1)
            Check.That(
                Check.Text(test.Saved()["verification"]) == checks && Check.Text(test.Saved()["id"]) == id,
                "Refusal rewrote passed evidence"
            )
        }

        private func ExactReceipt(test RepairCase, fault string) {
            test.Call()
            test.Flow.Reload()
            let pull = test.Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
            let body = Check.Text(pull["body"])
            let prefix = "<!-- tokate-receipt:"
            let start = body.IndexOf(prefix)
            let end = body.IndexOf(" -->", start)
            let receipt = Check.Json(body.Substring(start + prefix.Length, end - start - prefix.Length))
            if fault == "head" {
                (pull["head"] ?? throw Exception("Missing head"))["sha"] = JsonValue.Create(test.Previous)
            } else if fault == "report" {
                pull["body"] = JsonValue.Create(
                    body.Replace("original private state was unavailable", "original private state was recovered")
                )
            } else {
                let repair = receipt["repair"] ?? throw Exception("Missing provenance")
                repair[fault] = fault == "donor_id" || fault == "head_repository_id" ? JsonValue.Create(
                    999
                ) as JsonNode: JsonValue.Create(test.Previous) as JsonNode
                pull["body"] = JsonValue.Create(
                    body.Remove(start, end + 4 - start).Insert(start, prefix + receipt.ToJsonString() + " -->")
                )
            }
            test.Flow.Save()
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        }

        private func Race(test RepairCase) {
            test.Flow.Mode("repair_race_before_push")
            test.Call(1)
            let checks = Check.Text(test.Saved()["verification"])
            test.Flow.Reload()
            let head = Check.Text(test.Flow.State["pulls"]?[0]?["head"]?["sha"])
            Check.That(head != test.Candidate && head != test.Previous, "Repair lease overwrote concurrent remote head")
            test.Call(1)
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["pulls"]?[0]?["head"]?["sha"]) == head && Check.Text(
                    test.Saved()["verification"]
                ) == checks,
                "Stale repair resume changed remote or checks"
            )
            Console.WriteLine("PASS repair race")
        }

        internal func All(binary string, selected string = "") {
            using let prepared = PublishedContribution.Create(binary, synchronization: true)
            let flow = prepared.Coordination.Flow
            var matched bool
            for name in[]string{
                "valid",
                "target-sync",
                "protected",
                "rename",
                "verification",
                "approval",
                "replacement",
                "target",
                "policy",
                "template",
                "issue",
                "numeric",
                "fork",
                "draft",
                "closed",
                "merged",
                "marker",
                "receipt",
                "report",
                "head",
                "branch",
                "candidate",
                "index",
                "metadata",
                "worktree",
                "revoked-grant",
                "race",
                "lost_push_response",
                "lost_body_response",
                "push_fail",
                "body_fail",
                "saved-candidate",
                "saved-approval",
                "saved-intent",
                "receipt-head",
                "receipt-report",
                "receipt-donor_id",
                "receipt-head_repository_id",
                "receipt-sync"
            } {
                if selected != "" && selected != name {
                    continue
                }
                matched = true
                if selected == "" && !CiShard.Include("Repair/" + name) {
                    continue
                }
                prepared.Restore()
                let test = RepairCase.Create(flow, prepared.Run, name, name == "target-sync")
                if name == "valid" || name == "target-sync" {
                    Valid(test)
                } else if name == "race" {
                    Race(test)
                } else if name == "verification" {
                    Failed(test)
                } else if name.StartsWith("saved-") {
                    ChangedAfterVerification(test, name.Substring(6))
                } else if name.StartsWith("receipt-") {
                    ExactReceipt(test, name.Substring(8))
                } else if name == "lost_push_response" ||
                    name == "lost_body_response" ||
                    name == "push_fail" ||
                    name == "body_fail" {
                    InterruptedPublication(test, name)
                } else {
                    Refuse(test, name)
                }
                Console.WriteLine("PASS repair " + name)
            }
            if selected == "mutating" || (selected == "" && CiShard.Include("Repair/mutating")) {
                matched = true
                using let mutating = PublishedContribution.Create(binary, mutating: true)
                let test = RepairCase.Create(mutating.Coordination.Flow, mutating.Run, "mutating")
                test.Call(1)
                Check.That(Check.Text(test.Saved()["state"]) == "failed", "Verifier mutation passed")
                test.Unpublished()
                Console.WriteLine("PASS repair mutating")
            }
            if selected == "interrupt" || (selected == "" && CiShard.Include("Repair/interrupt")) {
                matched = true
                using let interrupt = NativeFixture(binary)
                let run = PublishedContribution.Original(interrupt, interruptible: true)
                let test = RepairCase.Create(interrupt, run, "interrupt")
                test.Call(1, "1")
                let evidence = Check.Text(test.Saved()["verification"])
                test.Call(1, "1")
                Check.That(Check.Text(test.Saved()["verification"]) == evidence, "Interrupted checks repeated")
                Check.That(
                    File.Exists(Path.Combine(test.Evidence, "verification.json")),
                    "Partial verification evidence lost"
                )
                test.Unpublished()
                Console.WriteLine("PASS repair interrupt")
            }
            Check.That(matched, "Unknown repair selector: " + selected)
        }
    }
}
