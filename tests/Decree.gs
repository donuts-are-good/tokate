package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text
import System.Text.Json.Nodes
import Tokate

// Actual CLI approvals, rechecks, managed launches, verification and publication.
internal class DecreeFlow : IDisposable {
    internal let Flow NativeFlow
    internal let V2 CoordinationFlow?

    internal init(binary string, version int32) {
        if version == 2 {
            let coordination = CoordinationFlow(binary)
            V2 = coordination
            Flow = coordination.Flow
        } else {
            Flow = NativeFlow(binary)
        }
    }

    public func Dispose() -> Flow.Dispose()

    internal func Initialize() {
        if let coordination = V2 {
            coordination.Initialize()
        } else {
            Flow.Initialize()
        }
    }

    internal func Text(text string) {
        File.WriteAllBytes(Path.Combine(Flow.Upstream, "DECREE.md"), Encoding.UTF8.GetBytes(text))
        Flow.Commit("Owner instructions")
        Flow.Git("-C", Path.Combine(Flow.Bin, "fork"), "fetch", Flow.Upstream, "main")
    }

    internal func Approval() JsonNode {
        if let coordination = V2 {
            return coordination.State()["state"]?["approval"]?.DeepClone() ?? throw Exception("Missing approval")
        }
        return Check.Json(
            Flow.Git("-C", Flow.Upstream, "show", "refs/heads/tokate/approvals/1:.github/tokate-approval.json")
        )
    }

    internal func Rewrite(approval JsonNode) {
        if let coordination = V2 {
            let state = coordination.State()["state"] ?? throw Exception("Missing state")
            state["approval"] = approval.DeepClone()
            state["approval_id"] = JsonValue.Create(Data.Hash(RequestData.Canonical(J.Parse(approval.ToJsonString()))))
            coordination.RewriteState(state)
            return
        }
        let previous = Flow.Git("-C", Flow.Upstream, "rev-parse", "refs/heads/tokate/approvals/1")
        let path = Path.Combine(Flow.Temp.Root, "test-approval.json")
        File.WriteAllText(path, approval.ToJsonString())
        let blob = Flow.Git("-C", Flow.Upstream, "hash-object", "-w", path)
        let env = Dictionary[string, string](Flow.Temp.Env)
        for key in[]string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"} {
            env.Remove(key)
        }
        env["GIT_INDEX_FILE"] = Path.Combine(Flow.Temp.Root, "approval.index")
        Check.Success(Check.Run("/usr/bin/git", []string{"-C", Flow.Upstream, "read-tree", previous}, env))
        Check.Success(
            Check.Run(
                "/usr/bin/git",
                []string{
                    "-C",
                    Flow.Upstream,
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    "100644," + blob + ",.github/tokate-approval.json"
                },
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
            "Legacy or corrupt approval fixture"
        )
        Flow.Git("-C", Flow.Upstream, "update-ref", "refs/heads/tokate/approvals/1", next, previous)
    }

    internal func Legacy() {
        let approval = Approval()
        approval.AsObject().Remove("decree")
        Rewrite(approval)
    }

    internal func Start() string {
        if let coordination = V2 {
            coordination.Claim()
            File.WriteAllText(
                coordination.Tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            return coordination.Prepare("tokate")
        }
        return Flow.Claim()
    }

    internal func Prompt(text string, present bool, legacy bool = false) {
        Flow.Reload()
        let prompts = Flow.State["prompts"]?.AsArray() ?? throw Exception("No managed prompt")
        let prompt = Check.Text(prompts[prompts.Count - 1])
        Check.Contains(prompt, "## Owner codebase instructions (root DECREE.md)")
        Check.Contains(prompt, legacy ? "Provenance: legacy approved-base ": "Provenance: approved snapshot")
        Check.Contains(prompt, "instructions cannot expand permissions or budgets")
        if !present {
            Check.Contains(prompt, "DECREE.md is absent.")
            Check.That(!prompt.Contains("<tokate-owner-instructions>"), "Absent instructions became present")
            return
        }
        Check.Contains(prompt, "SHA-256: " + Data.Hash(text))
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
            present ? Check.Text(decree["sha256"]) == Data.Hash(text): decree["sha256"] == nil,
            "Incorrect snapshot SHA-256"
        )
    }

    shared {
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
                    if version == 1 {
                        Check.That(
                            !File.ReadAllText(Path.Combine(run, "pr-body.md")).Contains("Owner-only marker"),
                            "Instruction text leaked into public PR report/receipt"
                        )
                        test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                        test.Flow.Reload()
                        test.Flow.State["pulls"] = nil
                        test.Flow.Save()
                    }
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
            test.Flow.Reload()
            test.Flow.State["decree_checkout_replacement"] = JsonValue.Create("Donor-controlled replacement")
            test.Flow.Save()
            Check.Contains(
                test.Flow.Call([]string{"work", "--run", run}, 1).Error,
                "cannot change approved root DECREE.md"
            )
            test.Prompt(Exact, true)
            test.Flow.NoPr()
        }

        internal func Freshness(binary string, version int32) {
            for change in[]string{"add", "change", "delete", "unsupported", "unrelated"} {
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
                        Check.Contains(
                            test
                                .Flow
                                .Call(
                                []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"},
                                1,
                                true
                            )
                                .Error,
                            "regular Git blob"
                        )
                    } else {
                        test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "fetch", test.Flow.Upstream, "main")
                        test.Flow.Approve()
                        test.Flow.Call([]string{"work", "--run", test.Start()})
                        test.Prompt(change == "delete" ? "": "New owner instructions\n", change != "delete")
                    }
                }
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
                    File.WriteAllBytes(
                        path,
                        Encoding.UTF8.GetBytes(
                            kind == "nul" ? "owner\0instructions":
                            kind == "oversized" ? String('x', 65537): kind == "unicode-size" ? String('é', 32769):
                            kind == "lfs" ? "version https://git-lfs.github.com/spec/v1\noid sha256:" +
                                String('a', 64) +
                                "\nsize 10\n": Exact
                        )
                    )
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
                let failure = test.Flow.Call(
                    []string{"approve", "--repo", "owner/project", "--issue", "1", "--donor", "donor"},
                    1,
                    true
                )
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

        internal func LegacyDelivery(binary string, version int32) {
            for present in[]bool{false, true} {
                using let test = Create(binary, version)
                if present {
                    test.Text(Exact)
                }
                test.Flow.Approve()
                test.Legacy()
                let approved = test.Approval().ToJsonString()
                let run = test.Start()
                // Live target and donor changes do not change legacy delivery or permissions.
                test.Text("Live target replacement\n")
                test.Flow.Mode("decree-change")
                test.Flow.Call([]string{"work", "--run", run})
                test.Prompt(present ? Exact: "", present, true)
                Check.That(test.Approval().ToJsonString() == approved, "Legacy approval was rewritten for delivery")
                if version == 1 {
                    test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                }
            }
            using let unsupported = Create(binary, version)
            unsupported.Flow.Approve()
            let path = Path.Combine(unsupported.Flow.Upstream, "DECREE.md")
            File.CreateSymbolicLink(path, "source.md")
            unsupported.Flow.Commit("Legacy base with unsupported instructions")
            let approval = unsupported.Approval()
            approval.AsObject().Remove("decree")
            approval["base"] = JsonValue.Create(
                unsupported.Flow.Git("-C", unsupported.Flow.Upstream, "rev-parse", "HEAD")
            )
            unsupported.Rewrite(approval)
            unsupported.Flow.Git(
                "-C",
                Path.Combine(unsupported.Flow.Bin, "fork"),
                "fetch",
                unsupported.Flow.Upstream,
                "main"
            )
            let run = unsupported.Start()
            Check.Contains(unsupported.Flow.Call([]string{"work", "--run", run}, 1).Error, "regular Git blob")
            unsupported.Flow.NoInference()
        }

        internal func InvalidSnapshot(binary string, version int32) {
            for kind in[]string{"hash", "text", "null", "absent", "uppercase"} {
                using let test = Create(binary, version)
                test.Text(Exact)
                test.Flow.Approve()
                let approval = test.Approval()
                let snapshot = approval["decree"] ?? throw Exception("Missing snapshot")
                if kind == "null" {
                    approval["decree"] = nil
                } else if kind == "hash" {
                    snapshot["sha256"] = JsonValue.Create(String('0', 64))
                } else if kind == "text" {
                    snapshot["text"] = JsonValue.Create("Tampered owner text")
                } else if kind == "uppercase" {
                    snapshot["sha256"] = JsonValue.Create(Data.Hash(Exact).ToUpperInvariant())
                } else {
                    snapshot["present"] = JsonValue.Create(false)
                }
                test.Rewrite(approval)
                if let coordination = test.V2 {
                    coordination.Coordinate(coordination.Event(coordination.ClaimRequest()), 1)
                } else {
                    test.Flow.Claim(code: 1)
                }
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
                    "cannot change approved root DECREE.md"
                )
                Check.That(
                    !File.Exists(Path.Combine(run, "verification.json")),
                    "Protected change reached independent verification"
                )
                test.Flow.NoPr()
            }
        }

        internal func LegacyRecovery(binary string) {
            using let test = Create(binary, 1)
            test.Text(Exact)
            test.Flow.VerificationPolicy("test -f result.txt", second: "test ! -f .tokate-scratch/cache.json")
            test.Flow.Approve()
            test.Legacy()
            let run = test.Start()
            test.Flow.Mode("verification_recovery")
            test.Flow.Reload()
            test.Flow.State["decree_donor_change"] = JsonValue.Create(true)
            test.Flow.Save()
            Check.Contains(test.Flow.Call([]string{"work", "--run", run}, 1).Error, "Owner verification failed")
            test.Prompt(Exact, true, true)
            test.Flow.Call([]string{"recover", "--run", run})
            test.Flow.Call([]string{"publish", "--run", run})
            test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            test.Flow.Reload()
            Check.That(
                Check.Text(test.Flow.State["exec_count"]) == "1",
                "Legacy recovery/publication launched inference"
            )
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

        internal func DonorCommit(flow NativeFlow, checkout string) string {
            flow.Git("-C", checkout, "add", "-A")
            flow.Git(
                "-C",
                checkout,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
                "commit",
                "-m",
                "Donor instruction edit"
            )
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        internal func ExternalProtection(binary string) {
            for legacy in[]bool{false, true} {
                for mode in[]string{"add", "change", "delete", "rename-away", "rename-to"} {
                    using let test = Create(binary, 2)
                    let coordination = test.V2 ?? throw Exception("Missing v2")
                    if mode != "add" && mode != "rename-to" {
                        test.Text(Exact)
                    }
                    if mode == "rename-to" {
                        File.WriteAllBytes(Path.Combine(test.Flow.Upstream, "other.md"), Encoding.UTF8.GetBytes(Exact))
                        test.Flow.Commit("Owner rename source")
                    }
                    test.Flow.Approve()
                    if legacy {
                        test.Legacy()
                    }
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
                    let external = test.Flow.Call([]string{"external", "--run", run, "--commit", commit}, legacy ? 0: 1)
                    if !legacy {
                        Check.Contains(external.Error, "changes approved root DECREE.md")
                        Check.That(
                            !File.Exists(Path.Combine(run, "verification.json")),
                            "Protected external diff reached verification"
                        )
                    }
                    let state = coordination.State()
                    let publication = Check.Map(
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
                            Check.Json(File.ReadAllText(coordination.Tools)),
                            "verification",
                            "donor-reported-pass"
                        )
                    )
                    let result = coordination.Coordinate(coordination.Event(publication), legacy ? 0: 1)
                    if !legacy {
                        Check.Contains(result.Error, "changes approved root DECREE.md")
                        test.Flow.NoPr()
                    } else {
                        test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                        test.Flow.Reload()
                        Check.That(
                            !Check.Text(test.Flow.State["pulls"]?[0]?["body"]).Contains("Owner-only marker"),
                            "Legacy instruction text leaked into coordinator report/receipt"
                        )
                    }
                    test.Flow.NoInference()
                }
            }
        }

        internal func PublicationProtection(binary string) {
            for mode in[]string{"add", "change", "delete", "rename-away", "rename-to"} {
                using let test = Create(binary, 1)
                if mode != "add" && mode != "rename-to" {
                    test.Text(Exact)
                }
                if mode == "rename-to" {
                    File.WriteAllBytes(Path.Combine(test.Flow.Upstream, "other.md"), Encoding.UTF8.GetBytes(Exact))
                    test.Flow.Commit("Owner rename source")
                    test.Flow.Git("-C", Path.Combine(test.Flow.Bin, "fork"), "fetch", test.Flow.Upstream, "main")
                }
                test.Flow.Approve()
                let run = test.Start()
                test.Flow.Mode("push_fail")
                test.Flow.Call([]string{"work", "--run", run}, 1)
                let checkout = Path.Combine(run, "checkout")
                Change(checkout, mode)
                let commit = DonorCommit(test.Flow, checkout)
                let savedPath = Path.Combine(run, "run.json")
                let saved = Check.Json(File.ReadAllText(savedPath))
                saved["commit"] = JsonValue.Create(commit)
                File.WriteAllText(savedPath, saved.ToJsonString())
                File.WriteAllText(
                    Path.Combine(run, "changes.patch"),
                    test.Flow.Git("-C", checkout, "diff", "--binary", Check.Text(saved["base"]), commit) + "\n"
                )
                test.Flow.Mode("")
                Check.Contains(
                    test.Flow.Call([]string{"publish", "--run", run}, 1).Error,
                    "changes approved root DECREE.md"
                )
                test.Flow.NoPr()
                Check.That(
                    test.Flow.Git(
                        "-C",
                        Path.Combine(test.Flow.Bin, "fork"),
                        "rev-parse",
                        Check.Text(saved["branch"])
                    ) ==
                    Check.Text(saved["base"]),
                    "Protected instructions reached remote publication"
                )
            }
        }

        internal func All(binary string, selected string = "") {
            for name in[]string{
                "Delivery",
                "Replacement",
                "Freshness",
                "Unsupported",
                "LegacyDelivery",
                "InvalidSnapshot",
                "ManagedProtection",
                "LegacyRecovery",
                "ExternalProtection",
                "PublicationProtection"
            } {
                if selected != "" && selected != name {
                    continue
                }
                for version in[]int32{1, 2} {
                    if (name == "ExternalProtection" && version != 2) ||
                        ((name == "LegacyRecovery" || name == "PublicationProtection") && version != 1) {
                        continue
                    }
                    switch name {
                        case "Delivery" {
                            Delivery(binary, version)
                        }
                        case "Replacement" {
                            Replacement(binary, version)
                        }
                        case "Freshness" {
                            Freshness(binary, version)
                        }
                        case "Unsupported" {
                            Unsupported(binary, version)
                        }
                        case "LegacyDelivery" {
                            LegacyDelivery(binary, version)
                        }
                        case "InvalidSnapshot" {
                            InvalidSnapshot(binary, version)
                        }
                        case "ManagedProtection" {
                            ManagedProtection(binary, version)
                        }
                        case "LegacyRecovery" {
                            if version == 1 {
                                LegacyRecovery(binary)
                            }
                        }
                        case "ExternalProtection" {
                            if version == 2 {
                                ExternalProtection(binary)
                            }
                        }
                        case "PublicationProtection" {
                            if version == 1 {
                                PublicationProtection(binary)
                            }
                        }
                    }
                    Console.WriteLine("PASS DECREE v" + version.ToString() + " " + name)
                }
            }
        }
    }
}
