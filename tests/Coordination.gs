package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
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

    internal func ClaimRendezvous(first JsonNode, second JsonNode, timeout int32 = 10000) string {
        Check.That(Check.Text(first["expected"]) == Check.Text(second["expected"]), "Claims must share expected state")
        let directory = Path.Combine(Flow.Temp.Root, "claim-rendezvous-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        File.WriteAllText(
            Path.Combine(Flow.Bin, "claim-rendezvous.json"),
            Check.Map(
                "directory",
                directory,
                "expected",
                Check.Text(first["expected"]),
                "first",
                Check.Text(first["uuid"]),
                "second",
                Check.Text(second["uuid"]),
                "timeout_ms",
                timeout
            )
                .ToJsonString()
        )
        return directory
    }

    internal func ClearRendezvous(directory string) {
        File.Delete(Path.Combine(Flow.Bin, "claim-rendezvous.json"))
        Directory.Delete(directory, true)
    }

    internal func SimultaneousClaimsMissingParticipant() {
        let first = ClaimRequest()
        let second = ClaimRequest()
        let path = Event(first)
        let directory = ClaimRendezvous(first, second, 1000)
        let clock = Stopwatch.StartNew()
        try {
            let result = Coordinate(path, 1)
            Check.Contains(result.Error, "GitHub mutation failed")
            let failure = File.ReadAllText(Path.Combine(directory, Check.Text(first["uuid"]) + ".failed"))
            Check.Contains(failure, "Claim rendezvous timed out: " + Check.Text(first["uuid"]))
            Check.Contains(failure, "missing " + Check.Text(second["uuid"]) + ".arrived")
            Check.That(
                clock.ElapsedMilliseconds < 10000,
                "Missing participant did not fail within the bounded deadline"
            )
            Check.That(
                File.Exists(Path.Combine(directory, Check.Text(first["uuid"]) + ".arrived")),
                "Claim never arrived"
            )
            Check.That(
                !File.Exists(Path.Combine(directory, Check.Text(second["uuid"]) + ".arrived")),
                "Absent claim arrived"
            )
            Check.That(Check.Text(State()["sha"]) == Check.Text(first["expected"]), "Timed-out claim changed authority")
            Flow.Reload()
            for call in Flow.State["api_calls"]?.AsArray() ?? throw Exception("Missing API evidence") {
                Check.That(
                    Check.Text(call["method"]) != "PATCH" || Check.Text(call["path"]) !=
                    "repos/owner/project/git/refs/heads/tokate/contributions/1",
                    "Timed-out rendezvous reached the shared API-state lock"
                )
            }
        } finally {
            ClearRendezvous(directory)
        }
        Check.That(!Directory.Exists(directory), "Timed-out rendezvous markers were not cleaned up")
        Claim()
        Flow.NoInference()
    }

    internal func SimultaneousClaims() {
        let first = ClaimRequest()
        let second = ClaimRequest()
        let path1 = Event(first)
        let path2 = Event(second)
        let env = Dictionary[string, string](Flow.Temp.Env)
        env["GH_TOKEN"] = "fixture-owner"
        let output = Chan[Result](2)
        let directory = ClaimRendezvous(first, second)
        var a Result
        var b Result
        try {
            go Concurrent(Flow.Binary, path1, env, output)
            go Concurrent(Flow.Binary, path2, env, output)
            a = <-output
            b = <-output
            for request in[]JsonNode{first, second} {
                let failure = Path.Combine(directory, Check.Text(request["uuid"]) + ".failed")
                if File.Exists(failure) {
                    throw Exception(File.ReadAllText(failure))
                }
                Check.That(
                    File.Exists(Path.Combine(directory, Check.Text(request["uuid"]) + ".arrived")),
                    "Claim did not reach rendezvous: " + Check.Text(request["uuid"]) + "\n" + a.Error + b.Error
                )
            }
        } finally {
            ClearRendezvous(directory)
        }
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
            "Concurrent claims did not exercise the non-forced competing ref updates: PATCH attempts=" +
                attempts.ToString() + ", 422 rejections=" + rejected.ToString()
        )
        Coordinate(Event(ClaimRequest(), 124, "other"), 1)
        Flow.NoInference()
    }

    internal func Prepare(
        source string = "external",
        code int32 = 0,
        seconds string = "30",
        network bool = false
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

    internal func ProtectedExternal() {
        Flow.ProtectedPolicy()
        Flow.Approve()
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim, "entrypoint")
        Check.Contains(
            Flow.Call([]string{"external", "--run", run, "--commit", commit}, 1).Error,
            "protected owner path"
        )
        Check.That(
            File.ReadAllText(Path.Combine(run, "checkout/scripts/verify.sh")) == "exit 0\n",
            "External work lost"
        )
        Check.That(!File.Exists(Path.Combine(run, "verification.json")), "External replaced verifier ran")
        let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Check.That(
            Check.Text(saved["commit"]) == commit && Check.Text(saved["state"]) == "failed",
            "External failure lost its exact commit"
        )
        Check.Contains(Check.Text(saved["error"]), "protected owner path")
        Flow.Call([]string{"submit", "--run", run}, 1)
        Flow.NoPr()
        Flow.NoInference()
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
                "donor-reported-pass"
            )
        )
    }

    internal func ProtectedCoordinator() {
        for change in[]string{
            "entrypoint",
            "rename-out",
            "rename-in",
            "directory-node",
            "mode",
            "type",
            "newline",
            "permitted"
        } {
            using let test = CoordinationFlow(Flow.Binary)
            test.Initialize()
            test.Flow.ProtectedPolicy()
            test.Flow.Approve()
            let claim = test.Claim()
            let commit = test.Candidate(claim, change)
            let publication = test.PublishRequest(claim, commit)
            if change == "permitted" {
                test.Coordinate(test.Event(publication))
                test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            } else {
                Check.Contains(test.Coordinate(test.Event(publication), 1).Error, "protected owner path")
                test.Flow.NoPr()
                Check.That(test.State()["state"]?["contribution"] == nil, "Protected contribution gained authority")
            }
            test.Flow.NoInference()
        }
    }

    internal func ProtectedManaged() {
        Flow.ProtectedPolicy()
        Flow.Approve()
        Claim()
        File.WriteAllText(
            Tools,
            "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
        let run = Prepare("tokate")
        Flow.Mode("protected_entrypoint")
        Check.Contains(Flow.Call([]string{"work", "--run", run}, 1).Error, "protected owner path")
        Flow.Call([]string{"submit", "--run", run}, 1)
        Flow.NoPr()
    }

    internal func ReceiptEvidence() {
        Flow.ProtectedPolicy()
        Flow.Approve()
        let claim = Claim()
        let commit = Candidate(claim, "permitted")
        Coordinate(Event(PublishRequest(claim, commit)))
        Flow.MetadataOnly()
        for fault in[]string{
            "missing-files",
            "truncated-files",
            "wrong-base",
            "wrong-head",
            "missing-previous",
            "missing-status",
            "missing-commits"
        } {
            Flow.DiffFault("diff_fault", fault)
            Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        }
        Flow.DiffFault("diff_fault", "")
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        let checkout = Path.Combine(Flow.Temp.Root, "donor-work")
        let marker = Path.Combine(checkout, "receipt-code-ran")
        File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "touch '" + marker + "'\nexit 0\n")
        Flow.Git("-C", checkout, "add", "-A")
        Flow.Git(
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
        let head = Flow.Git("-C", checkout, "rev-parse", "HEAD")
        Flow.Git(
            "-C",
            checkout,
            "push",
            Path.Combine(Flow.Bin, "fork"),
            "HEAD:refs/heads/tokate/v2-" + Check.Text(claim["uuid"])
        )
        let state = State()
        let value = state["state"] ?? throw Exception("Missing state")
        let contribution = value["contribution"] ?? throw Exception("Missing contribution")
        let metadata = contribution["metadata"] ?? throw Exception("Missing metadata")
        let expected = Check.Text(contribution["expected"])
        contribution["expected"] = JsonValue.Create(Check.Text(state["sha"]))
        metadata["head"] = JsonValue.Create(head)
        let outcome = contribution["outcome"] ?? throw Exception("Missing contribution outcome")
        outcome["head"] = JsonValue.Create(head)
        RewriteState(value)
        Flow.Reload()
        let pull = Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
        let prHead = pull["head"] ?? throw Exception("Missing PR head")
        prHead["sha"] = JsonValue.Create(head)
        pull["body"] = JsonValue.Create(
            Check
                .Text(pull["body"])
                .Replace(commit, head, StringComparison.Ordinal)
                .Replace(expected, Check.Text(state["sha"]), StringComparison.Ordinal)
        )
        Flow.Save()
        Check.Contains(
            Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true).Error,
            "protected owner path"
        )
        Flow.NoInference()
        Check.That(!File.Exists(marker), "Read-only validation executed PR code")
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
        Flow.CommitIdentity(Path.Combine(run, "checkout"), commit, "Donor", "donor@example.test")
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
        Check.Contains(failure.Error, "protected owner configuration")
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
        Flow.CommitIdentity(
            Path.Combine(Flow.Bin, "fork"),
            Check.Text(request["metadata"]?["head"]),
            "donor",
            "tokate@users.noreply.github.com"
        )
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

    internal func ModelPolicyModes() {
        for mode in[]string{"", "whitelist", "unrestricted"} {
            using let test = CoordinationFlow(Flow.Binary)
            test.Initialize()
            test.Flow.SetModelPolicy(mode, mode == "unrestricted" ? "omit": "")
            test.Flow.Approve()
            test.Claim()
            let original = Check.Json(File.ReadAllText(test.Tools))
            for index in 0 ... original.AsArray().Count {
                let changed = original.DeepClone()
                let tool = changed[index] ?? throw Exception("Missing declared tool")
                for field in[]string{"model", "effort", "harness", "provider"} {
                    let value = tool[field]?.DeepClone()
                    tool[field] = JsonValue.Create(field == "effort" ? "invalid": "unlisted-value")
                    File.WriteAllText(test.Tools, changed.ToJsonString())
                    if mode == "unrestricted" && field == "model" {
                        continue
                    }
                    test.Prepare(code: 1)
                    tool[field] = value
                }
            }
            File.WriteAllText(test.Tools, original.ToJsonString())
            test.Prepare(code: 1, seconds: "3601")
            test.Prepare(code: 1, network: true)
            test.Prepare("tokate", 1)
            if mode == "unrestricted" {
                let first = original[0] ?? throw Exception("Missing first tool")
                let second = original[1] ?? throw Exception("Missing second tool")
                first["model"] = JsonValue.Create("unlisted-claude-model")
                second["model"] = JsonValue.Create("unlisted-codex-model")
                File.WriteAllText(test.Tools, original.ToJsonString())
            }
            test.ExternalPublicationAfterClaim()
        }
    }

    internal func ExternalPublicationAfterClaim() {
        let state = State()
        let reservation = Check.Text(state["state"]?["reservation"]?["reservation"])
        let claim = Check.Map("uuid", reservation)
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        Flow.Call([]string{"submit", "--run", run})
        let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
        let metadata = request["metadata"] ?? throw Exception("Missing publication metadata")
        let declared = metadata["tools"]?.DeepClone() ?? throw Exception("Missing declared tools")
        let policyPath = Path.Combine(Flow.Upstream, ".github/tokate.json")
        let unrestricted = Check.Text(Check.Json(File.ReadAllText(policyPath))["model_policy"]) == "unrestricted"
        for index in 0 ... declared.AsArray().Count {
            let tools = declared.DeepClone()
            let tool = tools[index] ?? throw Exception("Missing declared tool")
            tool[unrestricted ? "effort": "model"] = JsonValue.Create(unrestricted ? "invalid": "disallowed-model")
            metadata["tools"] = tools
            Coordinate(Event(request), 1)
            Flow.NoPr()
        }
        metadata["tools"] = declared.DeepClone()
        let source = Check.Text(metadata["source"])
        metadata["source"] = JsonValue.Create("tokate")
        Coordinate(Event(request), 1)
        Flow.NoPr()
        metadata["source"] = JsonValue.Create(source)
        Coordinate(Event(request))
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        for index in 0 ... declared.AsArray().Count {
            ReceiptRefusal(index, unrestricted ? "effort": "model", unrestricted ? "invalid": "disallowed-model")
        }
        let published = State()
        let saved = File.ReadAllText(Path.Combine(run, "run.json"))
        Flow.Reload()
        let pulls = Flow.State["pulls"]?.ToJsonString() ?? ""
        Flow.SetModelPolicy(
            unrestricted ? "whitelist": "unrestricted",
            unrestricted ?
            "{\"gpt-6.1-sol\":[\"high\"]}": "omit"
        )
        Check.Contains(Flow.Call([]string{"submit", "--run", run}, 1).Error, "stale coordination authority")
        Check.Contains(
            Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, true).Error,
            "Repository policy or template changed. The owner must approve again."
        )
        Check.That(
            Check.Text(State()["sha"]) == Check.Text(published["sha"]),
            "Policy edit rewrote coordination authority"
        )
        Flow.Reload()
        Check.That(
            File.ReadAllText(Path.Combine(run, "run.json")) == saved && Flow.State["pulls"]?.ToJsonString() == pulls,
            "Policy edit rewrote saved contribution or receipt"
        )
        Flow.NoInference()
    }

    internal func ReceiptRefusal(index int32, field string, value string) {
        let original = State()
        let previous = Check.Text(original["sha"])
        let state = original["state"] ?? throw Exception("Missing state")
        let contribution = state["contribution"] ?? throw Exception("Missing contribution")
        let declaration = contribution["metadata"]?["tools"]?[index] ?? throw Exception("Missing receipt tool")
        declaration[field] = JsonValue.Create(value)
        contribution["expected"] = JsonValue.Create(previous)
        RewriteState(state)
        let forged = Check.Text(State()["sha"])
        Flow.Reload()
        let pull = Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
        let body = Check.Text(pull["body"])
        let prefix = "<!-- tokate-receipt:"
        let start = body.IndexOf(prefix, StringComparison.Ordinal) + prefix.Length
        let end = body.IndexOf(" -->", start, StringComparison.Ordinal)
        let receipt = Check.Json(body.Substring(start, end - start))
        receipt["expected"] = JsonValue.Create(previous)
        pull["body"] = JsonValue.Create(body.Substring(0, start) + receipt.ToJsonString() + body.Substring(end))
        Flow.Save()
        let failure = Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, true)
        Check.That(
            failure.Error.Contains("Model/effort pair") || failure.Error.Contains("reasoning effort") ||
                failure
                .Error
                .Contains("supported effort control"),
            "Receipt did not reach shared declaration validation: " + failure.Error
        )
        Flow.Git("-C", Flow.Upstream, "update-ref", "refs/heads/tokate/contributions/1", previous, forged)
        Flow.Reload()
        let restored = Flow.State["pulls"]?[0] ?? throw Exception("Missing PR")
        restored["body"] = JsonValue.Create(body)
        Flow.Save()
    }

    internal func EffortDeclarations() {
        for mode in[]string{"", "whitelist", "unrestricted"} {
            using let test = CoordinationFlow(Flow.Binary)
            test.Initialize()
            test.Flow.SetModelPolicy(
                mode,
                mode == "unrestricted" ? "{}":
                "{\"gpt-6.1-sol\":[\"high\",\"unknown\"],\"claude-sonnet-4-6\":[\"unknown\"]}"
            )
            test.Flow.Approve()
            test.Claim()
            let tool = Check.Json(
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"unknown\"}]"
            )
            let declaration = tool[0] ?? throw Exception("Missing tool")
            File.WriteAllText(test.Tools, tool.ToJsonString())
            test.Prepare("tokate", 1)
            let run = test.Prepare()
            let savedPath = Path.Combine(run, "run.json")
            let saved = File.ReadAllText(savedPath)
            Check.That(
                Check.Text(Check.Json(saved)["tools"]?[0]?["effort"]) == "unknown",
                "Legacy unknown was reinterpreted"
            )
            let changed = Check.Json(saved)
            changed["source"] = JsonValue.Create("tokate")
            changed["model"] = JsonValue.Create("gpt-6.1-sol")
            changed["effort"] = JsonValue.Create("unknown")
            File.WriteAllText(savedPath, changed.ToJsonString())
            test.Flow.Call([]string{"work", "--run", run}, 1)
            File.WriteAllText(savedPath, saved)
            for effort in[]string{"absent", "", "null", "invalid", "high,xhigh"} {
                declaration["effort"] = effort == "null" ? nil: JsonValue.Create(effort)
                if effort == "" {
                    declaration.AsObject().Remove("effort")
                }
                File.WriteAllText(test.Tools, tool.ToJsonString())
                test.Prepare("tokate", 1)
                if mode != "unrestricted" || effort != "absent" {
                    test.Prepare(code: 1)
                }
            }
            test.Flow.NoInference()
            Check.That(File.ReadAllText(savedPath) == saved, "Rejected effort changed legacy saved work")
        }
        for mode in[]string{"whitelist", "unrestricted"} {
            using let test = CoordinationFlow(Flow.Binary)
            test.Initialize()
            test.Flow.SetModelPolicy(
                mode,
                mode == "unrestricted" ? "omit":
                "{\"gpt-6.1-sol\":[\"absent\"],\"claude-sonnet-4-6\":[\"unknown\",\"absent\"]}"
            )
            test.Flow.Approve()
            test.Claim()
            let tools = Check.Json(File.ReadAllText(test.Tools))
            let declaration = tools[1] ?? throw Exception("Missing tool")
            declaration["effort"] = JsonValue.Create("absent")
            File.WriteAllText(test.Tools, tools.ToJsonString())
            test.ExternalPublicationAfterClaim()
        }
    }

    internal func ManagedModelPolicy() {
        for mode in[]string{"whitelist", "unrestricted"} {
            using let test = CoordinationFlow(Flow.Binary)
            test.Initialize()
            test.Flow.SetModelPolicy(
                mode,
                mode == "unrestricted" ? "{}":
                "{\"gpt-6-sol\":[\"high\",\"unknown\",\"absent\"]}"
            )
            test.Flow.Approve()
            test.Claim()
            let tools = Check.Json(
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6-sol\",\"effort\":\"absent\"}]"
            )
            let declaration = tools[0] ?? throw Exception("Missing tool")
            File.WriteAllText(test.Tools, tools.ToJsonString())
            test.Prepare("tokate", 1)
            declaration["effort"] = JsonValue.Create("unknown")
            File.WriteAllText(test.Tools, tools.ToJsonString())
            test.Prepare("tokate", 1)
            declaration["effort"] = JsonValue.Create("high")
            File.WriteAllText(test.Tools, tools.ToJsonString())
            let run = test.Prepare("tokate")
            let path = Path.Combine(run, "run.json")
            let original = File.ReadAllText(path)
            let changed = Check.Json(original)
            changed["effort"] = JsonValue.Create("absent")
            let savedTool = changed["tools"]?[0] ?? throw Exception("Missing saved tool")
            savedTool["effort"] = JsonValue.Create("absent")
            File.WriteAllText(path, changed.ToJsonString())
            test.Flow.Call([]string{"work", "--run", run}, 1)
            test.Flow.NoInference()
            File.WriteAllText(path, original)
            test.Flow.Call([]string{"work", "--run", run})
            test.Flow.Call([]string{"submit", "--run", run})
            let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
            let requestedTool = request["metadata"]?["tools"]?[0] ?? throw Exception("Missing requested tool")
            requestedTool["effort"] = JsonValue.Create("absent")
            test.Coordinate(test.Event(request), 1)
            test.Flow.NoPr()
            requestedTool["effort"] = JsonValue.Create("high")
            test.Coordinate(test.Event(request))
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            test.ReceiptRefusal(0, "effort", "absent")
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["requested_model"]) == "gpt-6-sol" && Check.Text(
                    test.Flow.State["requested_effort"]
                ) == "model_reasoning_effort=\"high\"",
                "Managed declaration silently changed"
            )
        }
    }

    internal func ModelPolicyAuthority() {
        for mode in[]string{"whitelist", "unrestricted"} {
            using let test = CoordinationFlow(Flow.Binary)
            test.Initialize()
            test.Claim()
            let run = test.Prepare()
            let path = Path.Combine(run, "run.json")
            let saved = File.ReadAllText(path)
            let original = test.State()
            test.Flow.SetModelPolicy(mode, mode == "unrestricted" ? "omit": "")
            Check.Contains(
                test.Flow.Call([]string{"external", "--run", run, "--commit", String('0', 40)}, 1).Error,
                "Repository policy or template changed. The owner must approve again."
            )
            Check.That(
                Check.Text(test.State()["sha"]) == Check.Text(original["sha"]),
                "Mode change rewrote existing approval or reservation"
            )
            test.Flow.Approve()
            Check.That(File.ReadAllText(path) == saved, "Fresh approval converted saved work")
            test.Flow.Call([]string{"external", "--run", run, "--commit", String('0', 40)}, 1)
            test.Flow.NoInference()
            test.Flow.NoPr()
        }
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
        let models = policy["models"]?.ToJsonString() ?? ""
        policy["version"] = JsonValue.Create(2)
        policy["allowed_tools"] = Check.Json("[{\"harness\":\"codex\",\"provider\":\"openai\"}]")
        File.WriteAllText(policyPath, policy.ToJsonString())
        old.Commit("Owner opts in to version 2")
        old.Call([]string{"work", "--run", run}, 1)
        old.Approve()
        Check.That(
            Check.Json(File.ReadAllText(policyPath))["models"]?.ToJsonString() == models &&
                Check.Json(File.ReadAllText(policyPath))["model_policy"] == nil,
            "Version upgrade changed legacy whitelist restrictions"
        )
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
            var matched bool
            for name in[]string{
                "SimultaneousClaims",
                "SimultaneousClaimsMissingParticipant",
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
                "ModelPolicyModes",
                "EffortDeclarations",
                "ManagedModelPolicy",
                "ModelPolicyAuthority",
                "Compatibility",
                "ProtectedExternal",
                "ProtectedCoordinator",
                "ProtectedManaged",
                "ReceiptEvidence"
            } {
                if selected != "" && selected != name {
                    continue
                }
                matched = true
                using let test = CoordinationFlow(binary)
                test.Initialize()
                switch name {
                    case "SimultaneousClaims" {
                        test.SimultaneousClaims()
                    }
                    case "SimultaneousClaimsMissingParticipant" {
                        test.SimultaneousClaimsMissingParticipant()
                    }
                    case "ReplayAndInterruptedState" {
                        test.ReplayAndInterruptedState()
                    }
                    case "ExternalPublication" {
                        test.ExternalPublication()
                    }
                    case "ProtectedExternal" {
                        test.ProtectedExternal()
                    }
                    case "ProtectedCoordinator" {
                        test.ProtectedCoordinator()
                    }
                    case "ProtectedManaged" {
                        test.ProtectedManaged()
                    }
                    case "ReceiptEvidence" {
                        test.ReceiptEvidence()
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
                    case "ModelPolicyModes" {
                        test.ModelPolicyModes()
                    }
                    case "EffortDeclarations" {
                        test.EffortDeclarations()
                    }
                    case "ManagedModelPolicy" {
                        test.ManagedModelPolicy()
                    }
                    case "ModelPolicyAuthority" {
                        test.ModelPolicyAuthority()
                    }
                    case "Compatibility" {
                        test.Compatibility()
                    }
                }
                test.Flow.AutomationAttribution()
                Console.WriteLine("PASS V2 " + name)
            }
            Check.That(matched, "Unknown coordination selector: " + selected)
        }
    }
}
