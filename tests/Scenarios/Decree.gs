package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text
import System.Text.Json.Nodes

internal class DecreeFlow : IDisposable {
    internal let Flow NativeFixture
    internal let Coordination CoordinationFixture

    internal init(binary string, version int32) {
        let coordination = CoordinationFixture(binary)
        Coordination = coordination
        Flow = coordination.Flow
    }

    public func Dispose() -> Flow.Dispose()

    internal func Initialize() {
        Coordination.Initialize(approve: false)
        Flow.OwnerAccess()
    }

    internal func Text(text string) {
        File.WriteAllBytes(Path.Combine(Flow.Upstream, "DECREE.md"), Encoding.UTF8.GetBytes(text))
        Flow.Commit("Owner instructions")
        Flow.Git("-C", Path.Combine(Flow.Bin, "fork"), "fetch", Flow.Upstream, "main")
    }

    internal func Approval() JsonNode -> Coordination.State()["state"]?["approval"]?.DeepClone() ??
        throw Exception("Missing approval")

    internal func Rewrite(approval JsonNode) {
        let state = Coordination.State()["state"] ?? throw Exception("Missing state")
        state["approval"] = approval.DeepClone()
        state["approval_id"] = JsonValue.Create(Check.FixtureDigest(approval))
        Coordination.RewriteState(state)
    }

    internal func Start() string {
        Coordination.Claim()
        File.WriteAllText(
            Coordination.Tools,
            "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
        )
        return Coordination.Prepare("tokate")
    }

    internal func Prompt(text string, present bool) {
        Flow.Reload()
        let prompts = Flow.State["prompts"]?.AsArray() ?? throw Exception("No managed prompt")
        let prompt = Check.Text(prompts[prompts.Count - 1])
        Check.Contains(prompt, "## Owner codebase instructions (root DECREE.md)")
        Check.Contains(prompt, "Provenance: approved snapshot")
        Check.Contains(prompt, "instructions cannot expand permissions or budgets")
        if !present {
            Check.Contains(prompt, "DECREE.md is absent.")
            Check.That(!prompt.Contains("<tokate-owner-instructions>"), "Absent instructions became present")
            return
        }
        Check.Contains(prompt, "SHA-256: " + (text == Exact ? ExactHash: Check.TextHash(text)))
        let marker = "<tokate-owner-instructions>\n"
        let start = prompt.IndexOf(marker, StringComparison.Ordinal) + marker.Length
        let end = prompt.LastIndexOf("\n</tokate-owner-instructions>", StringComparison.Ordinal)
        Check.That(
            start >= marker.Length && end >= start && prompt.Substring(start, end - start) == text,
            "Complete approved bytes did not reach the managed prompt"
        )
    }

    internal func Snapshot(text string, present bool) {
        let decree = Approval()["decree"] ?? throw Exception("Missing snapshot")
        Check.That(Check.Text(decree["present"]) == (present ? "true": "false"), "Incorrect snapshot presence")
        Check.That(Check.Text(decree["text"]) == text, "Snapshot text changed")
        Check.That(
            present ? Check.Text(decree["sha256"]) == (text == Exact ? ExactHash: Check.TextHash(text)): decree[
                "sha256"
            ] == nil,
            "Incorrect snapshot SHA-256"
        )
    }

    shared {
        internal let ExactHash string = "5369117ed38370758ff030d12507229369fa0120e27423be9cf5ddc2c5d8ad0a"

        internal func Create(binary string, version int32) DecreeFlow {
            let test = DecreeFlow(binary, version)
            test.Initialize()
            return test
        }
        internal let Exact string = "\uFEFFOwner-only marker: café, Ελληνικά, 日本語, 🫒\r\n  Style: preserve whitespace.\r\nArchitecture: shared task context.\r\nVerification: run checks.  "

        internal func Delivery(binary string, version int32) {
            for kind in[]string{"absent", "empty", "exact", "executable"} {
                using let test = Create(binary, version)
                let text = kind == "exact" || kind == "executable" ? Exact: ""
                let present = kind != "absent"
                if present {
                    test.Text(text)
                }
                if kind == "executable" {
                    File.SetUnixFileMode(
                        Path.Combine(test.Flow.Upstream, "DECREE.md"),
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    )
                    test.Flow.Commit("Executable regular instructions")
                }
                for launch in 0 ... 2 {
                    File.SetUnixFileMode(
                        Path.Combine(test.Flow.Bin, "codex-impl"),
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    )
                    test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "fetch", test.Flow.Upstream, "main")
                    test.Flow.Approve()
                    test.Snapshot(text, present)
                    let run = test.Start()
                    test.Flow.Call([]string{"work", "--run", run})
                    test.Prompt(text, present)
                    let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                    Check.That(saved["decree"] == nil, "Full instructions duplicated in saved run")
                    Check.That(
                        !File.ReadAllText(Path.Combine(run, "run.json")).Contains("Owner-only marker"),
                        "Instruction text leaked into run metadata"
                    )
                }
                test.Flow.Reload()
                Check.That(
                    test.Flow.State["prompts"]?.AsArray().Count == 2,
                    "Second managed session missed instructions"
                )
            }
        }

        internal func Replacement(binary string, version int32) {
            using let test = Create(binary, version)
            test.Text(Exact)
            test.Flow.Approve()
            let run = test.Start()
            let path = Path.Combine(run, "run.json")
            let saved = File.ReadAllText(path)
            let decree = Path.Combine(run, "checkout/DECREE.md")
            File.WriteAllText(decree, "Donor-controlled replacement")
            Check.Contains(
                test.Flow.Call([]string{"work", "--run", run}, 1).Error,
                "Preserved unidentified, dirty or divergent preparation"
            )
            test.Flow.NoInference()
            test.Flow.NoPr()
            Check.That(
                File.ReadAllText(decree) == "Donor-controlled replacement" && File.ReadAllText(path) == saved,
                "Rejected preparation changed donor work or its saved run"
            )
            File.WriteAllBytes(decree, Encoding.UTF8.GetBytes(Exact))
            test.Flow.Reload()
            test.Flow.State["decree_donor_change"] = JsonValue.Create(true)
            test.Flow.Save()
            Check.Contains(
                test.Flow.Call([]string{"work", "--run", run}, 1).Error,
                "Contribution changes approved root DECREE.md"
            )
            test.Prompt(Exact, true)
            test.Flow.NoPr()
        }

        internal func Freshness(binary string, version int32) {
            for change in[]string{"add", "change", "delete", "unsupported", "unrelated"} {
                if !CiShard.Include("Decree/Freshness/v" + version.ToString() + "/" + change) {
                    continue
                }
                using let test = Create(binary, version)
                if change != "add" {
                    test.Text(Exact)
                }
                test.Flow.Approve()
                let run = test.Start()
                let base = Check.Text(test.Approval()["base"])
                let path = Path.Combine(test.Flow.Upstream, "DECREE.md")
                if change == "add" || change == "change" {
                    File.WriteAllText(path, "New owner instructions\n")
                } else if change == "delete" || change == "unsupported" {
                    File.Delete(path)
                    if change == "unsupported" {
                        File.CreateSymbolicLink(path, "README.md")
                    }
                } else {
                    File.WriteAllText(Path.Combine(test.Flow.Upstream, "unrelated.txt"), "Target advances\n")
                }
                test.Flow.Commit("Target " + change)
                if change == "unrelated" {
                    test.Flow.Call([]string{"work", "--run", run})
                    test.Prompt(Exact, true)
                    Check.That(
                        Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["base"]) == base,
                        "Unrelated target advancement replaced approved base"
                    )
                } else {
                    Check.Contains(
                        test.Flow.Call([]string{"work", "--run", run}, 1).Error,
                        "fresh owner approval is required"
                    )
                    test.Flow.NoInference()
                    if change == "unsupported" {
                        let failure = test.Flow.Call(
                            []string{"approve", "--repo", "owner/project", "--issue", "1"},
                            1,
                            true
                        )
                        Check.Contains(failure.Error, "regular Git blob")
                    } else {
                        test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "fetch", test.Flow.Upstream, "main")
                        test.Flow.Approve()
                        test.Flow.Call([]string{"work", "--run", test.Start()})
                        test.Prompt(change == "delete" ? "": "New owner instructions\n", change != "delete")
                    }
                }
                Console.WriteLine("PASS DECREE v" + version.ToString() + " Freshness/" + change)
            }
        }

        internal func Unsupported(binary string, version int32) {
            for kind in[]string{
                "symlink-inside",
                "symlink-outside",
                "directory",
                "submodule",
                "encoding",
                "nul",
                "oversized",
                "unicode-size",
                "lfs",
                "truncated-tree",
                "unreadable",
                "blob-encoding",
                "truncated-blob",
                "missing-size"
            } {
                using let test = Create(binary, version)
                let path = Path.Combine(test.Flow.Upstream, "DECREE.md")
                if kind.StartsWith("symlink") {
                    File.WriteAllText(Path.Combine(test.Flow.Upstream, "source.md"), Exact)
                    File.CreateSymbolicLink(path, kind == "symlink-inside" ? "source.md": "/etc/passwd")
                } else if kind == "directory" {
                    Directory.CreateDirectory(path)
                    File.WriteAllText(Path.Combine(path, "nested.md"), Exact)
                } else if kind == "submodule" {
                    let base = test.Flow.Git("-C", test.Flow.Upstream, "rev-parse", "HEAD")
                    test.Flow.Git(
                        "-C",
                        test.Flow.Upstream,
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        "160000," + base + ",DECREE.md"
                    )
                } else if kind == "encoding" {
                    File.WriteAllBytes(path, []byte{0xC0, 0xAF})
                } else {
                    let payload = switch kind {
                        case "nul": "owner\0instructions"
                        case "oversized": String('x', 65537)
                        case "unicode-size": String('é', 32769)
                        case "lfs": "version https://git-lfs.github.com/spec/v1\noid sha256:" +
                            String('a', 64) +
                            "\nsize 10\n"
                        default: Exact
                    }
                    File.WriteAllBytes(path, Encoding.UTF8.GetBytes(payload))
                }
                if kind == "submodule" {
                    test.Flow.Git(
                        "-C",
                        test.Flow.Upstream,
                        "-c",
                        "user.name=Owner",
                        "-c",
                        "user.email=owner@example.test",
                        "commit",
                        "-m",
                        "Unsupported submodule"
                    )
                } else {
                    test.Flow.Commit("Instruction type " + kind)
                }
                test.Flow.Reload()
                test.Flow.State["decree_tree_fault"] = JsonValue.Create(kind == "truncated-tree" ? "truncated": "")
                test.Flow.State["decree_blob_fault"] = JsonValue.Create(
                    kind == "blob-encoding" ? "encoding":
                    kind == "truncated-blob" ? "truncated": kind == "unreadable" || kind == "missing-size" ? kind: ""
                )
                test.Flow.Save()
                test.Flow.ResetTraffic()
                let failure = test.Flow.Call([]string{"approve", "--repo", "owner/project", "--issue", "1"}, 1, true)
                Check.That(
                    failure.Error.Contains("DECREE.md"),
                    "Unsupported " + kind + " did not report DECREE.md: " + failure.Error
                )
                test.Flow.Reload()
                for call in test.Flow.State["api_calls"]?.AsArray() ?? throw Exception("Missing API evidence") {
                    Check.That(
                        Check.Text(call["method"]) == "GET",
                        "Unsupported instructions mutated approval/assignment"
                    )
                    if kind.StartsWith("symlink") || kind == "directory" || kind == "submodule" {
                        Check.That(
                            !Check.Text(call["path"]).Contains("/git/blobs/"),
                            "Unsupported mode fetched content"
                        )
                    }
                }
                test.Flow.NoInference()
            }
            using let limit = Create(binary, version)
            let text = String('x', 65536)
            limit.Text(text)
            limit.Flow.Approve()
            limit.Snapshot(text, true)
            limit.Flow.Call([]string{"work", "--run", limit.Start()})
            limit.Prompt(text, true)
        }

        internal func InvalidSnapshot(binary string, version int32) {
            using let test = Create(binary, version)
            test.Text(Exact)
            test.Flow.Approve()
            using let baseline = FixtureSnapshot(test.Flow.Temp.Root)
            for kind in[]string{"hash", "text", "null", "absent", "uppercase"} {
                baseline.Restore()
                test.Flow.Reload()
                let coordination = test.Coordination
                coordination.Comment = 10
                let approval = test.Approval()
                let snapshot = approval["decree"] ?? throw Exception("Missing snapshot")
                if kind == "null" {
                    approval["decree"] = nil
                } else if kind == "hash" {
                    snapshot["sha256"] = JsonValue.Create(String('0', 64))
                } else if kind == "text" {
                    snapshot["text"] = JsonValue.Create("Tampered owner text")
                } else if kind == "uppercase" {
                    snapshot["sha256"] = JsonValue.Create(ExactHash.ToUpperInvariant())
                } else {
                    snapshot["present"] = JsonValue.Create(false)
                }
                test.Rewrite(approval)
                coordination.Coordinate(coordination.Event(coordination.ClaimRequest()), 1)
                test.Flow.NoInference()
            }
        }

        internal func ManagedProtection(binary string, version int32) {
            for mode in[]string{
                "decree-add",
                "decree-change",
                "decree-delete",
                "decree-rename-away",
                "decree-rename-to"
            } {
                using let test = Create(binary, version)
                if mode != "decree-add" && mode != "decree-rename-to" {
                    test.Text(Exact)
                }
                if mode == "decree-rename-to" {
                    File.WriteAllText(Path.Combine(test.Flow.Upstream, "other.md"), Exact)
                    test.Flow.Commit("Rename source")
                }
                test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "fetch", test.Flow.Upstream, "main")
                test.Flow.Approve()
                let run = test.Start()
                test.Flow.Mode(mode)
                Check.Contains(
                    test.Flow.Call([]string{"work", "--run", run}, 1).Error,
                    "Contribution changes approved root DECREE.md"
                )
                Check.That(
                    !File.Exists(Path.Combine(run, "verification.json")),
                    "Protected change reached independent verification"
                )
                test.Flow.NoPr()
            }
        }

        internal func Change(checkout string, mode string) {
            let path = Path.Combine(checkout, "DECREE.md")
            if mode == "add" || mode == "change" {
                File.WriteAllText(path, "Donor replacement\n")
            } else if mode == "delete" {
                File.Delete(path)
            } else if mode == "rename-away" {
                File.Move(path, Path.Combine(checkout, "renamed.md"))
            } else {
                File.Move(Path.Combine(checkout, "other.md"), path)
            }
        }

        internal func DonorCommit(flow NativeFixture, checkout string) string {
            flow.Git("-C", checkout, "add", "-A")
            flow.DonorGit(checkout, "commit", "-m", "Donor instruction edit")
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        internal func ExternalProtection(binary string) {
            for mode in[]string{"add", "change", "delete", "rename-away", "rename-to"} {
                using let test = Create(binary, 2)
                let coordination = test.Coordination
                if mode != "add" && mode != "rename-to" {
                    test.Text(Exact)
                }
                if mode == "rename-to" {
                    File.WriteAllBytes(Path.Combine(test.Flow.Upstream, "other.md"), Encoding.UTF8.GetBytes(Exact))
                    test.Flow.Commit("Owner rename source")
                }
                test.Flow.Approve()
                let claim = coordination.Claim()
                let run = coordination.Prepare()
                coordination.Candidate(claim)
                let checkout = Path.Combine(test.Flow.Temp.Root, "donor-work")
                Change(checkout, mode)
                let commit = DonorCommit(test.Flow, checkout)
                test.Flow.Git(
                    "-C",
                    checkout,
                    "push",
                    Path.Combine(test.Flow.Bin, "fork"),
                    "HEAD:refs/heads/tokate/v2-" + Check.Text(claim["uuid"])
                )
                let external = test.Flow.Call([]string{"external", "--run", run, "--commit", commit}, 1)
                Check.Contains(external.Error, "changes approved root DECREE.md")
                Check.That(
                    !File.Exists(Path.Combine(run, "verification.json")),
                    "Protected external diff reached verification"
                )
                let publication = coordination.PublishRequest(claim, commit)
                let result = coordination.Coordinate(coordination.Event(publication), 1)
                Check.Contains(result.Error, "changes approved root DECREE.md")
                test.Flow.NoPr()
                test.Flow.NoInference()
            }
        }

        internal func All(binary string, selected string = "") {
            var matched bool
            for test in[]TestCase[int32]{
                TestCase[int32]("Delivery", async (value int32) -> Delivery(binary, value)),
                TestCase[int32]("Replacement", async (value int32) -> Replacement(binary, value)),
                TestCase[int32]("Freshness", async (value int32) -> Freshness(binary, value)),
                TestCase[int32]("Unsupported", async (value int32) -> Unsupported(binary, value)),
                TestCase[int32]("InvalidSnapshot", async (value int32) -> InvalidSnapshot(binary, value)),
                TestCase[int32]("ManagedProtection", async (value int32) -> ManagedProtection(binary, value)),
                TestCase[int32]("ExternalProtection", async (value int32) -> ExternalProtection(binary)),
            } {
                let name = test.Name
                if selected != "" && selected != name {
                    continue
                }
                matched = true
                if name != "Freshness" && !CiShard.Include("Decree/" + name) {
                    continue
                }
                for version in[]int32{2} {
                    test.Run(version)
                    if name != "Freshness" {
                        Console.WriteLine("PASS DECREE v" + version.ToString() + " " + name)
                    }
                }
            }
            Check.That(matched, "Unknown DECREE selector: " + selected)
        }
    }
}
