package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal open class CoordinationFixture : IDisposable {
    internal let Flow NativeFixture
    internal let Tools string
    internal var Comment int32 = 10
    internal var Issue int32 = 1

    internal init(binary string) {
        Flow = NativeFixture(binary)
        Tools = Path.Combine(Flow.Temp.Root, "tools.json")
    }

    internal func Initialize(approve bool = true) {
        Flow.Initialize()
        Flow.Temp.Env["GITHUB_EVENT_NAME"] = "issue_comment"
        let policyPath = Path.Combine(Flow.Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(policyPath))
        policy["version"] = JsonValue.Create(2)
        policy["allowed_tools"] = Check.Json(
            "[{\"harness\":\"codex\",\"provider\":\"openai\"},{\"harness\":\"claude\",\"provider\":\"anthropic\"}]"
        )
        let models = policy["models"] ?? throw Exception("Missing models")
        models["claude-sonnet-4-6"] = Check.Json("[\"unknown\"]")
        File.WriteAllText(policyPath, policy.ToJsonString())
        Flow.Commit("Explicit owner version-2 opt-in")
        if approve {
            Flow.Approve()
        }
        File.WriteAllText(
            Tools,
            "[{\"harness\":\"claude\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"effort\":\"unknown\",\"usage\":null,\"coding_seconds\":null},{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
    }

    public func Dispose() -> Flow.Dispose()

    internal func State() JsonNode -> Check.Json(
        Flow.Call([]string{"coordination", "--repo", "owner/project", "--issue", Issue.ToString()}).Output
    )

    internal func ClaimRequest() JsonNode {
        let state = State()
        return Check.Map(
            "uuid",
            Guid.NewGuid().ToString("D"),
            "expected",
            Check.Text(state["sha"]),
            "approval",
            Check.Text(state["state"]?["approval_id"]),
            "action",
            "claim",
            "metadata",
            Check.Json("{}")
        )
    }

    internal func Event(request JsonNode, actor int32 = 123, login string = "donor") string {
        Comment++
        let body = "/tokate " + request.ToJsonString()
        let comment = Check.Map(
            "id",
            Comment,
            "body",
            body,
            "user",
            Check.Map("id", actor, "login", login),
            "issue_url",
            "https://api.github.com/repos/owner/project/issues/" + Issue.ToString()
        )
        Flow.Reload()
        if Flow.State["comments"] == nil {
            Flow.State["comments"] = Check.Json("{}")
        }
        let comments = Flow.State["comments"] ?? throw Exception("Missing comments")
        comments[Comment.ToString()] = comment.DeepClone()
        Flow.Save()
        let path = Path.Combine(Flow.Temp.Root, "event-" + Comment.ToString() + ".json")
        File.WriteAllText(
            path,
            Check.Map(
                "action",
                "created",
                "repository",
                Check.Map("full_name", "owner/project", "id", 1),
                "issue",
                Check.Map("number", Issue),
                "comment",
                comment
            )
                .ToJsonString()
        )
        return path
    }

    internal func Coordinate(path string, code int32 = 0, traffic bool = false) Result -> Flow.Call(
        []string{"coordinate", "--repo", "owner/project", "--event", path},
        code,
        owner: true,
        traffic: traffic
    )

    internal func Claim(selected bool = false) JsonNode {
        let request = ClaimRequest()
        let path = Event(request)
        Flow.ResetTraffic()
        let result = Coordinate(path, traffic: true)
        Flow.Traffic(selected ? 18: 16, 3, selected ? 9: 8, 0, result)
        return request
    }

    internal func RewriteState(value JsonNode) {
        let previous = Check.Text(State()["sha"])
        let path = Path.Combine(Flow.Temp.Root, "trusted-state.json")
        File.WriteAllText(path, value.ToJsonString())
        let blob = Flow.Git("-C", Flow.Upstream, "hash-object", "-w", path)
        let index = Path.Combine(Flow.Temp.Root, "state.index")
        let env = Dictionary[string, string](Flow.Temp.Env)
        for key in[]string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"} {
            env.Remove(key)
        }
        env["GIT_INDEX_FILE"] = index
        Check.Success(TestProcess.Run("/usr/bin/git", []string{"-C", Flow.Upstream, "read-tree", "--empty"}, env))
        Check.Success(
            TestProcess.Run(
                "/usr/bin/git",
                []string{"-C", Flow.Upstream, "update-index", "--add", "--cacheinfo", "100644," + blob + ",state.json"},
                env
            )
        )
        let tree = Check.Success(TestProcess.Run("/usr/bin/git", []string{"-C", Flow.Upstream, "write-tree"}, env))
        let next = Flow.Git(
            "-C",
            Flow.Upstream,
            "-c",
            "user.name=Owner",
            "-c",
            "user.email=owner@example.test",
            "commit-tree",
            tree,
            "-p",
            previous,
            "-m",
            "Trusted test clock transition"
        )
        Flow.Git("-C", Flow.Upstream, "update-ref", "refs/heads/tokate/contributions/1", next, previous)
    }

    internal func PublishRequest(claim JsonNode, commit string) JsonNode {
        let state = State()
        return Check.Map(
            "uuid",
            Guid.NewGuid().ToString("D"),
            "expected",
            Check.Text(state["sha"]),
            "approval",
            Check.Text(state["state"]?["approval_id"]),
            "action",
            "publish",
            "metadata",
            Check.Map(
                "fork",
                "donor/project",
                "branch",
                "tokate/v2-" + Check.Text(claim["uuid"]),
                "head",
                commit,
                "source",
                "external",
                "tools",
                Check.Json(File.ReadAllText(Tools)),
                "verification",
                "donor-reported-pass",
                "attempt",
                Check.Text(state["state"]?["reservation"]?["attempt"])
            )
        )
    }

    internal func Expire() {
        let state = State()["state"] ?? throw Exception("Missing state")
        let reservation = state["reservation"] ?? throw Exception("Missing reservation")
        reservation["expires"] = JsonValue.Create(1)
        RewriteState(state)
    }

    internal func Prepare(
        source string = "external",
        code int32 = 0,
        seconds string = "30",
        network bool = false,
        reserve string = "",
        unlimited bool = false
    ) string {
        let state = State()
        let args = List[string]{
            "prepare",
            "--repo",
            "owner/project",
            "--issue",
            "1",
            "--state",
            Check.Text(state["sha"]),
            "--source",
            source,
            "--tools",
            Tools,
            "--seconds",
            seconds,
            "--runs",
            Path.Combine(Flow.Temp.Root, "runs")
        }
        if reserve != "" {
            args.AddRange([]string{"--verification-reserve", reserve})
        }
        if unlimited {
            args.RemoveRange(args.IndexOf("--seconds"), 2)
            args.Add("--unlimited")
        }
        if network {
            args.Add("--allow-network")
        }
        let result = Flow.Call(args.ToArray(), code)
        if code != 0 {
            Check.That(
                !result.Error.Contains("Saved contribution already exists"),
                "Declaration reached saved-run creation"
            )
        }
        let index = result.Output.LastIndexOf("Run: ")
        return index < 0 ? "": result.Output.Substring(index + 5).Trim()
    }

    internal func Candidate(request JsonNode, change string = "") string {
        let checkout = Path.Combine(Flow.Temp.Root, "donor-work")
        Flow.Git("clone", Flow.Upstream, checkout)
        File.WriteAllText(Path.Combine(checkout, "result.txt"), "External mixed-tool contribution\n")
        switch change {
            case "entrypoint" {
                File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "exit 0\n")
            }
            case "rename-out" {
                Flow.Git("-C", checkout, "mv", "scripts/checks/original", "moved")
            }
            case "rename-in" {
                Flow.Git("-C", checkout, "mv", "ordinary-source", "scripts/checks/moved")
            }
            case "directory-node" {
                Directory.Delete(Path.Combine(checkout, "scripts/checks"), true)
                File.WriteAllText(Path.Combine(checkout, "scripts/checks"), "replacement\n")
            }
            case "mode" {
                File.SetUnixFileMode(
                    Path.Combine(checkout, "scripts/verify.sh"),
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                )
            }
            case "type" {
                File.Delete(Path.Combine(checkout, "scripts/verify.sh"))
                File.CreateSymbolicLink(Path.Combine(checkout, "scripts/verify.sh"), "../result.txt")
            }
            case "newline" {
                File.WriteAllText(Path.Combine(checkout, "scripts/checks/line\n\".sh"), "new\n")
            }
            case "permitted" {
                Directory.CreateDirectory(Path.Combine(checkout, "scripts/checks-old"))
                File.WriteAllText(Path.Combine(checkout, "scripts/checks-old/line\n\".sh"), "permitted\n")
            }
        }
        Flow.Git("-C", checkout, "add", ".")
        Flow.DonorGit(checkout, "commit", "-m", "External result")
        let commit = Flow.Git("-C", checkout, "rev-parse", "HEAD")
        Flow.Git(
            "-C",
            checkout,
            "push",
            Path.Combine(Flow.Bin, "fork"),
            "HEAD:refs/heads/tokate/v2-" + Check.Text(request["uuid"])
        )
        return commit
    }
}
