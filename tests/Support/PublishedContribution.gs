package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class PublishedContribution : IDisposable {
    internal let Coordination CoordinationFixture
    internal let Run string
    private let Snapshot FixtureSnapshot
    private let Environment Dictionary[string, string]
    private let Comment int32

    private init(coordination CoordinationFixture, run string) {
        Coordination = coordination
        Run = run
        Environment = Dictionary[string, string](coordination.Flow.Temp.Env)
        Comment = coordination.Comment
        Snapshot = FixtureSnapshot(coordination.Flow.Temp.Root)
    }

    shared {
        internal func Create(
            binary string,
            external bool = false,
            synchronization bool = false,
            baseBranch string = "",
            mutating bool = false
        ) PublishedContribution {
            let coordination = CoordinationFixture(binary)
            try {
                let run = external ? PublishRun(
                    coordination,
                    synchronization: synchronization,
                    baseBranch: baseBranch
                ): Original(
                    coordination.Flow,
                    mutating: mutating,
                    synchronization: synchronization,
                    baseBranch: baseBranch
                )
                coordination.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                return PublishedContribution(coordination, run)
            } catch (error Exception) {
                coordination.Dispose()
                throw error
            }
        }

        internal func Original(
            flow NativeFixture,
            owner bool = false,
            mutating bool = false,
            interruptible bool = false,
            synchronization bool = false,
            baseBranch string = ""
        ) string {
            flow.Initialize()
            if synchronization {
                SetupOwner(flow)
            }
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["verification"] = Check.Json(
                "[[\"/bin/sh\",\"-c\",\"test -f result.txt\"],[\"/bin/sh\",\"-c\",\"test -s result.txt\"]]"
            )
            if interruptible {
                policy["verification"] = Check.Json(
                    "[[\"/bin/sh\",\"-c\",\"printf 'synthetic-%s-prior' amendment; test -f result.txt\"],[\"/bin/sh\",\"-c\",\"if test -f slow; then printf 'synthetic-%s-prefix' amendment; printf 'synthetic-%s-error' amendment >&2; sleep 3; fi; test -s result.txt\"]]"
                )
            }
            if mutating {
                policy["verification"] = Check.Json(
                    "[[\"/bin/sh\",\"-c\",\"test -f result.txt; if test -f mutate; then printf changed >> result.txt; fi\"]]"
                )
            }
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Owner checks")
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, "main")
            if baseBranch != "" {
                flow.Git("-C", flow.Upstream, "branch", baseBranch)
            }
            flow.Approve(baseBranch)
            let claimed = flow.Acquire(flow.ClaimArgs(seconds: "20"), owner: owner)
            let run = claimed.Output.Substring(claimed.Output.LastIndexOf("Run: ") + 5).Trim()
            flow.Call([]string{"work", "--run", run}, owner: owner)
            flow.Publish(run)
            return run
        }

        internal func PublishRun(
            flow CoordinationFixture,
            native bool = false,
            modelPolicy string = "",
            synchronization bool = false,
            baseBranch string = ""
        ) string {
            flow.Initialize(approve: false)
            if synchronization {
                SetupOwner(flow.Flow)
                if baseBranch != "" {
                    flow.Flow.Git("-C", flow.Flow.Upstream, "branch", baseBranch)
                }
            }
            if modelPolicy != "" {
                let path = Path.Combine(flow.Flow.Upstream, ".github/tokate.json")
                let policy = Check.Json(File.ReadAllText(path))
                policy["model_policy"] = JsonValue.Create(modelPolicy)
                if modelPolicy == "unrestricted" {
                    policy.AsObject().Remove("models")
                } else {
                    (policy["models"] ?? throw Exception("Missing model whitelist"))["claude-sonnet-4-6"] = Check.Json(
                        "[\"absent\"]"
                    )
                }
                File.WriteAllText(path, policy.ToJsonString())
                flow.Flow.Commit("External amendment effort policy")
            }
            flow.Flow.Approve(baseBranch)
            let claim = flow.ClaimRequest()
            flow.Coordinate(flow.Event(claim))
            if native {
                File.WriteAllText(
                    flow.Tools,
                    "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
                )
            }
            let run = flow.Prepare(native ? "tokate": "external")
            if native {
                flow.Flow.Call([]string{"work", "--run", run})
            } else {
                let commit = flow.Candidate(claim)
                flow.Flow.Call(
                    []string{
                        "external",
                        "--run",
                        run,
                        "--commit",
                        commit,
                        "--summary",
                        Summary(flow.Flow, commit, "Add a result containing the external contribution text.")
                    }
                )
            }
            flow.Flow.Call([]string{"submit", "--run", run})
            flow.Flow.Reload()
            let request = Check.PostedRequest(flow.Flow.State)
            flow.Coordinate(flow.Event(request))
            let contribution = flow.State()["state"]?["contribution"] ?? throw Exception("Missing contribution")
            Check.That(
                Check.Text(contribution["actor"]) == "123" && Check.Text(contribution["donor"]) == "donor" &&
                    Check.Text(contribution["metadata"]?["fork"]) == "donor/project",
                "Task publication lost canonical numeric donor and fork"
            )
            flow.Flow.Reload()
            Check.That(flow.Flow.State["issue"]?["assignees"]?.AsArray().Count == 0, "Task fixture assigned donor")
            return run
        }

        internal func Summary(flow NativeFixture, commit string, change string) string {
            let path = Path.Combine(flow.Temp.Root, "public-summary-" + Guid.NewGuid().ToString("N") + ".json")
            File.WriteAllText(
                path,
                Check.Map(
                    "head",
                    JsonValue.Create(commit),
                    "changes",
                    Check.Json("[\"" + change + "\"]"),
                    "verification",
                    Check.Json("[\"Fixture content check passed.\"]"),
                    "limitations",
                    Check.Json("[]")
                )
                    .ToJsonString()
            )
            return path
        }

        private func SetupOwner(flow NativeFixture) {
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["protected_paths"] = Check.Json("[\"protected/\",\"guard/missing\",\"new-parent/missing\"]")
            policy["verification"] = Check.Json(
                "[[\"/bin/sh\",\"-c\",\"test -f result.txt\"],[\"/bin/sh\",\"-c\",\"test -s result.txt && ! grep -q BAD result.txt\"]]"
            )
            File.WriteAllText(policyPath, policy.ToJsonString())
            Write(flow.Upstream, ".github/workflows/verify.yml", "timeout-minutes: 15\n")
            Write(flow.Upstream, ".github/workflows/old.yml", "old workflow\n")
            Write(flow.Upstream, "protected/content", "owner data\n")
            Write(flow.Upstream, "protected/gone", "remove upstream\n")
            Write(flow.Upstream, "protected/link", "regular upstream\n")
            Write(flow.Upstream, "guard/other", "nonprotected sibling\n")
            Write(flow.Upstream, "DECREE.md", "Approved owner instructions\n")
            Write(flow.Upstream, "shared.txt", "original shared line\n")
            flow.Commit("Approved protected fixtures")
        }

        internal func Write(root string, path string, text string) {
            let file = Path.Combine(root, path)
            Directory.CreateDirectory(Path.GetDirectoryName(file) ?? root)
            File.WriteAllText(file, text)
        }
    }

    internal func Restore() {
        Snapshot.Restore()
        let flow = Coordination.Flow
        flow.Temp.Env.Clear()
        for entry in Environment {
            flow.Temp.Env[entry.Key] = entry.Value
        }
        flow.Reload()
        Coordination.Comment = Comment
    }

    public func Dispose() {
        try {
            Snapshot.Dispose()
        } finally {
            Coordination.Dispose()
        }
    }
}
