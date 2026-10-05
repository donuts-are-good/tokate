package TokateTests

import Gsharp.Concurrency
import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Net
import System.Net.Sockets
import System.Text.Json.Nodes

internal open class NativeFixture : IDisposable {
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
        Temp.Env["GH_TOKEN"] = "fixture-donor"
        Temp.Env["GITHUB_TOKEN"] = "fixture-secondary"
        Temp.Env["OPENAI_API_KEY"] = "synthetic-unrelated-secret"
        Temp.Env["UNRELATED_DONOR_VALUE"] = "synthetic-unrelated-secret"
        Temp.Env["GIT_CONFIG_COUNT"] = "1"
        Temp.Env["GIT_CONFIG_KEY_0"] = "core.hooksPath"
        Temp.Env["GIT_CONFIG_VALUE_0"] = "synthetic-untrusted-hooks"
        Temp.Env["CODEX_HOME"] = Path.Combine(Temp.Root, "codex-home")
        Temp.Env["GH_CONFIG_DIR"] = Path.Combine(Temp.Root, "gh-home")
        Temp.Env["XDG_CONFIG_HOME"] = Path.Combine(Temp.Root, "config-home")
        Temp.Env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/synthetic/keyring-bus"
        Temp.Env["XDG_RUNTIME_DIR"] = Path.Combine(Temp.Root, "runtime")
        Directory.CreateDirectory(Temp.Env["CODEX_HOME"])
        Directory.CreateDirectory(Temp.Env["GH_CONFIG_DIR"])
        File.WriteAllText(Path.Combine(Temp.Env["CODEX_HOME"], "identity"), "ChatGPT synthetic login")
        Save()
    }

    internal func Initialize() {
        Git("init", "-b", "main", Upstream)
        Call([]string{"init", "--path", Upstream})
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        Check.That(Check.Text(policy["max_seconds"]) == "3600", "New policy budget must be 3600 seconds")
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

    internal func Git(args ...string) string {
        let env = Dictionary[string, string](Temp.Env)
        for key in[]string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"} {
            env.Remove(key)
        }
        return Check.Success(TestProcess.Run("/usr/bin/git", args, env))
    }

    internal func Commit(message string) {
        Git("-C", Upstream, "add", ".")
        Git("-C", Upstream, "-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "-m", message)
    }

    internal func Call(args[]string, code int32 = 0, owner bool = false, traffic bool = false) Result {
        let env = Dictionary[string, string](Temp.Env)
        if env.ContainsKey("GH_TOKEN") {
            env["GH_TOKEN"] = owner ? "fixture-owner": "fixture-donor"
        }
        File.WriteAllText(Path.Combine(Temp.Env["GH_CONFIG_DIR"], "identity"), owner ? "owner": "donor")
        let all = List[string](args)
        if traffic {
            all.Add("--traffic")
        }
        let result = TestProcess.Run(Binary, all.ToArray(), env)
        Check.That(
            result.Code == code,
            "Expected exit " + code.ToString() + ", got " + result.Code.ToString() + "\n" + result.Output + result.Error
        )
        return result
    }

    internal func Approve(baseBranch string = "") {
        let args = List[string]{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"}
        if baseBranch != "" {
            args.AddRange([]string{"--base-branch", baseBranch})
        }
        Call(args.ToArray(), owner: true)
    }

    internal func CommitIdentity(folder string, sha string, name string, email string) {
        let identity = Git("-C", folder, "show", "-s", "--format=%an%n%ae%n%cn%n%ce", sha).Split('\n')
        Check.That(identity.Length == 4, "Missing commit attribution")
        Check.That(identity[0] == name && identity[2] == name, "Unexpected author or committer name")
        Check.That(identity[1] == email && identity[3] == email, "Unexpected author or committer email")
    }

    internal func AutomationAttribution() {
        Reload()
        for commit in State["api_commits"]?.AsArray() ?? JsonArray() {
            for field in[]string{"author", "committer"} {
                let identity = commit["request"]?[field] ?? throw Exception("Missing explicit " + field)
                Check.That(identity.AsObject().Count == 2 && identity["date"] == nil, "API must supply timestamps")
            }
            CommitIdentity(Upstream, Check.Text(commit["sha"]), "Tokate", "tokate@users.noreply.github.com")
        }
    }

    internal func ProtectedPolicy(empty bool = false) {
        Directory.CreateDirectory(Path.Combine(Upstream, "scripts/checks"))
        File.WriteAllText(Path.Combine(Upstream, "scripts/verify.sh"), "test -f result.txt\n")
        File.WriteAllText(Path.Combine(Upstream, "scripts/checks/original"), "original\n")
        File.WriteAllText(Path.Combine(Upstream, "ordinary-source"), "ordinary\n")
        File.WriteAllText(Path.Combine(Upstream, "é-🛠"), "unicode\n")
        File.WriteAllText(Path.Combine(Upstream, "e\u0301-quoted\"\n "), "raw name\n")
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        policy["verification"] = Check.Json("[[\"/bin/sh\",\"scripts/verify.sh\"]]")
        policy["protected_paths"] = Check.Json(empty ? "[]": "[\"scripts/verify.sh\",\"scripts/checks/\"]")
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Explicit protected paths fixture")
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
    }

    internal func MetadataOnly() {
        File.WriteAllText(Path.Combine(Bin, "git"), "#!/bin/sh\necho unexpected-local-git >&2\nexit 91\n")
        File.SetUnixFileMode(
            Path.Combine(Bin, "git"),
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        )
    }

    internal func Claim(
        seconds string = "30",
        model string = "gpt-6.1-sol",
        code int32 = 0,
        network bool = false,
        effort string = "high",
        reserve string = ""
    ) string {
        let result = Call(ClaimArgs(seconds, model, effort, reserve, network), code)
        let index = result.Output.LastIndexOf("Run: ")
        return index < 0 ? "": result.Output.Substring(index + 5).Trim()
    }

    internal func ClaimArgs(
        seconds string? = "30",
        model string = "gpt-6.1-sol",
        effort string = "high",
        reserve string = "",
        network bool = false,
        fork string = "",
        json bool = false
    )[]string {
        let args = List[string]{"claim", "--repo", "owner/project", "--issue", "1"}
        if fork != "" {
            args.AddRange([]string{"--fork", fork})
        }
        args.AddRange([]string{"--model", model, "--effort", effort})
        if let budget = seconds {
            args.AddRange([]string{"--seconds", budget})
        }
        args.AddRange([]string{"--runs", Path.Combine(Temp.Root, "runs")})
        if reserve != "" {
            args.AddRange([]string{"--verification-reserve", reserve})
        }
        if network {
            args.Add("--allow-network")
        }
        if json {
            args.Add("--json")
        }
        return args.ToArray()
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

    internal func Reject(args[]string, reason string, owner bool = false) {
        Check.Contains(Call(args, 1, owner).Error, reason)
        NoInference()
        NoPr()
    }

    internal func SetModelPolicy(mode string, models string = "") {
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let original = File.ReadAllText(path)
        let policy = Check.Json(original)
        if mode == "" {
            policy.AsObject().Remove("model_policy")
        } else {
            policy["model_policy"] = JsonValue.Create(mode)
        }
        if models == "omit" {
            policy.AsObject().Remove("models")
        } else if models != "" {
            policy["models"] = Check.Json(models)
        }
        if policy.ToJsonString() != original {
            File.WriteAllText(path, policy.ToJsonString())
            Commit("Owner selects model policy")
        }
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
    }

    internal func ResetTraffic() {
        Reload()
        State["api_calls"] = JsonArray()
        Save()
    }

    internal func Traffic(
        readBudget int32,
        mutationBudget int32,
        conditionalBudget int32,
        retries int32,
        result Result? = nil
    ) {
        Reload()
        let calls = State["api_calls"]?.AsArray() ?? throw Exception("Missing traffic evidence")
        var reads int32
        var mutations int32
        var conditional int32
        var last int64
        for call in calls {
            if Check.Text(call["method"]) == "GET" {
                reads++
            } else {
                mutations++
                let start = Int64.Parse(Check.Text(call["start"]))
                if last != 0 {
                    Check.That(
                        Convert.ToDouble(start - last) / Convert.ToDouble(Stopwatch.Frequency) >= 1.0,
                        "Mutation starts were not paced"
                    )
                }
                last = start
            }
            if Check.Text(call["status"]) == "304" {
                conditional++
            }
        }
        Check.That(
            reads == readBudget && mutations == mutationBudget && conditional == conditionalBudget,
            "Traffic regression: " + reads.ToString() + " reads, " + mutations.ToString() +
                " mutations, " +
                conditional.ToString() + " conditional responses"
        )
        if result != nil {
            let prefix = "Tokate API traffic: "
            let index = result.Error.IndexOf(prefix, StringComparison.Ordinal)
            Check.That(index >= 0, "Missing opt-in diagnostics")
            let line = result.Error.Substring(index + prefix.Length).Split('\n')[0]
            let counts = Check.Json(line)
            let observedReads = Check.Text(counts["reads"])
            let observedMutations = Check.Text(counts["mutations"])
            let observedConditional = Check.Text(counts["conditional_responses"])
            let observedRetries = Check.Text(counts["retry_attempts"])
            Check.That(
                observedReads == reads.ToString() && observedMutations == mutations.ToString() &&
                    observedConditional == conditional.ToString() && observedRetries == retries.ToString(),
                "Diagnostics disagreed with fixture observations"
            )
            Check.Contains(result.Error, "exclude unseen GitHub CLI/Git requests and workflow executions")
            for secret in[]string{
                "synthetic-response-secret",
                "fixture-owner",
                "fixture-donor",
                Temp.Root,
                "If-None-Match",
                "Acceptance criteria"
            } {
                let output = secret == Temp.Root ? line: result.Error
                Check.That(!output.Contains(secret), "Diagnostics exposed private data")
            }
        }
        Console.WriteLine(
            "Traffic budget: reads=" + reads.ToString() + " mutations=" + mutations.ToString() +
                " conditional_responses=" +
                conditional.ToString() + " retry_attempts=" + retries.ToString()
        )
    }

    internal func ETags(mode string) {
        Reload()
        State["etag_initial_prefix"] = JsonValue.Create(mode == "weak" || mode == "weak-to-strong" ? "W/": "")
        State["etag_returned_prefix"] = JsonValue.Create(mode == "weak" || mode == "strong-to-weak" ? "W/": "")
        State["etag_initial"] = nil
        State["etag_returned"] = mode == "missing" ? JsonValue.Create(""): nil
        State["etag_force_304"] = JsonValue.Create(false)
        Save()
    }

    internal func ApproveSelf() -> Call(
        []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "owner"},
        owner: true
    )

    internal func SameRepositoryClaim(code int32 = 0) Result -> Call(
        ClaimArgs(fork: "owner/project"),
        code,
        owner: true,
        traffic: true
    )

    internal func Faults(path string, faults JsonNode) {
        Reload()
        State["fault_path"] = JsonValue.Create(path)
        State["faults"] = faults
        State["fault_index"] = JsonValue.Create(0)
        Save()
        ResetTraffic()
    }

    internal func DiffFault(key string, value string) {
        Reload()
        State[key] = JsonValue.Create(value)
        Save()
    }

    internal func VerificationPolicy(script string, network bool = false, second string = "") {
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        let commands = JsonArray()
        for check in[]string{script, second} {
            if check != "" {
                let command = JsonArray()
                for word in[]string{"/bin/bash", "-c", check} {
                    command.Add(JsonValue.Create(word) as JsonNode)
                }
                commands.Add(command as JsonNode)
            }
        }
        policy["verification"] = commands
        policy["allow_network"] = JsonValue.Create(network)
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Verify real independent boundary")
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
    }
}
