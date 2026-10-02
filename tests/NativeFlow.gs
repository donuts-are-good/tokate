package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class NativeFlow : IDisposable {
    internal let Temp Temp = Temp()
    internal let Binary string
    internal let Bin string
    internal let Upstream string
    internal var State JsonNode = Check.Json(
        "{\"issue\":{\"number\":1,\"state\":\"open\",\"title\":\"Implement fixture\",\"body\":\"Acceptance criteria: result.txt exists.\",\"labels\":[],\"assignees\":[]}}"
    )

    internal init(binary string) {
        Binary = binary
        Bin = Path.Combine(Temp.Root, "bin")
        Upstream = Path.Combine(Bin, "upstream")
        for name in[]string{"git", "gh", "codex-impl"} {
            Temp.Tool(name)
        }
        Directory.CreateSymbolicLink(Path.Combine(Bin, "alias"), Bin)
        File.CreateSymbolicLink(Path.Combine(Bin, "codex"), Path.Combine(Bin, "alias/codex-impl"))
        Temp.Env["GH_TOKEN"] = "fixture-secret"
        Temp.Env["OPENAI_API_KEY"] = "fixture-secret"
        Save()
    }

    internal func Initialize() {
        Git("init", "-b", "main", Upstream)
        Call([]string{"init", "--path", Upstream})
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        policy["verification"] = Check.Json("[[\"/bin/sh\",\"-c\",\"test -f result.txt\"]]")
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Initial")
        Git("clone", "--bare", Upstream, Path.Combine(Bin, "fork"))
    }

    public func Dispose() -> Temp.Dispose()

    internal func Save() -> File.WriteAllText(Path.Combine(Bin, "state.json"), State.ToJsonString())

    internal func Reload() {
        State = Check.Json(File.ReadAllText(Path.Combine(Bin, "state.json")))
    }

    internal func Git(args ...string) string -> Check.Success(Check.Run("/usr/bin/git", args, Temp.Env))

    internal func Commit(message string) {
        Git("-C", Upstream, "add", ".")
        Git("-C", Upstream, "-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "-m", message)
    }

    internal func Call(args[]string, code int32 = 0, owner bool = false) Result {
        let env = Dictionary[string, string](Temp.Env)
        env["FIXTURE_ACTOR"] = owner ? "owner": "donor"
        let result = Check.Run(Binary, args, env)
        Check.That(
            result.Code == code,
            "Expected exit " + code.ToString() + ", got " + result.Code.ToString() + "\n" + result.Output + result.Error
        )
        return result
    }

    internal func Approve() -> Call(
        []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"},
        owner: true
    )

    internal func Claim(seconds string = "30", model string = "gpt-6.1-sol", code int32 = 0) string {
        let result = Call(
            []string{
                "claim",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--model",
                model,
                "--effort",
                "high",
                "--seconds",
                seconds,
                "--runs",
                Path.Combine(Temp.Root, "runs")
            },
            code
        )
        let index = result.Output.LastIndexOf("Run: ")
        return index < 0 ? "": result.Output.Substring(index + 5).Trim()
    }

    internal func Mode(value string) {
        Reload()
        State["mode"] = JsonValue.Create(value)
        Save()
    }

    internal func NoInference() {
        Reload()
        Check.That(State["exec_count"] == nil, "Unexpected inference")
    }

    internal func NoPr() {
        Reload()
        Check.That(State["pulls"] == nil, "Unexpected PR")
    }

    internal func HelpAndArguments() {
        Check.Contains(Call([]string{"--help"}).Output, "toh-KAH-teh")
        Call([]string{"nonsense"}, 1)
        Call([]string{"approve", "--unknown", "true"}, 1)
        Call([]string{"init", "--path", Upstream}, 1)
    }

    internal func MissingTools() {
        let empty = Path.Combine(Temp.Root, "empty")
        Directory.CreateDirectory(empty)
        Temp.Env["PATH"] = empty
        let help = Call([]string{"--help"})
        Check.Contains(help.Output, "toh-KAH-teh")
        for name in[]string{"git", "gh", "codex", "setsid"} {
            Check.Contains(help.Error, name + ": missing")
        }
        Check.That(!(help.Output + help.Error).Contains('\u001b'), "Redirected output contains ANSI")
        let doctor = Call([]string{"doctor"}, 1)
        Check.Contains(doctor.Output, "sandbox: skipped")
        for name in[]string{"git", "gh", "codex", "setsid"} {
            Check.Contains(doctor.Output, name + ": missing")
        }
        let work = Call([]string{"work", "--repo", "owner/project", "--issue", "1"}, 1)
        Check.Contains(work.Error, "Install the tools needed")
        NoInference()
    }

    internal func OwnerWithoutCodex() {
        let codex = Path.Combine(Bin, "codex")
        File.Delete(codex)
        File.WriteAllText(codex, "not executable")
        let result = Call(
            []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"},
            owner: true
        )
        Check.Contains(result.Error, "codex: missing")
        Check.Contains(result.Output, "Approved")
        Check.Contains(
            Call([]string{"work", "--repo", "owner/project", "--issue", "1"}, 1).Error,
            "Install the tools needed"
        )
    }

    internal func CrossAccountFlow() {
        Approve()
        let run = Claim()
        Claim(code: 1)
        Call([]string{"work", "--run", run})
        Call([]string{"publish", "--run", run})
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Publication reran inference")
        Check.That(Check.Text(State["pulls"]?[0]?["draft"]) == "true", "PR must be draft")
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        Call([]string{"checks", "--run", run}, 8)
        for check in[]string{"unrelated:pass:8", "verify:skipping:8", "verify:fail:1", "verify:pass:0"} {
            Reload()
            let parts = check.Split(':')
            let checks = JsonArray()
            checks.Add(Check.Map("name", parts[0], "bucket", parts[1]))
            State["checks"] = checks
            Save()
            Call([]string{"checks", "--repo", "owner/project", "--pr", "10"}, Int32.Parse(parts[2]), true)
        }
        Reload()
        let head = State["pulls"]?[0]?["head"] ?? throw Exception("Missing PR head")
        head["sha"] = JsonValue.Create(String('a', 40))
        Save()
        Call([]string{"checks", "--run", run}, 1)
    }

    internal func OwnerPolicy() {
        Call([]string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"}, 1)
        Approve()
        Claim(model: "not-allowed", code: 1)
        Claim(seconds: "2000", code: 1)
        NoInference()
    }

    internal func FailedReassignment() {
        Approve()
        Reload()
        State["unassignable"] = JsonValue.Create(true)
        Save()
        Check.Contains(
            Call([]string{"assign", "--repo", "owner/project", "--issue", "1", "--donor", "new-donor"}, 1, true).Error,
            "comment on the issue"
        )
        Reload()
        Check.That(
            State["issue"]?["assignees"]?.AsArray().Count == 1 && Check.Text(
                State["issue"]?["assignees"]?[0]?["login"]
            ) == "donor",
            "Failed assignment changed donor"
        )
        Claim()
        Reload()
        State["unassignable"] = JsonValue.Create(false)
        Save()
        Call([]string{"assign", "--repo", "owner/project", "--issue", "1", "--donor", "new-donor"}, owner: true)
        Reload()
        Check.That(
            State["issue"]?["assignees"]?.AsArray().Count == 1 && Check.Text(
                State["issue"]?["assignees"]?[0]?["login"]
            ) == "new-donor",
            "Assignment did not replace donor"
        )
    }

    internal func MissingFork() {
        Approve()
        Reload()
        State["missing_fork"] = JsonValue.Create(true)
        Save()
        Check.Contains(
            Call(
                []string{
                    "claim",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "high"
                },
                1
            ).Error,
            "gh repo fork owner/project --clone=false"
        )
        NoInference()
    }

    internal func DefaultBudget() {
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        policy["max_seconds"] = JsonValue.Create(30)
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Lower budget")
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
        Approve()
        let result = Call(
            []string{
                "claim",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--model",
                "gpt-6.1-sol",
                "--effort",
                "high",
                "--runs",
                Path.Combine(Temp.Root, "runs")
            }
        )
        let run = result.Output.Substring(result.Output.LastIndexOf("Run: ") + 5).Trim()
        Check.That(
            Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["seconds"]) == "30",
            "Owner budget ignored"
        )
        Call([]string{"work", "--run", run})
    }

    internal func IssueEdit() {
        Approve()
        Reload()
        let issue = State["issue"] ?? throw Exception("Missing issue")
        issue["body"] = JsonValue.Create("Changed task")
        Save()
        Claim(code: 1)
    }

    internal func Revocation() {
        Approve()
        let run = Claim()
        Mode("revoke")
        Call([]string{"work", "--run", run}, 1)
        NoPr()
        Call([]string{"publish", "--run", run}, 1)
    }

    internal func Timeout() {
        Approve()
        let run = Claim(seconds: "1")
        Mode("timeout")
        Call([]string{"work", "--run", run}, 1)
        let pid = File.ReadAllText(Path.Combine(Bin, "child.pid"))
        let status = "/proc/" + pid + "/stat"
        Check.That(!File.Exists(status) || File.ReadAllText(status).Split(' ')[2] == "Z", "Descendant survived timeout")
        Call([]string{"work", "--run", run}, 1)
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Failed run retried inference")
    }

    internal func Reapproval() {
        Approve()
        let run = Claim()
        Call([]string{"assign", "--repo", "owner/project", "--issue", "1", "--donor", "donor"}, owner: true)
        Call([]string{"work", "--run", run}, 1)
        NoInference()
    }

    internal func FalseSuccess() {
        Approve()
        let run = Claim()
        Mode("verification_fail")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "Owner verification failed")
        Check.That(
            Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "verification.json")))[0]?["exit_code"]) == "1",
            "Failed verification not recorded"
        )
        NoPr()
    }

    internal func PolicyEdit() {
        Approve()
        let run = Claim()
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        policy["models"] = Check.Json("{\"gpt-6.1-sol\":[\"low\"]}")
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Change policy")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "policy or template changed")
        NoInference()
    }

    internal func WorkflowEdit() {
        Approve()
        let run = Claim()
        Mode("workflow")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "cannot change owner policy")
        NoPr()
    }

    internal func RepositoryConfig() {
        Directory.CreateDirectory(Path.Combine(Upstream, ".codex"))
        File.WriteAllText(Path.Combine(Upstream, ".codex/config.toml"), "sandbox_mode=\"danger-full-access\"")
        Commit("Agent config")
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
        Approve()
        let run = Claim()
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "Repository Codex configuration")
        NoInference()
    }

    internal func NoPatch() {
        Approve()
        let run = Claim()
        Mode("empty")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "No changes returned")
        NoPr()
    }

    shared {
        internal func All(binary string) {
            for name in[]string{
                "HelpAndArguments",
                "MissingTools",
                "OwnerWithoutCodex",
                "CrossAccountFlow",
                "OwnerPolicy",
                "FailedReassignment",
                "MissingFork",
                "DefaultBudget",
                "IssueEdit",
                "Revocation",
                "Timeout",
                "Reapproval",
                "FalseSuccess",
                "PolicyEdit",
                "WorkflowEdit",
                "RepositoryConfig",
                "NoPatch"
            } {
                using let flow = NativeFlow(binary)
                flow.Initialize()
                switch name {
                    case "HelpAndArguments" {
                        flow.HelpAndArguments()
                    }
                    case "MissingTools" {
                        flow.MissingTools()
                    }
                    case "OwnerWithoutCodex" {
                        flow.OwnerWithoutCodex()
                    }
                    case "CrossAccountFlow" {
                        flow.CrossAccountFlow()
                    }
                    case "OwnerPolicy" {
                        flow.OwnerPolicy()
                    }
                    case "FailedReassignment" {
                        flow.FailedReassignment()
                    }
                    case "MissingFork" {
                        flow.MissingFork()
                    }
                    case "DefaultBudget" {
                        flow.DefaultBudget()
                    }
                    case "IssueEdit" {
                        flow.IssueEdit()
                    }
                    case "Revocation" {
                        flow.Revocation()
                    }
                    case "Timeout" {
                        flow.Timeout()
                    }
                    case "Reapproval" {
                        flow.Reapproval()
                    }
                    case "FalseSuccess" {
                        flow.FalseSuccess()
                    }
                    case "PolicyEdit" {
                        flow.PolicyEdit()
                    }
                    case "WorkflowEdit" {
                        flow.WorkflowEdit()
                    }
                    case "RepositoryConfig" {
                        flow.RepositoryConfig()
                    }
                    case "NoPatch" {
                        flow.NoPatch()
                    }
                    default {
                        throw Exception("Unknown test: " + name)
                    }
                }
                Console.WriteLine("PASS " + name)
            }
        }
    }
}
