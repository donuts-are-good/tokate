package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class CoordinationFlow : IDisposable {
    internal let Flow NativeFlow
    internal let Tools string
    internal var Comment int32 = 10

    internal init(binary string) {
        Flow = NativeFlow(binary)
        Tools = Path.Combine(Flow.Temp.Root, "tools.json")
    }

    internal func Initialize() {
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
        Flow.Approve()
        File.WriteAllText(
            Tools,
            "[{\"harness\":\"claude\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"effort\":\"unknown\",\"usage\":null,\"coding_seconds\":null},{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
    }

    public func Dispose() -> Flow.Dispose()

    internal func State() JsonNode -> Check.Json(
        Flow.Call([]string{"coordination", "--repo", "owner/project", "--issue", "1"}).Output
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
            "https://api.github.com/repos/owner/project/issues/1"
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
                Check.Map("number", 1),
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

    internal func Claim() JsonNode {
        let request = ClaimRequest()
        let path = Event(request)
        Flow.ResetTraffic()
        let result = Coordinate(path, traffic: true)
        Flow.Traffic(9, 3, 1, 0, result)
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
        Check.Success(Check.Run("/usr/bin/git", []string{"-C", Flow.Upstream, "read-tree", "--empty"}, env))
        Check.Success(
            Check.Run(
                "/usr/bin/git",
                []string{"-C", Flow.Upstream, "update-index", "--add", "--cacheinfo", "100644," + blob + ",state.json"},
                env
            )
        )
        let tree = Check.Success(Check.Run("/usr/bin/git", []string{"-C", Flow.Upstream, "write-tree"}, env))
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

    internal func Expire() {
        let state = State()["state"] ?? throw Exception("Missing state")
        let reservation = state["reservation"] ?? throw Exception("Missing reservation")
        reservation["expires"] = JsonValue.Create(1)
        RewriteState(state)
    }

    internal func ReplayAndInterruptedState() {
        let request = ClaimRequest()
        let path = Event(request)
        Flow.Mode("lost_state_response")
        Coordinate(path, 1)
        let state = State()
        Check.That(
            Check.Text(state["state"]?["reservation"]?["reservation"]) == Check.Text(request["uuid"]),
            "Lost response lost authoritative claim"
        )
        Flow.ResetTraffic()
        let replay = Coordinate(path, traffic: true)
        Flow.Traffic(4, 0, 0, 0, replay)
        Check.That(Check.Text(State()["sha"]) == Check.Text(state["sha"]), "Replay wrote state")
        let changed = request.DeepClone()
        changed["metadata"] = Check.Map("command", "touch /tmp/unsafe")
        Coordinate(Event(changed), 1)
        Coordinate(Event(request, 124, "other"), 1)
        let parents = Flow.Git("-C", Flow.Upstream, "rev-list", "--parents", "-n", "1", Check.Text(state["sha"]))
        Check.That(parents.Split(' ').Length == 2, "State update did not have exactly one parent")
        Flow.NoInference()
        Flow.NoPr()
    }

    internal func SimultaneousClaims() {
        let first = ClaimRequest()
        let second = ClaimRequest()
        let path1 = Event(first)
        let path2 = Event(second)
        let env = Dictionary[string, string](Flow.Temp.Env)
        env["GH_TOKEN"] = "fixture-owner"
        let output = Chan[Result](2)
        go Concurrent(Flow.Binary, path1, env, output)
        go Concurrent(Flow.Binary, path2, env, output)
        let a = <-output
        let b = <-output
        Check.That(
            (a.Code == 0 && b.Code == 1) || (a.Code == 1 && b.Code == 0),
            "Competing command claims did not produce exactly one winner: " + a.Error + b.Error
        )
        let state = State()
        Check.That(state["state"]?["outcomes"]?.AsArray().Count == 1, "Two outcomes acquired authority")
        Flow.Reload()
        var attempts int32
        var rejected int32
        for call in Flow.State["api_calls"]?.AsArray() ?? throw Exception("Missing API evidence") {
            if Check.Text(call["method"]) == "PATCH" && Check.Text(
                call["path"]
            ) == "repos/owner/project/git/refs/heads/tokate/contributions/1" {
                attempts++
                if Check.Text(call["status"]) == "422" {
                    rejected++
                }
            }
        }
        Check.That(
            attempts == 2 && rejected == 1,
            "Concurrent claims did not exercise the non-forced competing ref updates"
        )
        Coordinate(Event(ClaimRequest(), 124, "other"), 1)
        Flow.NoInference()
    }

    internal func Prepare(source string = "external", code int32 = 0) string {
        let state = State()
        let result = Flow.Call(
            []string{
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
                "30",
                "--runs",
                Path.Combine(Flow.Temp.Root, "runs")
            },
            code
        )
        let index = result.Output.LastIndexOf("Run: ")
        return index < 0 ? "": result.Output.Substring(index + 5).Trim()
    }

    internal func Candidate(request JsonNode) string {
        let checkout = Path.Combine(Flow.Temp.Root, "donor-work")
        Flow.Git("clone", Flow.Upstream, checkout)
        File.WriteAllText(Path.Combine(checkout, "result.txt"), "External mixed-tool contribution\n")
        Flow.Git("-C", checkout, "add", ".")
        Flow.Git(
            "-C",
            checkout,
            "-c",
            "user.name=Donor",
            "-c",
            "user.email=donor@example.test",
            "commit",
            "-m",
            "External result"
        )
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

    internal func ExternalPublication() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        // No Codex binary or ChatGPT login is available for this path.
        File.Delete(Path.Combine(Flow.Bin, "codex"))
        Flow.Call([]string{"external", "--run", run, "--commit", String('0', 40)}, 1)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Check.Contains(Check.Text(saved["verification_provenance"]), "tokate-observed")
        Check.Contains(Check.Text(saved["tool_provenance"]), "donor-reported")
        Check.That(
            Flow.Git("-C", Path.Combine(run, "checkout"), "rev-parse", "HEAD") == commit,
            "Wrong external commit verified"
        )
        Check.That(
            !File.Exists(Path.Combine(run, "checkout/.git/objects/info/alternates")),
            "Imported external Git metadata"
        )
        Flow.Call([]string{"submit", "--run", run})
        Flow.Reload()
        let posted = Check.Text(Flow.State["posted_request"]?["body"])
        let publish = Check.Json(posted.Substring(8))
        let path = Event(publish)
        Flow.Mode("pr_fail_after_create")
        Coordinate(path, 1)
        Flow.Mode("")
        Flow.ResetTraffic()
        let result = Coordinate(path, traffic: true)
        Flow.Traffic(31, 3, 19, 0, result)
        Flow.Reload()
        Check.That(Flow.State["pulls"]?.AsArray().Count == 1, "Interrupted publication duplicated PR")
        Check.That(
            Check.Text(State()["state"]?["contribution"]?["metadata"]?["head"]) == commit,
            "State lost exact commit"
        )
        Flow.ResetTraffic()
        let duplicate = Coordinate(path, traffic: true)
        Flow.Traffic(4, 0, 0, 0, duplicate)
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        Flow.Call([]string{"checks", "--repo", "owner/project", "--pr", "10"}, 8, owner: true)
        Expire()
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        Flow.Call([]string{"submit", "--run", run}, 1)
        Flow.NoInference()
    }

    internal func CanonicalExternal() {
        let claim = Claim()
        let run = Prepare()
        let benign = Candidate(claim)
        let work = Path.Combine(Flow.Temp.Root, "donor-work")
        File.AppendAllText(Path.Combine(work, ".github/tokate-pr.md"), "\nhidden protected change\n")
        Flow.Git("-C", work, "add", ".")
        Flow.Git(
            "-C",
            work,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "Protected correction"
        )
        let malicious = Flow.Git("-C", work, "rev-parse", "HEAD")
        Flow.Git(
            "-C",
            work,
            "push",
            Path.Combine(Flow.Bin, "fork"),
            malicious + ":refs/heads/tokate/v2-" + Check.Text(claim["uuid"])
        )
        Flow.Reload()
        Flow.State["replacement_for"] = JsonValue.Create(malicious)
        Flow.State["replacement_with"] = JsonValue.Create(benign)
        Flow.Save()
        Flow.Mode("external_replacement")
        let failure = Flow.Call([]string{"external", "--run", run, "--commit", malicious}, 1)
        Check.Contains(failure.Error, "protected owner policy")
        Check.That(!File.Exists(Path.Combine(run, "verification.json")), "Hidden protected change was verified")
        Check.That(
            !File.Exists(Path.Combine(run, "request.json")),
            "Hidden protected change obtained publication authority"
        )
        Flow.NoPr()
        Flow.NoInference()
    }

    internal func CanonicalSubmit() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        let checkout = Path.Combine(run, "checkout")
        let savedPath = Path.Combine(run, "run.json")
        let saved = File.ReadAllText(savedPath)
        for flag in[]string{"--assume-unchanged", "--skip-worktree"} {
            Flow.Git("-C", checkout, "update-index", flag, ".github/tokate-pr.md")
            File.AppendAllText(Path.Combine(checkout, ".github/tokate-pr.md"), "\nhidden work file\n")
            Check.That(Flow.Git("-C", checkout, "status", "--porcelain") == "", "Changed candidate must look clean")
            Check.Contains(Flow.Call([]string{"submit", "--run", run}, 1).Error, "Candidate index")
            Check.That(
                !File.Exists(Path.Combine(run, "request.json")),
                "Hidden work file obtained publication authority"
            )
            Check.That(File.ReadAllText(savedPath) == saved, "Blocked submit rewrote verification record")
            Flow.Git("-C", checkout, "update-index", "--no-assume-unchanged", ".github/tokate-pr.md")
            Flow.Git("-C", checkout, "update-index", "--no-skip-worktree", ".github/tokate-pr.md")
            Flow.Git("-C", checkout, "checkout", "--", ".github/tokate-pr.md")
        }
        Directory.CreateDirectory(Path.Combine(checkout, ".git/info"))
        File.WriteAllText(Path.Combine(checkout, ".git/info/grafts"), commit + "\n")
        Check.Contains(Flow.Call([]string{"submit", "--run", run}, 1).Error, "info/grafts")
        Check.That(!File.Exists(Path.Combine(run, "request.json")), "Grafted candidate obtained publication authority")
        Check.That(File.ReadAllText(savedPath) == saved, "Graft rejection rewrote verification record")
        Flow.NoPr()
        Flow.NoInference()
    }

    internal func ExpiryAndRevocation() {
        let original = Claim()
        let run = Prepare()
        Expire()
        Flow.Call([]string{"external", "--run", run, "--commit", String('0', 40)}, 1)
        let expired = State()
        let publication = Check.Map(
            "uuid",
            Guid.NewGuid().ToString("D"),
            "expected",
            Check.Text(expired["sha"]),
            "approval",
            Check.Text(expired["state"]?["approval_id"]),
            "action",
            "publish",
            "metadata",
            Check.Map(
                "fork",
                "donor/project",
                "branch",
                "tokate/v2-" + Check.Text(original["uuid"]),
                "head",
                String('a', 40),
                "source",
                "external",
                "tools",
                Check.Json(File.ReadAllText(Tools)),
                "verification",
                "donor-reported-pass"
            )
        )
        Coordinate(Event(publication), 1)
        let late = ClaimRequest()
        Claim()
        Coordinate(Event(late), 1)
        Flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
        Prepare(code: 1)
        Flow.NoInference()
        Flow.NoPr()
    }

    internal func InvalidEvents() {
        let request = ClaimRequest()
        let path = Event(request)
        let original = File.ReadAllText(path)
        var event = Check.Json(original)
        let user = event["comment"]?["user"] ?? throw Exception("Missing user")
        user["id"] = JsonValue.Create(124)
        File.WriteAllText(path, event.ToJsonString())
        Coordinate(path, 1)
        event = Check.Json(original)
        let comment = event["comment"] ?? throw Exception("Missing comment")
        comment["body"] = JsonValue.Create("/tokate {\"uuid\":1,\"uuid\":2}")
        Flow.Reload()
        let canonical = Flow.State["comments"]?[Comment.ToString()] ?? throw Exception("Missing canonical comment")
        canonical["body"] = comment["body"]?.DeepClone()
        Flow.Save()
        File.WriteAllText(path, event.ToJsonString())
        Coordinate(path, 1)
        for body in[]string{
            "/tokate " + request.ToJsonString() + " trailing",
            "/tokate " + String('[', 33) + "0" + String(']', 33),
            "/tokate {\"data\":\"" + String('x', 8192) + "\"}"
        } {
            comment["body"] = JsonValue.Create(body)
            Flow.Reload()
            let fresh = Flow.State["comments"]?[Comment.ToString()] ?? throw Exception("Missing comment")
            fresh["body"] = JsonValue.Create(body)
            Flow.Save()
            File.WriteAllText(path, event.ToJsonString())
            Coordinate(path, 1)
        }
        File.WriteAllText(path, String('x', 1024 * 1024 + 1))
        Coordinate(path, 1)
        for field in[]string{
            "actor",
            "command",
            "patch",
            "credentials",
            "expression",
            "accept",
            "assign",
            "",
            "uuid,expected"
        } {
            let prohibited = request.DeepClone()
            prohibited[field] = JsonValue.Create("untrusted synthetic value")
            Coordinate(Event(prohibited), 1)
        }
        Check.That(State()["state"]?["reservation"] == nil, "Invalid event changed authority")
        Flow.NoInference()
    }

    internal func InterruptedWrite() {
        let request = ClaimRequest()
        let path = Event(request)
        Flow.Mode("interrupted_state_write")
        Coordinate(path, 1)
        Check.That(State()["state"]?["reservation"] == nil, "Interrupted write acquired a claim")
        Flow.Mode("")
        Coordinate(path)
        let revision = Check.Text(State()["sha"])
        Coordinate(path)
        Check.That(Check.Text(State()["sha"]) == revision, "Interrupted-write replay repeated its effect")
    }

    internal func PublicationRevocation() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        Flow.Call([]string{"submit", "--run", run})
        let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
        Flow.Mode("revoke_after_pr")
        Coordinate(Event(request), 1)
        Flow.Reload()
        Check.That(Flow.State["pulls"]?.AsArray().Count == 1, "Race should retain physical PR for owner inspection")
        Check.That(State()["state"]?["contribution"] == nil, "Revoked PR received authority")
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        Flow.NoInference()
    }

    internal func ExpiryDuringPublication() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        Flow.Call([]string{"submit", "--run", run})
        let state = State()["state"] ?? throw Exception("Missing state")
        let reservation = state["reservation"] ?? throw Exception("Missing reservation")
        reservation["expires"] = JsonValue.Create(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 2)
        RewriteState(state)
        let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
        request["expected"] = JsonValue.Create(Check.Text(State()["sha"]))
        Coordinate(Event(request), 1)
        Check.That(State()["state"]?["contribution"] == nil, "Paced publication acquired expired authority")
        Flow.NoInference()
    }

    internal func EvictedReplay() {
        var first JsonNode? = nil
        for i in 0 ... 33 {
            let request = ClaimRequest()
            if i == 0 {
                first = request.DeepClone()
            }
            Coordinate(Event(request))
            if i < 32 {
                Expire()
            }
        }
        let current = State()
        Check.That(current["state"]?["outcomes"]?.AsArray().Count == 32, "Outcome window is not bounded at 32")
        Coordinate(Event(first ?? throw Exception("Missing first request")), 1)
        Check.That(Check.Text(State()["sha"]) == Check.Text(current["sha"]), "Evicted request repeated a claim")
        Flow.NoInference()
    }

    internal func SetupRelease() {
        let output = Path.Combine(Flow.Temp.Root, "coordinator.yml")
        let args = []string{"coordinator-setup", "--repo", "owner/project", "--output", output}
        Flow.Call(args, 1, owner: true)
        Check.That(!File.Exists(output), "Unreleased binary generated a workflow")
        Flow.Call(
            []string{
                "coordinator-setup",
                "--repo",
                "owner/project",
                "--output",
                Path.Combine(Flow.Upstream, ".github/coordinator.yml")
            },
            1,
            owner: true
        )
        let version = Flow.Call([]string{"--version"}).Output.Trim().Substring(7)
        let bundle = "tokate-" + version + "-linux-x64"
        let storage = Path.Combine(Flow.Temp.Root, bundle)
        Directory.CreateDirectory(storage)
        File.Copy(Flow.Binary, Path.Combine(storage, "tokate"))
        let archive = Path.Combine(Flow.Bin, "release.tar.gz")
        Check.Success(Check.Run("/usr/bin/tar", []string{"-czf", archive, "-C", Flow.Temp.Root, bundle}, Flow.Temp.Env))
        Flow.Temp.Tool("curl")
        Flow.Reload()
        Flow.State["coordinator_download"] = JsonValue.Create(true)
        Flow.State["release_version"] = JsonValue.Create(version)
        let assets = JsonArray()
        assets.Add(
            Check.Map(
                "id",
                41,
                "name",
                bundle + ".tar.gz",
                "state",
                "uploaded",
                "size",
                Convert.ToInt32(FileInfo(archive).Length)
            )
        )
        assets.Add(Check.Map("id", 42, "name", bundle + ".tar.gz.sha256", "state", "uploaded", "size", 128))
        Flow.State["release"] = Check.Map(
            "tag_name",
            "v" + version,
            "draft",
            false,
            "prerelease",
            false,
            "assets",
            assets
        )
        Flow.Save()
        Flow.Call(args, owner: true)
        let yaml = File.ReadAllText(output)
        Check.Contains(yaml, "https://api.github.com/repos/obselate/tokate/releases/assets/41")
        Check.Contains(yaml, Installer.Hash(archive))
        Check.Contains(yaml, bundle + "/tokate")
        Check.That(
            !yaml.Contains("@ARCHIVE") && !yaml.Contains("actions/checkout"),
            "Generated workflow contains unresolved pins or repository checkout"
        )
        Flow.Call(args, 1, owner: true)
        File.Delete(output)
        Directory.CreateDirectory(Path.Combine(Flow.Upstream, ".github/workflows"))
        File.WriteAllText(
            Path.Combine(Flow.Upstream, ".github/workflows/tokate-coordinator.yml"),
            "existing owner workflow"
        )
        Flow.Commit("Existing workflow")
        Flow.Call(args, 1, owner: true)
        Check.That(!File.Exists(output), "Existing workflow was replaced")
    }

    internal func TokateExecution() {
        Claim()
        File.WriteAllText(
            Tools,
            "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
        let run = Prepare("tokate")
        Flow.Call([]string{"work", "--run", run})
        Flow.Call([]string{"submit", "--run", run})
        let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
        let path = Event(request)
        Flow.ResetTraffic()
        let result = Coordinate(path, traffic: true)
        Flow.Traffic(31, 4, 19, 0, result)
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        Flow.Reload()
        Check.That(Check.Text(Flow.State["exec_count"]) == "1", "Tokate path did not execute exactly once")
    }

    internal func DeclarationRestrictions() {
        Claim()
        Prepare("tokate", 1)
        let declarations = Check.Json(File.ReadAllText(Tools))
        let tool = declarations[1] ?? throw Exception("Missing mixed tool")
        tool["model"] = JsonValue.Create("disallowed-model")
        File.WriteAllText(Tools, declarations.ToJsonString())
        Prepare(code: 1)
        File.WriteAllText(
            Tools,
            "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
        let run = Prepare("tokate")
        let path = Path.Combine(run, "run.json")
        let saved = Check.Json(File.ReadAllText(path))
        saved["model"] = JsonValue.Create("disallowed-model")
        File.WriteAllText(path, saved.ToJsonString())
        Check.Contains(Flow.Call([]string{"work", "--run", run}, 1).Error, "no model substitution")
        Flow.NoInference()
    }

    internal func Compatibility() {
        using let old = NativeFlow(Flow.Binary)
        old.Initialize()
        old.Approve()
        let run = old.Claim()
        let saved = File.ReadAllText(Path.Combine(run, "run.json"))
        let approval = old.Git("-C", old.Upstream, "rev-parse", "refs/heads/tokate/approvals/1")
        let policyPath = Path.Combine(old.Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(policyPath))
        policy["version"] = JsonValue.Create(2)
        policy["allowed_tools"] = Check.Json("[{\"harness\":\"codex\",\"provider\":\"openai\"}]")
        File.WriteAllText(policyPath, policy.ToJsonString())
        old.Commit("Owner opts in to version 2")
        old.Call([]string{"work", "--run", run}, 1)
        old.Approve()
        Check.That(
            old.Git("-C", old.Upstream, "rev-parse", "refs/heads/tokate/approvals/1") == approval,
            "Version-2 opt-in rewrote version-1 approval"
        )
        Check.That(
            File.ReadAllText(Path.Combine(run, "run.json")) == saved,
            "Opt-in reinterpreted or changed old saved work"
        )
        let state = Check.Json(old.Call([]string{"coordination", "--repo", "owner/project", "--issue", "1"}).Output)
        Check.That(state["state"]?["reservation"] == nil, "Old claim acquired implicit version-2 reservation")
        old.Call([]string{"work", "--run", run}, 1)
        old.NoInference()
    }

    shared {
        internal func ReleaseDownload(args[]string, root string) int32 {
            let state = Check.Json(File.ReadAllText(Path.Combine(root, "state.json")))
            Check.That(
                Environment.GetEnvironmentVariable("GH_TOKEN") == nil && Environment.GetEnvironmentVariable(
                    "GITHUB_TOKEN"
                ) == nil,
                "Coordination credentials reached release download"
            )
            let url = args[args.Length - 1]
            let output = args[Array.IndexOf(args, "--output") + 1]
            if url.EndsWith("/41") {
                File.Copy(Path.Combine(root, "release.tar.gz"), output)
            } else {
                Check.That(url.EndsWith("/42"), "Unexpected immutable release asset URL")
                File.WriteAllText(
                    output,
                    Installer.Hash(Path.Combine(root, "release.tar.gz")) + "  tokate-" + Check.Text(
                        state["release_version"]
                    ) +
                        "-linux-x64.tar.gz\n"
                )
            }
            return 0
        }

        internal func Concurrent(binary string, path string, env Dictionary[string, string], output Chan[Result]) {
            output <- Check.Run(binary, []string{"coordinate", "--repo", "owner/project", "--event", path}, env)
        }

        internal func All(binary string, selected string = "") {
            for name in[]string{
                "SimultaneousClaims",
                "ReplayAndInterruptedState",
                "ExternalPublication",
                "CanonicalExternal",
                "CanonicalSubmit",
                "ExpiryAndRevocation",
                "InvalidEvents",
                "InterruptedWrite",
                "PublicationRevocation",
                "ExpiryDuringPublication",
                "EvictedReplay",
                "SetupRelease",
                "TokateExecution",
                "DeclarationRestrictions",
                "Compatibility"
            } {
                if selected != "" && selected != name {
                    continue
                }
                using let test = CoordinationFlow(binary)
                test.Initialize()
                switch name {
                    case "SimultaneousClaims" {
                        test.SimultaneousClaims()
                    }
                    case "ReplayAndInterruptedState" {
                        test.ReplayAndInterruptedState()
                    }
                    case "ExternalPublication" {
                        test.ExternalPublication()
                    }
                    case "CanonicalExternal" {
                        test.CanonicalExternal()
                    }
                    case "CanonicalSubmit" {
                        test.CanonicalSubmit()
                    }
                    case "ExpiryAndRevocation" {
                        test.ExpiryAndRevocation()
                    }
                    case "InvalidEvents" {
                        test.InvalidEvents()
                    }
                    case "InterruptedWrite" {
                        test.InterruptedWrite()
                    }
                    case "PublicationRevocation" {
                        test.PublicationRevocation()
                    }
                    case "ExpiryDuringPublication" {
                        test.ExpiryDuringPublication()
                    }
                    case "EvictedReplay" {
                        test.EvictedReplay()
                    }
                    case "SetupRelease" {
                        test.SetupRelease()
                    }
                    case "TokateExecution" {
                        test.TokateExecution()
                    }
                    case "DeclarationRestrictions" {
                        test.DeclarationRestrictions()
                    }
                    case "Compatibility" {
                        test.Compatibility()
                    }
                }
                Console.WriteLine("PASS V2 " + name)
            }
        }
    }
}
