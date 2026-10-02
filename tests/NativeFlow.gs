package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Net
import System.Net.Sockets
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
        return Check.Success(Check.Run("/usr/bin/git", args, env))
    }

    internal func Commit(message string) {
        Git("-C", Upstream, "add", ".")
        Git("-C", Upstream, "-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "-m", message)
    }

    internal func Call(args[]string, code int32 = 0, owner bool = false) Result {
        let env = Dictionary[string, string](Temp.Env)
        if env.ContainsKey("GH_TOKEN") {
            env["GH_TOKEN"] = owner ? "fixture-owner": "fixture-donor"
        }
        File.WriteAllText(Path.Combine(Temp.Env["GH_CONFIG_DIR"], "identity"), owner ? "owner": "donor")
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

    internal func Claim(
        seconds string = "30",
        model string = "gpt-6.1-sol",
        code int32 = 0,
        network bool = false
    ) string {
        let args = List[string]{
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
        }
        if network {
            args.Add("--allow-network")
        }
        let result = Call(args.ToArray(), code)
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
        for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
            Check.Contains(help.Error, name + ": missing")
        }
        Check.That(!(help.Output + help.Error).Contains('\u001b'), "Redirected output contains ANSI")
        let doctor = Call([]string{"doctor"}, 1)
        Check.Contains(doctor.Output, "sandbox: skipped")
        for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
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

    internal func DoctorToolchain() {
        let env = Dictionary[string, string](Temp.Env)
        let global = Path.Combine(Upstream, "global.json")
        File.Copy(Path.Combine(Directory.GetCurrentDirectory(), "global.json"), global)
        let ready = Check.Run(Binary, []string{"doctor"}, env, cwd: Upstream)
        Check.Success(ready)
        Check.Contains(ready.Output, "Repository global.json SDK/MSBuild starts inside the sandbox")
        File.WriteAllText(global, "{\"sdk\":{\"version\":\"99.0.100\",\"rollForward\":\"disable\"}}")
        let missing = Check.Run(Binary, []string{"doctor"}, env, cwd: Upstream)
        Check.That(missing.Code == 1, "Doctor accepted unavailable pinned SDK")
        Check.Contains(missing.Output, "sandbox: failed")
        Check.Contains(missing.Output, "99.0.100")
        Check.Contains(missing.Output, "standard system path")
        File.Delete(global)
        let unpinned = Check.Run(Binary, []string{"doctor"}, env, cwd: Upstream)
        Check.Success(unpinned)
        Check.Contains(unpinned.Output, "sandbox: ready")
        Check.That(!unpinned.Output.Contains("Repository global.json"), "Doctor claimed an absent SDK pin")
        let outside = Path.Combine(Temp.Root, "outside-global.json")
        File.Copy(Path.Combine(Directory.GetCurrentDirectory(), "global.json"), outside)
        File.CreateSymbolicLink(global, outside)
        for dangling in[]bool{false, true} {
            if dangling {
                File.Delete(outside)
            }
            let linked = Check.Run(Binary, []string{"doctor"}, env, cwd: Upstream)
            Check.That(linked.Code == 1, "Doctor accepted a linked SDK file")
            Check.Contains(linked.Output, "not a symbolic link")
        }
        File.Delete(global)
        NoInference()
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
        for seconds in[]string{"0", "3601", "86401"} {
            Claim(seconds: seconds, code: 1)
        }
        NoInference()
        let run = Claim(seconds: "1800")
        Call([]string{"work", "--run", run})
        Check.That(
            Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["seconds"]) == "1800",
            "Saved explicit budget changed"
        )
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

    internal func DefaultBudget(ownerSeconds int32 = 3600, expectedSeconds string = "3600") {
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        if Check.Text(policy["max_seconds"]) != ownerSeconds.ToString() {
            policy["max_seconds"] = JsonValue.Create(ownerSeconds)
            File.WriteAllText(path, policy.ToJsonString())
            Commit("Set budget " + ownerSeconds.ToString())
            Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
        }
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
            Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["seconds"]) == expectedSeconds,
            "Wrong default budget for owner limit " + ownerSeconds.ToString()
        )
        Call([]string{"work", "--run", run})
        Check.That(
            Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["seconds"]) == expectedSeconds,
            "Saved default budget changed"
        )
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

    internal func TemporaryIsolation() {
        let sentinel = Path.Combine("/tmp", Path.GetFileName(Temp.Root) + "-sentinel")
        File.WriteAllText(sentinel, "synthetic host temporary data")
        try {
            let path = Path.Combine(Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["verification"] = Check.Json(
                "[[\"/bin/sh\",\"-c\",\"test -f result.txt && test ! -e " + sentinel + "\"]]"
            )
            File.WriteAllText(path, policy.ToJsonString())
            Commit("Verify fresh temporary namespace")
            Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
            Approve()
            let run = Claim()
            Mode("temporary_isolation")
            State["temporary_sentinel"] = JsonValue.Create(sentinel)
            Save()
            Call([]string{"work", "--run", run})
            Check.That(File.ReadAllText(sentinel) == "synthetic host temporary data", "Host temporary data changed")
        } finally {
            File.Delete(sentinel)
        }
    }

    internal func TemporaryHomeRejected() {
        let home = Path.Combine("/tmp", Path.GetFileName(Temp.Root) + "-home")
        Directory.CreateDirectory(home)
        try {
            Approve()
            let run = Claim()
            Temp.Env["HOME"] = home
            Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "must be outside /tmp")
            NoInference()
            NoPr()
        } finally {
            Directory.Delete(home, true)
        }
    }

    internal func PublicContent(run string) {
        Reload()
        let saved = Check.Json(File.ReadAllText(Path.Combine(run, "publication.json")))
        let body = File.ReadAllText(Path.Combine(run, "pr-body.md"))
        Check.That(Check.Text(saved["body"]) == body, "Saved publication body differs")
        Check.Contains(body, "Independent owner verification: 1/1 checks passed")
        Check.Contains(body, "input_tokens")
        for value in[]string{
            "synthetic-raw",
            "synthetic-usage-secret",
            "synthetic-repository-secret",
            Temp.Root,
            "cached_input_tokens",
            "extra"
        } {
            Check.That(!saved.ToJsonString().Contains(value), "Local data reached publication: " + value)
        }
        if State["pulls"] != nil {
            Check.That(Check.Text(State["pulls"]?[0]?["body"]) == body, "PR differs from inspectable publication")
        }
        Check.Contains(File.ReadAllText(Path.Combine(run, "report.md")), "synthetic-raw-report-secret")
        Check.Contains(File.ReadAllText(Path.Combine(run, "events.jsonl")), "synthetic-raw-event-secret")
        Check.Contains(File.ReadAllText(Path.Combine(run, "stderr.log")), "synthetic-raw-stderr-secret")
    }

    internal func OutputBoundary() {
        File.WriteAllText(Path.Combine(Upstream, ".env"), "synthetic-repository-secret")
        File.WriteAllText(Path.Combine(Upstream, "ordinary.data"), "synthetic-repository-secret")
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        policy["verification"] = Check.Json(
            "[[\"/bin/sh\",\"-c\",\"test -f result.txt && test -z \\\"$$GH_TOKEN$$CODEX_HOME$$UNRELATED_DONOR_VALUE$$OPENAI_API_KEY\\\" && printf synthetic-raw-verification-secret && printf synthetic-raw-verification-error >&2\"]]"
        )
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Synthetic repository/output boundary")
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
        Approve()
        let run = Claim()
        Mode("output_boundary")
        Call([]string{"work", "--run", run})
        PublicContent(run)
        let verification = File.ReadAllText(Path.Combine(run, "verification.json"))
        Check.Contains(verification, "synthetic-raw-verification-secret")
        Check.Contains(verification, "synthetic-raw-verification-error")
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
    }

    internal func ToolAuthentication() {
        Temp.Env.Remove("GH_TOKEN")
        Temp.Env.Remove("GITHUB_TOKEN")
        State["stored_login"] = JsonValue.Create(true)
        Save()
        Approve()
        let run = Claim()
        Call([]string{"work", "--run", run})
        Reload()
        Check.That(Check.Text(State["helper_used"]) == "true", "Git did not use GitHub CLI authentication")
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
    }

    internal func PublicationFailures() {
        for mode in[]string{"push_fail", "pr_fail", "pr_fail_after_create"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode(mode)
            flow.Call([]string{"work", "--run", run}, 1)
            let failed = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(Check.Text(failed["state"]) == "generated", "Publication failure discarded generated work")
            flow.PublicContent(run)
            if mode != "pr_fail_after_create" {
                flow.NoPr()
            }
            flow.Mode("")
            flow.Call([]string{"publish", "--run", run})
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Publication retry ran inference")
            Check.That(flow.State["pulls"]?.AsArray().Count == 1, "Retry duplicated PR")
            let published = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(published["commit"]) == Check.Text(failed["commit"]),
                "Publication retry changed commit"
            )
            flow.PublicContent(run)
        }
    }

    internal func PublicationRevocation() {
        Approve()
        let run = Claim()
        Mode("revoke_after_push")
        Call([]string{"work", "--run", run}, 1)
        NoPr()
        PublicContent(run)
        Call([]string{"publish", "--run", run}, 1)
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Revocation ran extra inference")
    }

    internal func BackgroundCleanup() {
        Approve()
        let run = Claim()
        Mode("background")
        Call([]string{"work", "--run", run})
        let pid = File.ReadAllText(Path.Combine(Bin, "child.pid"))
        let status = "/proc/" + pid + "/stat"
        Check.That(
            !File.Exists(status) || File.ReadAllText(status).Split(' ')[2] == "Z",
            "Descendant survived normal completion"
        )
    }

    internal func UnsupportedSandbox() {
        Approve()
        let run = Claim()
        Mode("unsupported_sandbox")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "Sandbox preflight failed")
        NoInference()
        NoPr()
    }

    internal func VerificationPolicy(script string, network bool = false) {
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        let command = JsonArray()
        for word in[]string{"/bin/bash", "-c", script} {
            command.Add(JsonValue.Create(word) as JsonNode)
        }
        let commands = JsonArray()
        commands.Add(command as JsonNode)
        policy["verification"] = commands
        policy["allow_network"] = JsonValue.Create(network)
        File.WriteAllText(path, policy.ToJsonString())
        Commit("Verify real independent boundary")
        Git("-C", Path.Combine(Bin, "fork"), "fetch", Upstream, "main")
    }

    internal func VerificationBoundary() {
        let temporary = Path.Combine("/tmp", Path.GetFileName(Temp.Root) + "-private")
        let persistent = Path.Combine(Temp.Root, "private")
        File.WriteAllText(temporary, "synthetic host tmp credential")
        File.WriteAllText(persistent, "synthetic sibling contribution")
        let socketPath = Path.Combine(Temp.Root, "private.socket")
        using let socket = Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        socket.Bind(UnixDomainSocketEndPoint(socketPath))
        socket.Listen(1)
        try {
            let script = "set -eu\ntest -f result.txt\n" +
                "test \"$$PATH\" = /usr/local/bin:/usr/bin:/bin\n" +
                "test \"$$HOME\" = \"$$PWD/.tokate-scratch\" && test \"$$TMPDIR\" = \"$$HOME\"\n" +
                "test -z \"$${GH_TOKEN-}$${GITHUB_TOKEN-}$${CODEX_HOME-}$${GH_CONFIG_DIR-}$${OPENAI_API_KEY-}$${UNRELATED_DONOR_VALUE-}$${DBUS_SESSION_BUS_ADDRESS-}$${XDG_RUNTIME_DIR-}$${GIT_CONFIG_COUNT-}\"\n" +
                "for file in " +
                temporary +
                " " +
                persistent +
                " " +
                socketPath +
                " " +
                Temp.Env["HOME"] +
                " " +
                Temp.Env["CODEX_HOME"] +
                " " +
                Temp.Env["GH_CONFIG_DIR"] +
                " " +
                Bin +
                " ../run.json ../.lock ../events.jsonl ../stderr.log ../report.md /etc/passwd /etc/shadow /run /sys; do test ! -e \"$$file\"; done\n" +
                "test ! -r outside-link\n" +
                "test -z \"$$(tr '\\0' '\\n' < /proc/1/environ | /usr/bin/grep -E 'synthetic|tokate-e2e|CODEX_HOME|GH_TOKEN' || true)\"\n" +
                "test \"$$(awk '/CapEff:/{print $$2}' /proc/self/status)\" = 0000000000000000\n" +
                "for ns in pid user ipc uts mnt net; do test \"$$(readlink /proc/self/ns/$$ns)\" != \"$$(cat expected-$$ns-namespace)\"; done\n" +
                "test -r .git/config && git status --porcelain | /usr/bin/grep result.txt\n" +
                "if printf tampered >> .git/config; then exit 1; fi\n" +
                "if rm .git/config; then exit 1; fi\n" +
                "if mv .git .git-moved; then exit 1; fi\n" +
                "if touch /usr/tokate-verification-write; then exit 1; fi\n" +
                "touch /tmp/private /var/tmp/private \"$$TMPDIR/private\"\n" +
                "bwrap --unshare-user --unshare-pid --ro-bind / / --tmpfs /tmp -- /bin/sh -c 'touch /tmp/nested-probe'\n" +
                "printf verified-independent-boundary\n"
            VerificationPolicy(script)
            Approve()
            let run = Claim()
            Mode("verification_boundary")
            Call([]string{"work", "--run", run})
            Check.Contains(File.ReadAllText(Path.Combine(run, "verification.json")), "verified-independent-boundary")
            Check.That(File.ReadAllText(temporary) == "synthetic host tmp credential", "Host tmp changed")
            Check.That(File.ReadAllText(persistent) == "synthetic sibling contribution", "Sibling contribution changed")
            Check.That(
                (File.GetUnixFileMode(Path.Combine(Bin, "codex-impl")) & UnixFileMode.UserExecute) == 0,
                "Fixture harness was not disabled"
            )
        } finally {
            File.Delete(temporary)
        }
    }

    internal func VerificationNetwork() {
        let listener = TcpListener(IPAddress.Loopback, 0)
        listener.Start()
        try {
            let port = (listener.LocalEndpoint as IPEndPoint)?.Port.ToString() ?? throw Exception("No listener port")
            for mode in[]string{"owner-denied", "donor-denied", "allowed"} {
                using let flow = NativeFlow(Binary)
                flow.Initialize()
                let connect = "exec 3<>/dev/tcp/127.0.0.1/" + port
                let script = mode == "allowed" ? connect: "if " + connect + "; then exit 1; fi"
                flow.VerificationPolicy(script, mode != "owner-denied")
                flow.Approve()
                if mode == "owner-denied" {
                    flow.Claim(code: 1, network: true)
                    flow.NoInference()
                }
                let run = flow.Claim(network: mode == "allowed")
                flow.Call([]string{"work", "--run", run})
                Check.That(listener.Pending() == (mode == "allowed"), "Unexpected verification network access: " + mode)
                if listener.Pending() {
                    using let client = listener.AcceptTcpClient()
                }
            }
        } finally {
            listener.Stop()
        }
    }

    shared {
        internal func All(binary string) {
            for name in[]string{
                "HelpAndArguments",
                "MissingTools",
                "DoctorToolchain",
                "OwnerWithoutCodex",
                "CrossAccountFlow",
                "OwnerPolicy",
                "FailedReassignment",
                "MissingFork",
                "DefaultBudget",
                "HigherOwnerBudget",
                "LowerOwnerBudget",
                "IssueEdit",
                "Revocation",
                "Timeout",
                "Reapproval",
                "FalseSuccess",
                "PolicyEdit",
                "WorkflowEdit",
                "RepositoryConfig",
                "NoPatch",
                "TemporaryIsolation",
                "TemporaryHomeRejected",
                "OutputBoundary",
                "ToolAuthentication",
                "PublicationFailures",
                "PublicationRevocation",
                "BackgroundCleanup",
                "UnsupportedSandbox",
                "VerificationBoundary",
                "VerificationNetwork"
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
                    case "DoctorToolchain" {
                        flow.DoctorToolchain()
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
                    case "HigherOwnerBudget" {
                        flow.DefaultBudget(7200)
                    }
                    case "LowerOwnerBudget" {
                        flow.DefaultBudget(30, "30")
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
                    case "TemporaryIsolation" {
                        flow.TemporaryIsolation()
                    }
                    case "TemporaryHomeRejected" {
                        flow.TemporaryHomeRejected()
                    }
                    case "OutputBoundary" {
                        flow.OutputBoundary()
                    }
                    case "ToolAuthentication" {
                        flow.ToolAuthentication()
                    }
                    case "PublicationFailures" {
                        flow.PublicationFailures()
                    }
                    case "PublicationRevocation" {
                        flow.PublicationRevocation()
                    }
                    case "BackgroundCleanup" {
                        flow.BackgroundCleanup()
                    }
                    case "UnsupportedSandbox" {
                        flow.UnsupportedSandbox()
                    }
                    case "VerificationBoundary" {
                        flow.VerificationBoundary()
                    }
                    case "VerificationNetwork" {
                        flow.VerificationNetwork()
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
