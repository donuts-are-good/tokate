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
import Tokate

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
        let result = Check.Run(Binary, all.ToArray(), env)
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

    internal func Claim(
        seconds string = "30",
        model string = "gpt-6.1-sol",
        code int32 = 0,
        network bool = false,
        effort string = "high",
        reserve string = ""
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
            effort,
            "--seconds",
            seconds,
            "--runs",
            Path.Combine(Temp.Root, "runs")
        }
        if reserve != "" {
            args.AddRange([]string{"--verification-reserve", reserve})
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
        Check.That(help.Error == "", "Help emitted prerequisite warnings")
        Check.That(!(help.Output + help.Error).Contains('\u001b'), "Redirected output contains ANSI")
        let doctor = Call([]string{"doctor"}, 1)
        Check.Contains(doctor.Output, "sandbox: skipped")
        for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
            Check.Contains(doctor.Output, name + ": missing")
        }
        let work = Call(
            []string{"work", "--repo", "owner/project", "--issue", "1", "--model", "model", "--effort", "high"},
            1
        )
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
            Call(
                []string{"work", "--repo", "owner/project", "--issue", "1", "--model", "model", "--effort", "high"},
                1
            ).Error,
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

    internal func StructuredContract() {
        let approval = Call(
            []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor", "--json"},
            owner: true
        )
        CliDiscovery.Envelope(approval, "approve", "ok")
        let policy = Call([]string{"policy", "--repo", "owner/project", "--json"})
        let value = CliDiscovery.Envelope(policy, "policy", "ok")
        Check.That(Check.Text(value["data"]?["policy"]?["version"]) == "1", "Missing projected policy")
        let legacy = Check.Json(Call([]string{"policy", "--repo", "owner/project"}).Output)
        Check.That(
            legacy["schema_version"] == nil && Check.Text(legacy["version"]) == "1",
            "Legacy piped policy changed"
        )
        let claim = CliDiscovery.Envelope(
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
                    "high",
                    "--seconds",
                    "30",
                    "--runs",
                    Path.Combine(Temp.Root, "runs"),
                    "--json"
                }
            ),
            "claim",
            "ok"
        )
        let run = Check.Text(claim["data"]?["run"])
        Check.That(Path.IsPathFullyQualified(run), "Claim omitted executable run path")
        NoInference()
        let work = Call([]string{"work", "--run", run, "--json", "--traffic"})
        CliDiscovery.Envelope(work, "work", "ok")
        Check.Contains(work.Error, "Running gpt-6.1-sol")
        Check.Contains(work.Error, "Tokate API traffic:")
        Check.That(
            !work.Output.Contains("synthetic-raw") && !work.Output.Contains("synthetic-usage-secret"),
            "Inference output leaked"
        )
        CliDiscovery.Envelope(Call([]string{"publish", "--run", run, "--json"}), "publish", "ok")
        CliDiscovery.Envelope(
            Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10", "--json"}, owner: true),
            "verify-pr",
            "ok"
        )
        CliDiscovery.Envelope(Call([]string{"checks", "--run", run, "--json"}, 8), "checks", "pending")
        CliDiscovery.Envelope(
            Call([]string{"checks", "--run", run, "--watch", "--timeout", "1", "--json"}, 8),
            "checks",
            "pending"
        )
        for outcome in[]string{"fail", "pass"} {
            Reload()
            State["checks"] = Check.Json(
                "[{\"name\":\"verify\",\"bucket\":\"" + outcome + "\",\"output\":\"synthetic-check-log-marker\"}]"
            )
            Save()
            let result = Call(
                []string{"checks", "--repo", "owner/project", "--pr", "10", "--json"},
                outcome == "pass" ? 0: 1
            )
            let check = CliDiscovery.Envelope(
                result,
                "checks",
                outcome == "pass" ? "ok": "error",
                outcome == "pass" ? "": "verification_failed"
            )
            Check.That(check["data"]?["checks"]?.AsArray().Count == 1, "Missing check summary")
            Check.That(!result.Output.Contains("synthetic-check-log-marker"), "Raw check data leaked")
        }
        File.SetUnixFileMode(
            Path.Combine(Bin, "codex-impl"),
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        )
        CliDiscovery.Envelope(Call([]string{"work", "--run", run, "--json"}, 1), "work", "error", "invalid_state")
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "JSON or suggestions spent extra inference")
        Approve()
        Reload()
        let originalPulls = State["pulls"]?.ToJsonString() ?? ""
        CliDiscovery.Envelope(
            Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10", "--json"}, 1, owner: true),
            "verify-pr",
            "error",
            "stale_approval"
        )
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Receipt rejection spent inference")
        Check.That((State["pulls"]?.ToJsonString() ?? "") == originalPulls, "Receipt rejection changed the PR")
        Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
        CliDiscovery.Envelope(
            Call([]string{"publish", "--run", run, "--json"}, 1),
            "publish",
            "error",
            "stale_approval"
        )
    }

    internal func StructuredFailures() {
        for scenario in[]string{"authentication", "inference"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim(seconds: "1")
            if scenario == "authentication" {
                File.WriteAllText(Path.Combine(flow.Temp.Env["CODEX_HOME"], "identity"), "No active login")
                let failure = flow.Call([]string{"work", "--run", run, "--json"}, 1)
                let value = CliDiscovery.Envelope(failure, "work", "error", "authentication_required")
                Check.That(
                    Check.Text(value["next_actions"]?[0]?[0]) == "codex" && Check.Text(
                        value["next_actions"]?[0]?[1]
                    ) == "login",
                    "Missing complete authentication action"
                )
                flow.NoInference()
            } else {
                flow.Mode("timeout")
                let failure = flow.Call([]string{"work", "--run", run, "--json"}, 1)
                CliDiscovery.Envelope(failure, "work", "error", "inference_failed")
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Inference failure retried")
            }
            flow.NoPr()
        }
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
        CommitIdentity(
            Path.Combine(Bin, "fork"),
            Check.Text(State["pulls"]?[0]?["head"]?["sha"]),
            "donor",
            "123+donor@users.noreply.github.com"
        )
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

    internal func ModelPolicyModes() {
        for mode in[]string{"", "whitelist", "unrestricted", "unrestricted-empty"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            let unrestricted = mode.StartsWith("unrestricted")
            flow.SetModelPolicy(
                unrestricted ? "unrestricted": mode,
                unrestricted ? (mode.EndsWith("empty") ? "{}": "omit"):
                "{\"gpt-6.1-sol\":[\"high\"],\"gpt-6-sol\":[\"high\"]}"
            )
            flow.Approve()
            if !unrestricted {
                flow.Claim(model: "unlisted-model", code: 1)
                flow.Claim(model: "gpt-6-sol", effort: "xhigh", code: 1)
                flow.Claim(effort: "low", code: 1)
            }
            flow.Claim(seconds: "3601", code: 1)
            flow.Claim(network: true, code: 1)
            flow.Claim(effort: "unknown", code: 1)
            flow.Claim(effort: "absent", code: 1)
            flow.Claim(effort: "invalid", code: 1)
            flow.NoInference()
            let model = "gpt-6-sol"
            let run = flow.Claim(model: model, effort: "high")
            flow.Call([]string{"work", "--run", run})
            flow.Call([]string{"publish", "--run", run})
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            let saved = File.ReadAllText(Path.Combine(run, "run.json"))
            flow.Reload()
            Check.That(
                Check.Text(flow.State["requested_model"]) == model && Check.Text(
                    flow.State["requested_effort"]
                ) == "model_reasoning_effort=\"high\"",
                "Harness settings differ from explicit donor selection"
            )
            let pulls = flow.State["pulls"]?.ToJsonString() ?? ""
            let approval = flow.Git("-C", flow.Upstream, "rev-parse", "refs/heads/tokate/approvals/1")
            flow.SetModelPolicy(
                unrestricted ? "whitelist": "unrestricted",
                unrestricted ?
                "{\"gpt-6.1-sol\":[\"high\"]}": "omit"
            )
            Check.Contains(flow.Call([]string{"publish", "--run", run}, 1).Error, "policy or template changed")
            Check.Contains(
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, true).Error,
                "policy or template changed"
            )
            flow.Reload()
            Check.That(
                File.ReadAllText(Path.Combine(run, "run.json")) == saved &&
                    flow
                    .State["pulls"]
                    ?.ToJsonString() == pulls && flow.Git(
                    "-C",
                    flow.Upstream,
                    "rev-parse",
                    "refs/heads/tokate/approvals/1"
                ) == approval,
                "Model-policy edit rewrote saved authority or work"
            )
        }
    }

    internal func ModelPolicyMalformed() {
        let path = Path.Combine(Upstream, ".github/tokate.json")
        let original = File.ReadAllText(path)
        for version in[]int32{1, 2} {
            for fields in[]string{
                "\"model_policy\":null",
                "\"model_policy\":true",
                "\"model_policy\":1",
                "\"model_policy\":[]",
                "\"model_policy\":{}",
                "\"model_policy\":\"other\"",
                "\"model_policy\":\"whitelist\",\"model_policy\":\"unrestricted\"",
                "\"model_policy\":\"unrestricted\",\"model_policy\":\"unrestricted\"",
                "\"model_policy\":\"unrestricted\",\"models\":{\"model\":[\"high\"]}",
                "\"model_policy\":\"unrestricted\",\"models\":null",
                "\"model_policy\":\"unrestricted\",\"models\":[]",
                "\"model_policy\":\"unrestricted\",\"models\":\"bad\"",
                "\"model_policy\":\"unrestricted\",\"models\":{},\"models\":{}",
                "\"model_policy\":\"whitelist\"",
                "\"model_policy\":\"whitelist\",\"models\":{}",
                "\"model_policy\":\"whitelist\",\"models\":null",
                "\"model_policy\":\"whitelist\",\"models\":{\"bad model\":[\"high\"]}",
                "\"model_policy\":\"whitelist\",\"models\":{\"model\":[]}",
                "\"model_policy\":\"whitelist\",\"models\":{\"model\":\"high\"}",
                "\"model_policy\":\"whitelist\",\"models\":{\"model\":[null]}",
                "\"model_policy\":\"whitelist\",\"models\":{\"model\":[\"high,xhigh\"]}",
                "\"models\":{}",
                "\"models\":null",
                "\"models\":{\"model\":[\"absent\"]}"
            } {
                let policy = Check.Json(original)
                policy["version"] = JsonValue.Create(version)
                policy["allowed_tools"] = Check.Json("[{\"harness\":\"codex\",\"provider\":\"openai\"}]")
                policy.AsObject().Remove("models")
                let text = policy.ToJsonString()
                File.WriteAllText(path, text.Substring(0, text.Length - 1) + "," + fields + "}")
                Commit("Malformed model policy fixture")
                Call([]string{"policy", "--repo", "owner/project"}, 1)
                Check.That(File.ReadAllText(path).Contains(fields), "Policy inspection normalized owner bytes")
            }
        }
        NoInference()
        NoPr()
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
        for status in[]int32{0, 403} {
            let faults = JsonArray()
            for i in 0 ... 3 {
                faults.Add(Check.Map("status", status, "message", "Forbidden"))
            }
            Faults("repos/donor/project", faults)
            let failure = Call(
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
                1,
                traffic: true
            )
            Check.Contains(failure.Error, "GitHub read failed")
            Check.That(!failure.Error.Contains("Create a writable fork"), "Non-404 error was treated as missing")
            Traffic(status == 0 ? 11: 9, 0, 0, status == 0 ? 2: 0, failure)
            NoInference()
        }
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

    internal func ManagedCancellation() {
        Approve()
        let run = Claim(seconds: "30")
        Mode("timeout")
        File.Copy(Binary, Path.Combine(Temp.Root, "tokate-runner"))
        let info = ProcessStartInfo("/usr/bin/script")
        info.WorkingDirectory = Temp.Root
        info.UseShellExecute = false
        info.RedirectStandardInput = true
        info.RedirectStandardOutput = true
        info.RedirectStandardError = true
        info.Environment.Clear()
        for entry in Temp.Env {
            info.Environment[entry.Key] = entry.Value
        }
        for arg in[]string{
            "-q",
            "-e",
            "-c",
            "echo $$$$ > runner.pid; exec ./tokate-runner work --run '" + run + "'",
            "/dev/null"
        } {
            info.ArgumentList.Add(arg)
        }
        using let terminal = Process.Start(info) ?? throw Exception("Cannot start managed cancellation fixture")
        try {
            terminal.StandardInput.Close()
            let events = Path.Combine(run, "events.jsonl")
            var ready bool
            for i in 0 ... 1000 {
                if File.Exists(events) && File.ReadAllText(events).Contains("partial-secret") && File.Exists(
                    Path.Combine(run, "stderr.log")
                ) &&
                    File
                    .ReadAllText(Path.Combine(run, "stderr.log")).Contains("synthetic-partial-stderr-secret") {
                    ready = true
                    break
                }
                select {
                    case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                }
            }
            Check.That(ready, "Managed cancellation did not flush evidence")
            let pid = File.ReadAllText(Path.Combine(Temp.Root, "runner.pid")).Trim()
            Check.Success(Check.Run("/usr/bin/kill", []string{"-INT", pid}, Temp.Env))
            Check.That(terminal.WaitForExit(5000), "Managed cancellation did not finish cleanup")
            let output = terminal.StandardOutput.ReadToEnd() + terminal.StandardError.ReadToEnd()
            Check.That(terminal.ExitCode != 0, "Managed cancellation became success")
            Check.Contains(output, "cancelled")
            Check.That(!output.Contains("partial-secret"), "Raw managed cancellation output escaped")
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["state"]) == "failed" && Check.Text(
                    saved["failure_reason"]
                ) == "inference_interrupted",
                "Managed cancellation lost terminal reason"
            )
            Check.That(
                saved["inference_exit_code"] == nil && saved["usage"] == nil,
                "Managed cancellation fabricated completion"
            )
            Check.That(
                File.ReadAllText(Path.Combine(run, "checkout/partial.txt")) == "partial-edit",
                "Cancelled edit lost"
            )
            let child = File.ReadAllText(Path.Combine(Bin, "child.pid"))
            let status = "/proc/" + child + "/stat"
            Check.That(
                !File.Exists(status) || File.ReadAllText(status).Split(' ')[2] == "Z",
                "Managed descendant survived cancellation"
            )
            Call([]string{"work", "--run", run}, 1)
            Reload()
            Check.That(Check.Text(State["exec_count"]) == "1", "Managed cancellation retried inference")
            NoPr()
        } finally {
            if !terminal.HasExited {
                terminal.Kill(true)
                terminal.WaitForExit()
            }
        }
    }

    internal func Timeout() {
        Approve()
        let run = Claim(seconds: "1")
        Mode("timeout")
        let failure = Call([]string{"work", "--run", run}, 1)
        Check.That(!(failure.Output + failure.Error).Contains("partial-secret"), "Raw output escaped timeout")
        Check.Contains(File.ReadAllText(Path.Combine(run, "events.jsonl")), "partial-secret")
        Check.Contains(File.ReadAllText(Path.Combine(run, "stderr.log")), "synthetic-partial-stderr-secret")
        Check.That(
            File.ReadAllText(Path.Combine(run, "checkout/partial.txt")) == "partial-edit",
            "Interrupted edit lost"
        )
        let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Check.That(
            saved["turn_completed"] == nil && saved["usage"] == nil && saved["inference_exit_code"] == nil,
            "Partial JSONL became completed inference"
        )
        Check.That(Check.Text(saved["failure_reason"]) == "inference_interrupted", "Wrong inference failure reason")
        NoPr()
        Call([]string{"recover", "--run", run, "--seconds", "1"}, 1)
        Call([]string{"publish", "--run", run}, 1)
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
        Check.Contains(Call([]string{"recover", "--run", run}, 1).Error, "Owner verification failed")
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Failed recovery spent inference")
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
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "protected owner configuration")
        NoPr()
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

    internal func ProtectedEntrypoint() {
        ProtectedPolicy()
        Approve()
        let run = Claim()
        Mode("protected_entrypoint")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "protected owner path")
        Check.That(File.ReadAllText(Path.Combine(run, "checkout/scripts/verify.sh")) == "exit 0\n", "Donor work lost")
        Check.Contains(File.ReadAllText(Path.Combine(run, "candidate.patch")), "+exit 0")
        Check.That(!File.Exists(Path.Combine(run, "verification.json")), "Replaced verifier executed")
        NoPr()
    }

    internal func ProtectedRecovery() {
        ProtectedPolicy()
        Approve()
        let run = Claim()
        Mode("verification_fail")
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "Owner verification failed")
        let evidence = File.ReadAllText(Path.Combine(run, "verification.json"))
        File.WriteAllText(Path.Combine(run, "checkout/scripts/verify.sh"), "exit 0\n")
        Check.Contains(Call([]string{"recover", "--run", run}, 1).Error, "protected owner path")
        Check.That(
            File.ReadAllText(Path.Combine(run, "verification.json")) == evidence,
            "Recovery lost failed check evidence"
        )
        let archives = Directory.GetDirectories(run, "recovery-*")
        Check.That(archives.Length == 1, "Recovery failure was not archived")
        Check.That(
            File.ReadAllText(Path.Combine(archives[0], "verification.json")) == evidence,
            "Archive lost failure evidence"
        )
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Recovery reran inference")
        NoPr()
    }

    internal func EmptyProtectedPaths() {
        ProtectedPolicy(true)
        Approve()
        let run = Claim()
        Mode("protected_entrypoint")
        Call([]string{"work", "--run", run})
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
    }

    internal func ProtectedPolicyFreshness() {
        Approve()
        let run = Claim()
        let saved = File.ReadAllText(Path.Combine(run, "run.json"))
        ProtectedPolicy()
        Check.Contains(Call([]string{"work", "--run", run}, 1).Error, "policy or template changed")
        Check.That(File.ReadAllText(Path.Combine(run, "run.json")) == saved, "Old approval was reinterpreted")
        NoInference()
        NoPr()
    }

    internal func ProtectedPublication() {
        for committed in[]bool{false, true} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.ProtectedPolicy()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("protected_entrypoint")
            flow.Call([]string{"work", "--run", run}, 1)
            let checkout = Path.Combine(run, "checkout")
            let path = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            saved["state"] = JsonValue.Create("generated")
            saved["verification"] = Check.Json("[{\"command\":[\"/bin/sh\",\"scripts/verify.sh\"],\"exit_code\":0}]")
            File.WriteAllText(
                Path.Combine(run, "changes.patch"),
                flow.Git("-C", checkout, "diff", "--cached", "--binary", Check.Text(saved["base"])) + "\n"
            )
            if committed {
                flow.Git(
                    "-C",
                    checkout,
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "commit",
                    "-m",
                    "Claimed success"
                )
                saved["commit"] = JsonValue.Create(flow.Git("-C", checkout, "rev-parse", "HEAD"))
            }
            File.WriteAllText(path, saved.ToJsonString())
            Check.Contains(flow.Call([]string{"publish", "--run", run}, 1).Error, "protected owner path")
            Check.That(
                flow.Git(
                    "-C",
                    Path.Combine(flow.Bin, "fork"),
                    "rev-parse",
                    "refs/heads/" + Check.Text(saved["branch"])
                ) == Check.Text(saved["base"]),
                "Protected head was pushed"
            )
            flow.NoPr()
        }
    }

    internal func DiffFault(key string, value string) {
        Reload()
        State[key] = JsonValue.Create(value)
        Save()
    }

    internal func MetadataOnly() {
        File.WriteAllText(Path.Combine(Bin, "git"), "#!/bin/sh\necho unexpected-local-git >&2\nexit 91\n")
        File.SetUnixFileMode(
            Path.Combine(Bin, "git"),
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        )
    }

    internal func ReceiptEvidence() {
        ProtectedPolicy()
        Approve()
        let run = Claim()
        Call([]string{"work", "--run", run})
        MetadataOnly()
        for fault in[]string{
            "missing-files",
            "truncated-files",
            "wrong-base",
            "wrong-head",
            "missing-previous",
            "missing-status",
            "missing-commits"
        } {
            DiffFault("diff_fault", fault)
            Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        }
        DiffFault("diff_fault", "")
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        let checkout = Path.Combine(run, "checkout")
        let previous = Git("-C", checkout, "rev-parse", "HEAD")
        for i in 0 ... 250 {
            Git(
                "-C",
                checkout,
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "--allow-empty",
                "--quiet",
                "-m",
                "History " + i.ToString()
            )
        }
        let old = Git("-C", checkout, "rev-parse", "HEAD")
        let historyRun = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Git("-C", checkout, "push", Path.Combine(Bin, "fork"), "HEAD:refs/heads/" + Check.Text(historyRun["branch"]))
        Reload()
        let historyPull = State["pulls"]?[0] ?? throw Exception("Missing pull")
        let historyHead = historyPull["head"] ?? throw Exception("Missing head")
        historyHead["sha"] = JsonValue.Create(old)
        historyPull["body"] = JsonValue.Create(
            Check.Text(historyPull["body"]).Replace(previous, old, StringComparison.Ordinal)
        )
        Save()
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        let marker = Path.Combine(checkout, "receipt-code-ran")
        File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "touch '" + marker + "'\nexit 0\n")
        Git("-C", checkout, "add", "-A")
        Git(
            "-C",
            checkout,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "Forged success"
        )
        let head = Git("-C", checkout, "rev-parse", "HEAD")
        let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Git("-C", checkout, "push", Path.Combine(Bin, "fork"), "HEAD:refs/heads/" + Check.Text(saved["branch"]))
        Reload()
        let pull = State["pulls"]?[0] ?? throw Exception("Missing pull")
        let prHead = pull["head"] ?? throw Exception("Missing head")
        prHead["sha"] = JsonValue.Create(head)
        pull["body"] = JsonValue.Create(Check.Text(pull["body"]).Replace(old, head, StringComparison.Ordinal))
        Save()
        Check.Contains(
            Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true).Error,
            "protected owner path"
        )
        Reload()
        for call in State["api_calls"]?.AsArray() ?? throw Exception("Missing API evidence") {
            if Check.Text(call["path"]).Contains("/compare/") {
                Check.Contains(Check.Text(call["path"]), Check.Text(saved["base"]) + "...")
            }
        }
        Check.That(Check.Text(State["exec_count"]) == "1", "Read-only validation ran inference")
        Check.That(!File.Exists(marker), "Read-only validation executed PR code")
    }

    internal func GitEvidence() {
        for fault in[]string{"missing-nul", "invalid-utf8", "truncated"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.DiffFault("git_diff_fault", fault)
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "Git path evidence")
            flow.NoPr()
        }
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
            flow.ResetTraffic()
            let failure = flow.Call([]string{"work", "--run", run}, 1, traffic: true)
            if mode != "push_fail" {
                Check.Contains(failure.Error, "No automatic retry")
                Check.Contains(failure.Error, "outcome may be uncertain")
                flow.Traffic(26, 1, 16, 0)
            }
            let failed = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(Check.Text(failed["state"]) == "generated", "Publication failure discarded generated work")
            flow.PublicContent(run)
            if mode != "pr_fail_after_create" {
                flow.NoPr()
            }
            flow.Mode("")
            flow.ResetTraffic()
            flow.Call([]string{"publish", "--run", run}, traffic: true)
            if mode == "pr_fail_after_create" {
                flow.Traffic(10, 0, 0, 0)
            } else {
                flow.Traffic(18, 1, 8, 0)
            }
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

    internal func CanonicalVerification() {
        for mode in[]string{"replacement", "graft", "index_assume", "index_skip"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode(mode)
            let failure = flow.Call([]string{"work", "--run", run}, 1)
            Check.Contains(
                failure.Error,
                mode == "replacement" ? "protected owner configuration":
                mode == "graft" ? "info/grafts": "Candidate index"
            )
            Check.That(!File.Exists(Path.Combine(run, "verification.json")), "Unsafe candidate reached verification")
            Check.That(File.Exists(Path.Combine(run, "checkout/result.txt")), "Blocked work was removed")
            flow.NoPr()
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Guard retried inference")
        }
    }

    internal func SelfOwnedFlow() {
        Reload()
        State["self_owned"] = JsonValue.Create(true)
        Save()
        Call([]string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "owner"}, owner: true)
        let run = Claim()
        Call([]string{"work", "--run", run})
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Check.That(Check.Text(saved["head_repo"]) == "owner/project", "Self-owned version-1 run changed repository")
        Check.That(Check.Text(saved["state"]) == "published", "Self-owned version-1 publication failed")
    }

    internal func CanonicalPublication() {
        for mode in[]string{"replacement", "packed", "graft", "index_assume", "index_skip"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("push_fail")
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Mode("")
            let savedPath = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(savedPath))
            let checkout = Path.Combine(run, "checkout")
            let benign = Check.Text(saved["commit"])
            let branch = Check.Text(saved["branch"])
            let remote = Path.Combine(flow.Bin, "fork")
            let base = Check.Text(saved["base"])
            let template = Path.Combine(checkout, ".github/tokate-pr.md")
            if mode == "replacement" || mode == "packed" {
                flow.Git("-C", checkout, "checkout", "--force", "--detach", base)
                File.WriteAllText(Path.Combine(checkout, "result.txt"), "Implemented acceptance criteria\n")
                File.AppendAllText(template, "\nhidden protected change\n")
                flow.Git("-C", checkout, "add", ".")
                flow.Git(
                    "-C",
                    checkout,
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=test@example.test",
                    "commit",
                    "-m",
                    "Canonical protected change"
                )
                let malicious = flow.Git("-C", checkout, "rev-parse", "HEAD")
                flow.Git("-C", checkout, "replace", malicious, benign)
                if mode == "packed" {
                    flow.Git("-C", checkout, "pack-refs", "--all", "--prune")
                }
                flow.Git("-C", checkout, "checkout", "--force", "--detach", malicious)
                Check.That(flow.Git("-C", checkout, "status", "--porcelain") == "", "Exploit must look clean")
                Check.That(
                    flow.Git("-C", checkout, "diff", "--name-only", base, malicious) == "result.txt",
                    "Replacement did not mask protected change"
                )
                saved["commit"] = JsonValue.Create(malicious)
                File.WriteAllText(savedPath, saved.ToJsonString())
                let probe = Path.Combine(flow.Temp.Root, "probe.git")
                flow.Git("clone", "--bare", flow.Upstream, probe)
                flow.Git("-C", checkout, "push", probe, malicious + ":refs/heads/candidate")
                Check.Contains(
                    flow.Git("--no-replace-objects", "-C", probe, "show", "candidate:.github/tokate-pr.md"),
                    "hidden protected change"
                )
                Check.Contains(Commands.Git(checkout, "diff", "--name-only", base, malicious), ".github/tokate-pr.md")
                Check.Contains(
                    Commands.GitRaw(checkout, []string{"diff", "--name-only", "-z", base, malicious}),
                    ".github/tokate-pr.md\0"
                )
                let check = Verification.Run(
                    checkout,
                    []string{
                        "/bin/sh",
                        "-c",
                        "git show HEAD:.github/tokate-pr.md | /usr/bin/grep 'hidden protected change'"
                    },
                    false,
                    10
                )
                Check.That(check.Code == 0, check.Output + check.Error)
                if mode == "packed" {
                    flow.Git("--no-replace-objects", "-C", checkout, "checkout", "--force", "--detach", malicious)
                    Check.Contains(
                        flow.Call([]string{"publish", "--run", run}, 1).Error,
                        "Canonical commit differs from the independently verified patch"
                    )
                }
            } else if mode == "graft" {
                Directory.CreateDirectory(Path.Combine(checkout, ".git/info"))
                File.WriteAllText(Path.Combine(checkout, ".git/info/grafts"), benign + "\n")
                let ordinary = Check.Run(
                    "/usr/bin/git",
                    []string{"-C", checkout, "merge-base", "--is-ancestor", base, benign},
                    flow.Temp.Env
                )
                Check.That(ordinary.Code == 1, "Graft did not alter ancestry")
                Commands.Git(checkout, "merge-base", "--is-ancestor", base, benign)
            } else {
                flow.Git(
                    "-C",
                    checkout,
                    "update-index",
                    mode == "index_assume" ? "--assume-unchanged": "--skip-worktree",
                    ".github/tokate-pr.md"
                )
                File.AppendAllText(template, "\nhidden work file\n")
                Check.That(flow.Git("-C", checkout, "status", "--porcelain") == "", "Index flag must hide changed file")
            }
            let recordBefore = File.ReadAllText(savedPath)
            let patchBefore = File.ReadAllText(Path.Combine(run, "changes.patch"))
            flow.Call([]string{"publish", "--run", run}, 1)
            Check.That(flow.Git("-C", remote, "rev-parse", branch) == base, "Unsafe candidate reached publication")
            Check.That(File.ReadAllText(savedPath) == recordBefore, "Blocked publication rewrote record")
            Check.That(
                File.ReadAllText(Path.Combine(run, "changes.patch")) == patchBefore,
                "Blocked patch was rewritten"
            )
            Check.That(File.Exists(Path.Combine(checkout, "result.txt")), "Blocked work was removed")
            flow.NoPr()
        }
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
            Check.That(
                Check.Text(counts["reads"]) == reads.ToString() && Check.Text(
                    counts["mutations"]
                ) == mutations.ToString() && Check.Text(counts["conditional_responses"]) == conditional.ToString() &&
                    Check.Text(counts["retry_attempts"]) == retries.ToString(),
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
                Check.That(!result.Error.Contains(secret), "Diagnostics exposed private data")
            }
        }
        Console.WriteLine(
            "Traffic budget: reads=" + reads.ToString() + " mutations=" + mutations.ToString() +
                " conditional_responses=" +
                conditional.ToString() + " retry_attempts=" + retries.ToString()
        )
    }

    internal func TrafficBudgets() {
        ResetTraffic()
        let approval = Call(
            []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"},
            owner: true,
            traffic: true
        )
        Traffic(9, 5, 0, 0, approval)
        ResetTraffic()
        let claimed = Call(
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
                "--seconds",
                "30",
                "--runs",
                Path.Combine(Temp.Root, "runs")
            },
            traffic: true
        )
        Traffic(9, 1, 0, 0, claimed)
        let run = claimed.Output.Substring(claimed.Output.LastIndexOf("Run: ") + 5).Trim()
        Mode("push_fail")
        Call([]string{"work", "--run", run}, 1)
        Mode("")
        ResetTraffic()
        let published = Call([]string{"publish", "--run", run}, traffic: true)
        Traffic(18, 1, 8, 0, published)
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Publishing repeated inference")
        ResetTraffic()
        let repeated = Call([]string{"publish", "--run", run}, traffic: true)
        Traffic(10, 0, 0, 0, repeated)
        Reload()
        Check.That(
            State["pulls"]?.AsArray().Count == 1 && Check.Text(State["exec_count"]) == "1",
            "Repeated publication duplicated work"
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
        []string{
            "claim",
            "--repo",
            "owner/project",
            "--issue",
            "1",
            "--fork",
            "owner/project",
            "--model",
            "gpt-6.1-sol",
            "--effort",
            "high",
            "--seconds",
            "30",
            "--runs",
            Path.Combine(Temp.Root, "runs")
        },
        code,
        owner: true,
        traffic: true
    )

    internal func ConditionalClaim() {
        for mode in[]string{
            "strong",
            "weak",
            "weak-to-strong",
            "strong-to-weak",
            "missing",
            "empty",
            "bound",
            "weak-bound",
            "backslash"
        } {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.ApproveSelf()
            flow.ETags(mode)
            if mode == "empty" || mode == "bound" || mode == "weak-bound" || mode == "backslash" {
                let opaque = mode == "empty" ? "": (
                    mode == "backslash" ? "a\\b!": String('x', mode == "bound" ? 1022: 1020)
                )
                let tag = "\"" + opaque + "\""
                flow.State["etag_initial"] = JsonValue.Create(mode == "backslash" || mode == "bound" ? tag: "W/" + tag)
                flow.State["etag_returned"] = JsonValue.Create(mode == "backslash" ? "W/" + tag: tag)
                flow.Save()
            }
            flow.ResetTraffic()
            let claimed = flow.SameRepositoryClaim()
            flow.Traffic(9, 1, 1, 0, claimed)
            let run = claimed.Output.Substring(claimed.Output.LastIndexOf("Run: ") + 5).Trim()
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(Check.Text(saved["state"]) == "claimed", "Equivalent ETags blocked claim: " + mode)
            Check.That(Check.Text(saved["head_repo"]) == "owner/project", "Claim did not reuse upstream repository")
            flow.NoInference()
            flow.NoPr()
        }
    }

    internal func ConditionalValidators() {
        ApproveSelf()
        for initial in[]bool{false, true} {
            for tag in[]string{
                "opaque",
                "w/\"opaque\"",
                "W /\"opaque\"",
                "W/W/\"opaque\"",
                "W/\"",
                "\"opaque",
                "\"opaque\"suffix",
                "\"opa\"que\"",
                "\"opa que\"",
                "\"opa\tque\"",
                "\"opa\u0001que\"",
                "\"opa\u007fque\"",
                "\"opa\\\"que\"",
                "\"" + String('x', 1023) + "\"",
                "W/\"" + String('x', 1021) + "\""
            } {
                ETags("")
                if initial {
                    State["etag_initial"] = JsonValue.Create(tag)
                    State["etag_force_304"] = JsonValue.Create(true)
                }
                State["etag_returned"] = JsonValue.Create(tag)
                Save()
                ResetTraffic()
                let failed = SameRepositoryClaim(1)
                Check.Contains(failed.Error, "HTTP 304 without a matching in-memory body")
                Traffic(9, 0, 1, 0, failed)
                let calls = State["api_calls"]?.AsArray() ?? throw Exception("Missing traffic evidence")
                Check.That(
                    Check.Text(calls[calls.Count - 1]?["conditional"]) == (initial ? "false": "true"),
                    "Malformed initial tag was cached"
                )
                Check.That(!Directory.Exists(Path.Combine(Temp.Root, "runs")), "Rejected 304 created a run")
                NoInference()
                NoPr()
            }
        }
        for mode in[]string{"mismatch", "case", "missing-entry"} {
            ETags("")
            if mode == "missing-entry" {
                State["etag_initial"] = JsonValue.Create("")
                State["etag_returned"] = JsonValue.Create("")
                State["etag_force_304"] = JsonValue.Create(true)
            } else {
                State["etag_returned"] = JsonValue.Create(mode == "mismatch" ? "W/\"unrelated\"": "\"opaque\"")
                if mode == "case" {
                    State["etag_initial"] = JsonValue.Create("W/\"Opaque\"")
                }
            }
            Save()
            ResetTraffic()
            let failed = SameRepositoryClaim(1)
            Check.Contains(failed.Error, "HTTP 304 without a matching in-memory body")
            Traffic(9, 0, 1, 0, failed)
            Check.That(!Directory.Exists(Path.Combine(Temp.Root, "runs")), "Unmatched 304 created a run")
            NoInference()
            NoPr()
        }
    }

    internal func ConditionalPublication() {
        for mode in[]string{"strong", "weak", "weak-to-strong", "strong-to-weak", "missing"} {
            using let flow = NativeFlow(Binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.ETags(mode)
            flow.Mode("push_fail")
            flow.ResetTraffic()
            let worked = flow.Call([]string{"work", "--run", run}, 1, traffic: true)
            flow.Traffic(18, 0, 8, 0, worked)
            flow.NoPr()
            flow.Mode("")
            flow.ResetTraffic()
            let published = flow.Call([]string{"publish", "--run", run}, traffic: true)
            flow.Traffic(18, 1, 8, 0, published)
            flow.ResetTraffic()
            let repeated = flow.Call([]string{"publish", "--run", run}, traffic: true)
            flow.Traffic(10, 0, 0, 0, repeated)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Equivalent ETags repeated inference")
            Check.That(flow.State["pulls"]?.AsArray().Count == 1, "Equivalent ETags duplicated publication")
            Check.That(Check.Text(flow.State["pulls"]?[0]?["draft"]) == "true", "Publication must remain draft")
        }
    }

    internal func ConditionalApproval() {
        for tags in[]string{"strong", "weak-to-strong", "strong-to-weak"} {
            for mode in[]string{"after_304_edit", "after_304_revoke"} {
                for publication in[]bool{false, true} {
                    using let flow = NativeFlow(Binary)
                    flow.Initialize()
                    flow.Approve()
                    let run = flow.Claim()
                    flow.ETags(tags)
                    if publication {
                        flow.Mode("push_fail")
                        flow.Call([]string{"work", "--run", run}, 1)
                    }
                    flow.Mode(mode)
                    flow.ResetTraffic()
                    let failed = flow.Call([]string{publication ? "publish": "work", "--run", run}, 1, traffic: true)
                    let edited = mode == "after_304_edit"
                    Check.Contains(failed.Error, edited ? "The owner must approve again": "Issue needs Tokate approval")
                    flow.Traffic((publication ? 12: 10) + (edited ? 2: 0), 0, edited ? 3: 1, 0, failed)
                    flow.Reload()
                    var live bool
                    for call in flow.State["api_calls"]?.AsArray() ?? JsonArray() {
                        if Check.Text(call["status"]) == "304" {
                            Check.That(Check.Text(call["conditional"]) == "true", "304 lacked a conditional request")
                            live = true
                        }
                    }
                    Check.That(live, "No live 304 preceded approval change")
                    flow.NoPr()
                    Check.That(Check.Text(flow.State["exec_count"]) == "1", "Approval change repeated inference")
                }
            }
        }
    }

    internal func Faults(path string, faults JsonNode) {
        Reload()
        State["fault_path"] = JsonValue.Create(path)
        State["faults"] = faults
        State["fault_index"] = JsonValue.Create(0)
        Save()
        ResetTraffic()
    }

    internal func ReadTraffic() {
        for mode in[]string{"retry-after", "retry-date", "reset", "server", "transport"} {
            let faults = JsonArray()
            var headers string
            var status int32 = 429
            if mode == "retry-after" {
                headers = "Retry-After: 2\r\n"
            } else if mode == "retry-date" {
                headers = "Date: Wed, 01 Jan 2031 00:00:00 GMT\r\nRetry-After: Wed, 01 Jan 2031 00:00:02 GMT\r\n"
            } else if mode == "reset" {
                headers = "Date: Wed, 01 Jan 2031 00:00:00 GMT\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1924992002\r\n"
                status = 403
            } else {
                status = mode == "server" ? 503: 0
            }
            faults.Add(Check.Map("status", status, "headers", headers))
            Faults("repos/owner/project", faults)
            let timer = Stopwatch.StartNew()
            let result = Call([]string{"policy", "--repo", "owner/project"}, traffic: true)
            Check.That(
                timer.Elapsed.TotalSeconds >= (status == 0 || status == 503 ? 1.0: 2.0),
                "Server retry delay was ignored"
            )
            Check.That(timer.Elapsed.TotalSeconds < 10.0, "Retry used local time instead of server Date")
            Check.That(Check.Text(Check.Json(result.Output)["version"]) == "1", "Retry lost policy result")
            Traffic(3, 0, 0, 1, result)
        }
        for status in[]int32{0, 503, 401, 404, 422, 304, 403, 429} {
            let faults = JsonArray()
            for i in 0 ... 3 {
                faults.Add(
                    Check.Map(
                        "status",
                        status,
                        "message",
                        status == 403 ? "You have exceeded a secondary rate limit.": "failure"
                    )
                )
            }
            Faults("repos/owner/project", faults)
            let timer = Stopwatch.StartNew()
            let failure = Call([]string{"policy", "--repo", "owner/project"}, 1, traffic: true)
            let retryable = status == 0 || status == 503
            Traffic(retryable ? 3: 1, 0, status == 304 ? 1: 0, retryable ? 2: 0, failure)
            Check.That(timer.Elapsed.TotalSeconds < 10.0, "Unbounded read failure")
            if status == 403 || status == 429 {
                Check.Contains(failure.Error, "Retry at or after")
                Check.Contains(failure.Error, "in 60 seconds")
            }
            NoInference()
        }
        Faults("repos/owner/project", Check.Json("[{\"status\":429,\"headers\":\"Retry-After: 60\\r\\n\"}]"))
        let failure = Call([]string{"policy", "--repo", "owner/project"}, 1, traffic: true)
        Traffic(1, 0, 0, 0, failure)
        Check.Contains(failure.Error, "Retry at or after")
        Faults(
            "repos/owner/project",
            Check.Json("[{\"status\":503,\"pause_ms\":40000},{\"status\":503,\"pause_ms\":40000}]")
        )
        let timer = Stopwatch.StartNew()
        let timed = Call([]string{"policy", "--repo", "owner/project"}, 1, traffic: true)
        Check.That(
            timer.Elapsed.TotalSeconds >= 59.0 && timer.Elapsed.TotalSeconds < 65.0,
            "Subprocesses escaped the total read deadline"
        )
        Traffic(2, 0, 0, 1, timed)
    }

    internal func MutationTraffic() {
        for verb in[]string{"POST", "PATCH", "DELETE"} {
            if verb != "POST" {
                Approve()
            }
            let path = verb == "PATCH" ? "repos/owner/project/git/refs/heads/tokate/approvals/1":
            (
                verb == "DELETE" ? "repos/owner/project/issues/1/labels/tokate%3Aapproved": "repos/owner/project/issues/1/assignees"
            )
            Faults(path, Check.Json("[{\"status\":429,\"headers\":\"Retry-After: 2\\r\\n\"}]"))
            let result = verb == "DELETE" ? Call(
                []string{"revoke", "--repo", "owner/project", "--issue", "1"},
                1,
                owner: true,
                traffic: true
            ):
            Call(
                []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"},
                1,
                owner: true,
                traffic: true
            )
            Reload()
            Check.That(Check.Text(State["fault_index"]) == "1", "Mutation retried a rate limit")
            Check.Contains(result.Error, "No automatic retry")
            Check.Contains(result.Error, "Retry at or after")
            Check.That(!result.Error.Contains("synthetic-response-secret"), "Mutation failure leaked output")
            NoInference()
            Faults("", JsonArray())
        }
        Faults(
            "repos/owner/project/issues/1/assignees",
            Check.Json("[{\"status\":429,\"headers\":\"Retry-After: 2\\r\\n\"}]")
        )
        let put = Check.Run(
            Environment.ProcessPath ?? throw Exception("Missing executable"),
            []string{"--api-write", "PUT"},
            Temp.Env
        )
        Check.That(put.Code == 1, "PUT accepted a failed mutation")
        Traffic(0, 1, 0, 0, put)
        Check.Contains(put.Error, "No automatic retry")
        Check.Contains(put.Error, "Retry at or after")
        NoInference()
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

    private func BoundaryWork(run string, results Chan[Exception?]) {
        try {
            Call([]string{"work", "--run", run})
            results <- nil
        } catch (error Exception) {
            results <- error
        }
    }

    private func BoundaryRun(run string) {
        let results = Chan[Exception?](1)
        let pins = List[SafeFileHandle]()
        let identities = List[string]()
        let release = Path.Combine(Bin, "namespace-release")
        var failure Exception?
        var drained bool
        var released bool
        go BoundaryWork(run, results)
        try {
            let ready = Path.Combine(Bin, "namespace-ready")
            let clock = Stopwatch.StartNew()
            while !File.Exists(ready) && clock.Elapsed.TotalSeconds < 5 {
                select {
                    case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                }
            }
            Check.That(File.Exists(ready), "Owned task namespace readiness timed out")
            let pid = Int32.Parse(File.ReadAllText(ready))
            Check.That(pid > 0, "Invalid owned task PID")
            for name in[]string{"pid", "user", "ipc", "uts", "mnt", "net"} {
                let pin = File.OpenHandle(
                    "/proc/" + pid.ToString() + "/ns/" + name,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read
                )
                pins.Add(pin)
                let identity = File.ReadAllText(Path.Combine(run, "checkout", "expected-" + name + "-namespace"))
                identities.Add(identity)
                Check.That(
                    FileInfo("/proc/self/fd/" + pin.DangerousGetHandle().ToString()).LinkTarget == identity,
                    "Owned task namespace pin did not match " + name
                )
            }
            File.WriteAllText(release, "release")
            released = true
            let workFailure = <-results
            drained = true
            if let error = workFailure {
                throw error
            }
            var index int32
            for pin in pins {
                Check.That(
                    !pin.IsClosed && FileInfo(
                        "/proc/self/fd/" + pin.DangerousGetHandle().ToString()
                    ).LinkTarget == identities[index],
                    "Task namespace pin expired before verification returned"
                )
                index++
            }
        } catch (error Exception) {
            failure = error
        } finally {
            if !released {
                try {
                    File.WriteAllText(release, "release")
                } catch (error Exception) {
                    failure = failure ?? error
                }
            }
            if !drained {
                let error = <-results
                failure = failure ?? error
            }
            for pin in pins {
                try {
                    pin.Dispose()
                } catch (error Exception) {
                    failure = failure ?? error
                }
            }
        }
        if let error = failure {
            throw error
        }
    }

    internal func VerificationBoundary() {
        let temporary = Path.Combine("/tmp", Path.GetFileName(Temp.Root) + "-private")
        let persistent = Path.Combine(Temp.Root, "private")
        File.WriteAllText(temporary, "synthetic host tmp credential")
        File.WriteAllText(persistent, "synthetic sibling contribution")
        let socketPath = Path.Combine(Temp.Root, "private.socket")
        using let socket = Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
        let socketAddress = socketPath.Length < 100 ? socketPath:
        Path.GetRelativePath(Directory.GetCurrentDirectory(), socketPath)
        socket.Bind(UnixDomainSocketEndPoint(socketAddress))
        socket.Listen(1)
        try {
            let script = "set -eEu\n" +
                "trap 'printf \"VerificationBoundary failed probe line=%s namespace=%s saved=%s current=%s\\n\" \"$$LINENO\" \"$${ns-}\" \"$$(if [ -n \"$${ns-}\" ]; then cat expected-$$ns-namespace; fi)\" \"$$(if [ -n \"$${ns-}\" ]; then readlink /proc/self/ns/$$ns; fi)\" >&2' ERR\n" +
                "test -f result.txt\n" +
                "test \"$$PATH\" = /usr/local/bin:/usr/bin:/bin\n" +
                "test \"$$HOME\" = \"/tmp/tokate-home\" && test \"$$TMPDIR\" = \"$$HOME\"\n" +
                "test ! -e \"$$HOME/agent-cache.json\"\n" +
                "mkdir -p \"$$HOME/.cache/browser\" && printf unformatted > \"$$HOME/.cache/browser/cache.json\"\n" +
                "test -z \"$$(find . -name cache.json -o -name agent-cache.json -o -name .tokate-scratch)\"\n" +
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
            VerificationPolicy(script, second: "test ! -e \"$$HOME/.cache/browser/cache.json\"")
            Approve()
            let run = Claim()
            Mode("verification_boundary")
            try {
                BoundaryRun(run)
            } catch (error Exception) {
                let evidence = Path.Combine(run, "verification.json")
                if File.Exists(evidence) {
                    using let reader = StreamReader(evidence)
                    let buffer = [16384]char
                    let count = reader.ReadBlock(buffer, 0, buffer.Length)
                    Console.Error.WriteLine("VerificationBoundary synthetic verification: " + String(buffer, 0, count))
                }
                throw error
            }
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

    internal func VerificationRecovery(legacy bool = false) {
        VerificationPolicy("test -f result.txt", second: "test ! -f .tokate-scratch/cache.json")
        Approve()
        let run = Claim()
        Mode("verification_recovery")
        let failure = Call([]string{"work", "--run", run, "--json"}, 1)
        CliDiscovery.Envelope(failure, "work", "error", "verification_failed")
        let runPath = Path.Combine(run, "run.json")
        let failed = Check.Json(File.ReadAllText(runPath))
        Check.That(Check.Text(failed["failure_reason"]) == "verification_failed", "New failure omitted stable reason")
        failed["error"] = JsonValue.Create("Changed displayed wording: synthetic-saved-error-marker")
        if legacy {
            failed.AsObject().Remove("failure_reason")
            failed["error"] = JsonValue.Create(
                "Owner verification failed. See verification.json. No PR will be opened."
            )
        }
        File.WriteAllText(runPath, failed.ToJsonString())
        NoPr()
        let original = File.ReadAllText(Path.Combine(run, "verification.json"))
        Check.That(Check.Json(original).AsArray().Count == 2, "Original checks were not all run")
        Call([]string{"recover", "--run", run, "--seconds", "86400"}, 1)
        Reload()
        let issue = State["issue"] ?? throw Exception("Missing issue")
        issue["labels"] = JsonArray()
        Save()
        Call([]string{"recover", "--run", run}, 1)
        issue["labels"] = Check.Json("[{\"name\":\"tokate:approved\"}]")
        Save()
        let exclude = Path.Combine(run, "checkout/.git/info/exclude")
        let savedExclude = File.ReadAllText(exclude)
        let sentinel = Path.Combine(Temp.Root, "private-recovery")
        File.WriteAllText(sentinel, "synthetic recovery secret")
        File.Delete(exclude)
        File.CreateSymbolicLink(exclude, sentinel)
        Check.Contains(Call([]string{"recover", "--run", run}, 1).Error, "Git symlinks")
        Check.That(File.ReadAllText(sentinel) == "synthetic recovery secret", "Recovery changed private data")
        File.Delete(exclude)
        File.WriteAllText(exclude, savedExclude)
        let events = Path.Combine(run, "events.jsonl")
        let savedEvents = File.ReadAllText(events)
        let savedRun = File.ReadAllText(Path.Combine(run, "run.json"))
        let scratch = Path.Combine(run, "checkout/.tokate-scratch/cache.json")
        let savedCache = File.ReadAllText(scratch)
        let archives = Directory.GetDirectories(run, "recovery-*").Length
        File.WriteAllText(events, "")
        Check.Contains(Call([]string{"recover", "--run", run}, 1).Error, "completed turn and report")
        Check.That(File.ReadAllText(scratch) == savedCache, "Incomplete turn recovery moved the legacy cache")
        Check.That(
            File.ReadAllText(Path.Combine(run, "verification.json")) == original,
            "Incomplete turn recovery ran verification"
        )
        Check.That(
            File.ReadAllText(Path.Combine(run, "run.json")) == savedRun,
            "Incomplete turn recovery changed the run"
        )
        Check.That(
            Directory.GetDirectories(run, "recovery-*").Length == archives,
            "Incomplete turn recovery archived evidence"
        )
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Incomplete turn recovery spent inference")
        NoPr()
        File.WriteAllText(events, savedEvents)
        let protectedPath = Path.Combine(run, "checkout/.github/tokate.json")
        let protectedText = File.ReadAllText(protectedPath)
        File.AppendAllText(protectedPath, "\n")
        Check.Contains(
            Call([]string{"recover", "--run", run}, 1).Error,
            "Contribution changes protected owner configuration: \".github/tokate.json\""
        )
        File.WriteAllText(protectedPath, protectedText)
        File.WriteAllText(runPath, savedRun)
        let resultPath = Path.Combine(run, "checkout/result.txt")
        let candidateText = File.ReadAllText(resultPath)
        File.AppendAllText(resultPath, "changed candidate\n")
        Check.Contains(Call([]string{"recover", "--run", run}, 1).Error, "Saved candidate patch changed")
        File.WriteAllText(resultPath, candidateText)
        File.WriteAllText(runPath, savedRun)
        Check.That(
            File.ReadAllText(Path.Combine(run, "verification.json")) == original,
            "Rejected recovery reran verification"
        )
        CliDiscovery.Envelope(Call([]string{"recover", "--run", run, "--json"}), "recover", "ok")
        Reload()
        Check.That(Check.Text(State["exec_count"]) == "1", "Recovery spent inference")
        Check.Contains(File.ReadAllText(Path.Combine(run, "pr-body.md")), "verification-only recovery")
        Check.Contains(File.ReadAllText(Path.Combine(run, "pr-body.md")), "2/2 checks passed")
        Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        var preserved bool
        for archive in Directory.GetDirectories(run, "recovery-*") {
            if File.ReadAllText(Path.Combine(archive, "verification.json")) == original {
                preserved = true
            }
        }
        Check.That(preserved, "Recovery lost failed verification evidence")
        Call([]string{"recover", "--run", run}, 1)
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
        internal let SerialGroups[]string = []string{
            "ReadTraffic",
            "TemporaryIsolation",
            "TemporaryHomeRejected",
            "VerificationBoundary"
        }

        internal func All(binary string, selected string = "", parallel bool = false) {
            var matched bool
            for name in[]string{
                "HelpAndArguments",
                "MissingTools",
                "DoctorToolchain",
                "OwnerWithoutCodex",
                "StructuredContract",
                "StructuredFailures",
                "CrossAccountFlow",
                "OwnerPolicy",
                "ModelPolicyModes",
                "ModelPolicyMalformed",
                "FailedReassignment",
                "MissingFork",
                "VerificationReserve",
                "DefaultBudget",
                "HigherOwnerBudget",
                "LowerOwnerBudget",
                "IssueEdit",
                "Revocation",
                "Timeout",
                "ManagedCancellation",
                "Reapproval",
                "FalseSuccess",
                "PolicyEdit",
                "WorkflowEdit",
                "ProtectedEntrypoint",
                "ProtectedRecovery",
                "ProtectedPublication",
                "ProtectedPolicyFreshness",
                "EmptyProtectedPaths",
                "ReceiptEvidence",
                "GitEvidence",
                "RepositoryConfig",
                "NoPatch",
                "TemporaryIsolation",
                "TemporaryHomeRejected",
                "OutputBoundary",
                "ToolAuthentication",
                "TrafficBudgets",
                "ConditionalClaim",
                "ConditionalValidators",
                "ConditionalPublication",
                "ConditionalApproval",
                "ReadTraffic",
                "MutationTraffic",
                "PublicationFailures",
                "CanonicalVerification",
                "CanonicalPublication",
                "SelfOwnedFlow",
                "PublicationRevocation",
                "BackgroundCleanup",
                "UnsupportedSandbox",
                "VerificationBoundary",
                "VerificationNetwork",
                "VerificationRecovery",
                "LegacyVerificationRecovery"
            } {
                if selected != "" && selected != name {
                    continue
                }
                if parallel && Array.IndexOf(SerialGroups, name) >= 0 {
                    continue
                }
                matched = true
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
                    case "StructuredFailures" {
                        flow.StructuredFailures()
                    }
                    case "StructuredContract" {
                        flow.StructuredContract()
                    }
                    case "CrossAccountFlow" {
                        flow.CrossAccountFlow()
                    }
                    case "OwnerPolicy" {
                        flow.OwnerPolicy()
                    }
                    case "ModelPolicyModes" {
                        flow.ModelPolicyModes()
                    }
                    case "ModelPolicyMalformed" {
                        flow.ModelPolicyMalformed()
                    }
                    case "FailedReassignment" {
                        flow.FailedReassignment()
                    }
                    case "MissingFork" {
                        flow.MissingFork()
                    }
                    case "VerificationReserve" {
                        ReserveChecks.All(binary)
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
                    case "ManagedCancellation" {
                        flow.ManagedCancellation()
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
                    case "ProtectedEntrypoint" {
                        flow.ProtectedEntrypoint()
                    }
                    case "ProtectedRecovery" {
                        flow.ProtectedRecovery()
                    }
                    case "ProtectedPublication" {
                        flow.ProtectedPublication()
                    }
                    case "ProtectedPolicyFreshness" {
                        flow.ProtectedPolicyFreshness()
                    }
                    case "EmptyProtectedPaths" {
                        flow.EmptyProtectedPaths()
                    }
                    case "ReceiptEvidence" {
                        flow.ReceiptEvidence()
                    }
                    case "GitEvidence" {
                        flow.GitEvidence()
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
                    case "TrafficBudgets" {
                        flow.TrafficBudgets()
                    }
                    case "ConditionalClaim" {
                        flow.ConditionalClaim()
                    }
                    case "ConditionalValidators" {
                        flow.ConditionalValidators()
                    }
                    case "ConditionalPublication" {
                        flow.ConditionalPublication()
                    }
                    case "ConditionalApproval" {
                        flow.ConditionalApproval()
                    }
                    case "ReadTraffic" {
                        flow.ReadTraffic()
                    }
                    case "MutationTraffic" {
                        flow.MutationTraffic()
                    }
                    case "PublicationFailures" {
                        flow.PublicationFailures()
                    }
                    case "CanonicalVerification" {
                        flow.CanonicalVerification()
                    }
                    case "CanonicalPublication" {
                        flow.CanonicalPublication()
                    }
                    case "SelfOwnedFlow" {
                        flow.SelfOwnedFlow()
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
                    case "VerificationRecovery" {
                        flow.VerificationRecovery()
                    }
                    case "LegacyVerificationRecovery" {
                        flow.VerificationRecovery(true)
                    }
                    case "VerificationNetwork" {
                        flow.VerificationNetwork()
                    }
                    default {
                        throw Exception("Unknown test: " + name)
                    }
                }
                flow.AutomationAttribution()
                Console.WriteLine("PASS " + name)
            }
            Check.That(matched, "Unknown native selector: " + selected)
        }
    }
}
