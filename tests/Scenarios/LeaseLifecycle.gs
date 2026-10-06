package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal partial class CoordinationFlow : CoordinationFixture {
    internal func LifecycleRequest(action string) JsonNode {
        let request = ClaimRequest()
        request["action"] = JsonValue.Create(action)
        return request
    }

    internal func Lifecycle(action string, code int32 = 0) JsonNode {
        let request = LifecycleRequest(action)
        let file = Path.Combine(Flow.Temp.Root, "lease-" + Check.Text(request["uuid"]) + ".json")
        File.WriteAllText(file, request.ToJsonString())
        Flow.Call([]string{"request", "--repo", "owner/project", "--issue", "1", "--file", file}, code)
        if code == 0 {
            Coordinate(Event(request))
            let applied = Check.Text(State()["sha"])
            Flow.Call([]string{"request", "--repo", "owner/project", "--issue", "1", "--file", file})
            Coordinate(Event(request))
            Check.That(Check.Text(State()["sha"]) == applied, "Lifecycle replay changed authority")
        }
        return request
    }

    internal func LeasePublicationRace() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        Flow.Call([]string{"submit", "--run", run})
        let publish = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
        let pause = LifecycleRequest("pause")
        let publicationEvent = Event(publish)
        let pauseEvent = Event(pause)
        let env = Dictionary[string, string](Flow.Temp.Env)
        env["GH_TOKEN"] = "fixture-owner"
        let output = Chan[Result](2)
        let rendezvous = ClaimRendezvous(publish, pause)
        try {
            go Concurrent(Flow.Binary, publicationEvent, env, output)
            go Concurrent(Flow.Binary, pauseEvent, env, output)
            let a = <-output
            let b = <-output
            Check.That(
                (a.Code == 0 && b.Code == 1) || (a.Code == 1 && b.Code == 0),
                "Publication and pause did not produce one CAS winner: " + a.Error + b.Error
            )
        } finally {
            ClearRendezvous(rendezvous)
        }
        let current = State()
        if Check.Text(current["state"]?["reservation"]?["status"]) == "paused" {
            Check.That(current["state"]?["contribution"] == nil, "Paused worker acquired publication authority")
            Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1, owner: true)
        } else {
            Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        }
        Flow.NoInference()
    }

    internal func LeaseFencing() {
        let policyPath = Path.Combine(Flow.Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(policyPath))
        policy["reservation_seconds"] = JsonValue.Create(300)
        File.WriteAllText(policyPath, policy.ToJsonString())
        Flow.Commit("Owner lease duration")
        Flow.Approve()
        let claim = Claim()
        let run = Prepare()
        let saved = File.ReadAllText(Path.Combine(run, "run.json"))
        let identity = Check.Text(State()["state"]?["identity"]?["id"])
        Lifecycle("renew")
        Check.That(
            File.ReadAllText(Path.Combine(run, "run.json")) == saved,
            "Renewal rewrote saved budgets or execution"
        )
        let late = PublishRequest(claim, String('0', 40))
        Lifecycle("pause")
        Flow.Call([]string{"external", "--run", run, "--commit", String('0', 40)}, 1)
        Coordinate(Event(late), 1)
        let paused = State()
        let expiry = Int64.Parse(Check.Text(paused["state"]?["reservation"]?["expires"]))
        let remaining = expiry - DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        Check.That(remaining > 280 && remaining <= 300, "Pause did not use owner reservation duration")
        Check.That(Check.Text(paused["state"]?["reservation"]?["attempt"]) == "", "Pause retained an attempt fence")
        Lifecycle("resume")
        let fresh = Prepare()
        Check.That(
            fresh != run && File.ReadAllText(Path.Combine(run, "run.json")) == saved,
            "Resume replaced old saved work"
        )
        Check.That(
            Check.Text(State()["state"]?["identity"]?["id"]) == identity,
            "Resume replaced contribution identity"
        )
        Flow.Call([]string{"external", "--run", run, "--commit", String('0', 40)}, 1)
        let staleFence = PublishRequest(claim, String('0', 40))
        let metadata = staleFence["metadata"] ?? throw Exception("Missing metadata")
        metadata["attempt"] = JsonValue.Create(Check.Text(claim["uuid"]))
        Check.Contains(Coordinate(Event(staleFence), 1).Error, "attempt fence")
        Lifecycle("release")
        Flow.Call([]string{"external", "--run", fresh, "--commit", String('0', 40)}, 1)
        let reacquired = ClaimRequest()
        Coordinate(Event(reacquired))
        let state = State()
        Check.That(Check.Text(state["state"]?["identity"]?["id"]) == identity, "Same donor lost identity")
        Check.That(
            Check.Text(state["state"]?["reservation"]?["attempt"]) == Check.Text(reacquired["uuid"]),
            "Reacquisition reused fence"
        )
        let next = Prepare()
        Check.That(next != fresh && next != run, "Reacquisition reused an attempt directory")
        let expiredRenewal = LifecycleRequest("renew")
        Expire()
        Coordinate(Event(expiredRenewal), 1)
        Flow.Call([]string{"external", "--run", next, "--commit", String('0', 40)}, 1)
        let afterExpiry = ClaimRequest()
        Coordinate(Event(afterExpiry))
        Check.That(Check.Text(State()["state"]?["identity"]?["id"]) == identity, "Expiry lost same donor identity")
        Flow.Reload()
        Flow.State["pulls"] = JsonArray(
            Check.Map(
                "number",
                10,
                "base",
                Check.Map("ref", "another-target"),
                "head",
                Check.Map("ref", "tokate/v2-" + identity, "repo", Check.Map("owner", Check.Map("login", "donor")))
            )
        )
        Flow.Save()
        Prepare(code: 1)
        Check.That(
            File.ReadAllText(Path.Combine(run, "run.json")) == saved,
            "Rejected branch reuse changed previous work"
        )
        Flow.Reload()
        Flow.State["pulls"] = nil
        Flow.Save()
        Flow.NoInference()
        Flow.NoPr()
    }

    internal func LeaseReceipts() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        Lifecycle("renew")
        Flow.Call([]string{"submit", "--run", run})
        let request = Check.Json(File.ReadAllText(Path.Combine(run, "request.json")))
        Check.That(
            Check.Text(request["expected"]) == Check.Text(State()["sha"]),
            "Publication did not bind current SHA"
        )
        Coordinate(Event(request))
        let checkout = Path.Combine(run, "checkout")
        File.AppendAllText(Path.Combine(checkout, "result.txt"), "Reviewed amendment\n")
        Flow.Git("-C", checkout, "add", "result.txt")
        Flow.Git(
            "-C",
            checkout,
            "-c",
            "user.name=Donor",
            "-c",
            "user.email=donor@example.test",
            "commit",
            "-m",
            "Reviewed amendment"
        )
        let amendedHead = Flow.Git("-C", checkout, "rev-parse", "HEAD")
        Flow.Call([]string{"amend", "--run", run, "--commit", amendedHead, "--seconds", "30", "--tools", Tools})
        Flow.Reload()
        let amendment = Check.PostedRequest(Flow.State)
        Coordinate(Event(amendment))
        let published = State()
        let original = published["state"]?["contribution"]?.ToJsonString() ?? ""
        let amendments = published["state"]?["amendments"]?.ToJsonString() ?? ""
        for action in[]string{"renew", "pause", "resume", "release"} {
            Lifecycle(action)
            Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            Check.That(
                (State()["state"]?["contribution"]?.ToJsonString() ?? "") == original,
                "Lease transition lost publication evidence"
            )
            Check.That(
                Check.Text(State()["state"]?["publication_revision"]) == Check.Text(published["sha"]),
                "Receipt lost authenticated publication revision"
            )
        }
        Coordinate(Event(ClaimRequest()))
        Prepare(code: 1)
        Expire()
        Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
        Coordinate(Event(ClaimRequest()))
        Check.That(
            (State()["state"]?["contribution"]?.ToJsonString() ?? "") == original,
            "Expiry reacquisition lost publication"
        )
        Flow.NoInference()
    }

    shared {
        private func Executing(binary string, run string, env Dictionary[string, string], output Chan[Result]) {
            output <- TestProcess.Run(binary, []string{"work", "--run", run}, env)
        }
    }

    internal func LeaseExecution(action string = "renew") {
        Claim()
        File.WriteAllText(
            Tools,
            "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
        let run = Prepare("tokate", seconds: "90", reserve: "30")
        let original = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        Flow.Mode("lifecycle_wait")
        let output = Chan[Result](1)
        go Executing(Flow.Binary, run, Flow.Temp.Env, output)
        let marker = Path.Combine(Flow.Bin, "executing")
        let deadline = DateTime.UtcNow.AddSeconds(30)
        while !File.Exists(marker) {
            select {
                case let result = <- output {
                    Check.Success(result)
                    throw Exception("Execution completed without reaching lifecycle rendezvous")
                }
                case <- after(TimeSpan.FromMilliseconds(20)) { }
            }
            Check.That(DateTime.UtcNow < deadline, "Coding did not reach execution rendezvous")
        }
        try {
            Lifecycle(action)
        } finally {
            File.WriteAllText(Path.Combine(Flow.Bin, "continue-execution"), "ready")
        }
        let result = <-output
        if action != "renew" {
            Check.That(result.Code == 1, "Fenced executing worker completed with authority")
            Check.That(
                File.Exists(Path.Combine(run, "checkout/result.txt")),
                "Fencing discarded executing worker edits"
            )
            Flow.Call([]string{"submit", "--run", run}, 1)
            Flow.Reload()
            Check.That(Check.Text(Flow.State["exec_count"]) == "1", "Lifecycle transition started extra inference")
            Flow.NoPr()
            return
        }
        Check.Success(result)
        let completed = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
        for field in[]string{"seconds", "verification_reserve", "attempt", "state_sha"} {
            Check.That(
                Check.Text(completed[field]) == Check.Text(original[field]),
                "Renewal changed execution " + field
            )
        }
        Flow.Reload()
        Check.That(Check.Text(Flow.State["exec_count"]) == "1", "Renewal started extra inference")
        Lifecycle("pause")
        Flow.Call([]string{"submit", "--run", run}, 1)
        Lifecycle("resume")
        Flow.Call([]string{"submit", "--run", run}, 1)
        let fresh = Prepare()
        Check.That(fresh != run, "Resume reused the executing attempt directory")
        Check.That(File.Exists(Path.Combine(run, "changes.patch")), "Fencing lost saved work")
        Flow.NoPr()
    }

    internal func LeaseStalePublication() {
        let claim = Claim()
        let run = Prepare()
        let commit = Candidate(claim)
        Flow.Call([]string{"external", "--run", run, "--commit", commit})
        Flow.Call([]string{"submit", "--run", run})
        let path = Path.Combine(run, "request.json")
        let saved = File.ReadAllText(path)
        let request = Check.Json(saved)
        Lifecycle("renew")
        Flow.Call([]string{"submit", "--run", run})
        Check.That(File.ReadAllText(path) == saved, "Renewal rebound a saved publication UUID")
        Coordinate(Event(request), 1)
        request["expected"] = JsonValue.Create(Check.Text(State()["sha"]))
        File.WriteAllText(path, request.ToJsonString())
        Flow.Call([]string{"request", "--repo", "owner/project", "--issue", "1", "--file", path}, 1)
        File.WriteAllText(path, saved)
        Flow.NoInference()
        Flow.NoPr()
    }

    internal func LeaseReplayAndLegacy() {
        Claim()
        let request = LifecycleRequest("release")
        let path = Event(request)
        Flow.Mode("lost_state_response")
        Check.Contains(Coordinate(path, 1).Error, "exact UUID outcome is recorded")
        let applied = State()
        Coordinate(path)
        Check.That(Check.Text(State()["sha"]) == Check.Text(applied["sha"]), "Lost response replay wrote state")
        let changed = request.DeepClone()
        changed["action"] = JsonValue.Create("renew")
        Coordinate(Event(changed), 1)
        Coordinate(Event(request, 124), 1)
        Coordinate(Event(ClaimRequest()))
        let legacy = State()["state"] ?? throw Exception("Missing state")
        legacy.AsObject().Remove("identity")
        let reservation = legacy["reservation"] ?? throw Exception("Missing reservation")
        reservation.AsObject().Remove("status")
        reservation.AsObject().Remove("attempt")
        RewriteState(legacy)
        for action in[]string{"renew", "pause", "resume", "release"} {
            Coordinate(Event(LifecycleRequest(action)), 1)
        }
        Expire()
        Coordinate(Event(ClaimRequest()), 1)
        Flow.NoInference()
        Flow.NoPr()
    }

    internal func LeaseTakeover() {
        Flow.Call([]string{"access", "--repo", "owner/project", "--operation", "init"}, owner: true)
        let path = Path.Combine(Flow.Upstream, ".github/tokate.json")
        let policy = Check.Json(File.ReadAllText(path))
        policy["approval_scope"] = JsonValue.Create("task")
        policy["eligibility"] = JsonValue.Create("open")
        File.WriteAllText(path, policy.ToJsonString())
        Flow.Commit("Task scope")
        Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, owner: true)
        let claim = ClaimRequest()
        Coordinate(Event(claim))
        let identity = Check.Text(State()["state"]?["identity"]?["id"])
        Flow.Call([]string{"access", "--repo", "owner/project", "--operation", "deny", "--donor", "donor"}, owner: true)
        for action in[]string{"renew", "pause", "resume"} {
            Coordinate(Event(LifecycleRequest(action)), 1)
        }
        let released = LifecycleRequest("release")
        Coordinate(Event(released, 124), 1)
        Lifecycle("release")
        Flow.Call(
            []string{"access", "--repo", "owner/project", "--operation", "restore", "--donor", "donor"},
            owner: true
        )
        Coordinate(Event(ClaimRequest()))
        Expire()
        let predecessor = State()
        let other = ClaimRequest()
        Coordinate(Event(other, 124, "other"))
        let current = State()
        Check.That(Check.Text(current["state"]?["identity"]?["id"]) != identity, "Different donor adopted identity")
        Check.That(
            Check.Text(current["state"]?["identity"]?["predecessor"]?["revision"]) == Check.Text(predecessor["sha"]),
            "Takeover lost immutable predecessor"
        )
        Check.That(
            Check.Text(current["state"]?["identity"]?["predecessor"]?["id"]) == identity,
            "Takeover predecessor differs"
        )
        Coordinate(Event(released), 1)
        Expire()
        let before = State()["state"]?["outcomes"]?.AsArray().Count ?? 0
        let first = ClaimRequest()
        let second = ClaimRequest()
        let path1 = Event(first)
        let path2 = Event(second)
        let env = Dictionary[string, string](Flow.Temp.Env)
        env["GH_TOKEN"] = "fixture-owner"
        let output = Chan[Result](2)
        let rendezvous = ClaimRendezvous(first, second)
        try {
            go Concurrent(Flow.Binary, path1, env, output)
            go Concurrent(Flow.Binary, path2, env, output)
            let a = <-output
            let b = <-output
            Check.That(
                (a.Code == 0 && b.Code == 1) || (a.Code == 1 && b.Code == 0),
                "Simultaneous expiry takeover had no unique winner: " + a.Error + b.Error
            )
            Check.That(
                State()["state"]?["outcomes"]?.AsArray().Count == before + 1,
                "Simultaneous takeover recorded two outcomes"
            )
        } finally {
            ClearRendezvous(rendezvous)
        }
        Flow.NoInference()
        Flow.NoPr()
    }
}
