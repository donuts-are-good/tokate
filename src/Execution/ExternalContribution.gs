package Tokate

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class ExternalContribution {
    shared {
        private func Exists(path string) bool -> File.Exists(path) || Directory.Exists(path) || FileInfo(
            path
        ).LinkTarget != nil

        private func Unpublished(directory string, run Data) {
            if run.Number("pr") != 0 || run.Fields.ContainsKey("publication_uuid") || run.Fields.ContainsKey(
                "publication_expected"
            ) ||
                run
                .Fields
                .ContainsKey("correction") {
                throw Exception("External verification cannot replace publication intent")
            }
            for name in[]string{"request.json", "request.json.posting.json", "publication.json", "correction.json"} {
                if Exists(Path.Combine(directory, name)) {
                    throw Exception("External verification cannot replace publication intent")
                }
            }
            let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            if J.Get(state.Value(), "contribution").ValueKind != JsonValueKind.Null || Publication.Pulls(run)
                .Count != 0 {
                throw Exception("External contribution already has publication evidence")
            }
        }

        private func Failed(directory string, run Data, policy JsonElement) {
            let failure = "External correction requires a recorded independent verification failure"
            let descriptor = EvidenceOpen(Path.Combine(directory, "verification.json"), 131072 | 2048 | 524288)
            if descriptor < 0 {
                throw Exception(failure)
            }
            using let handle = SafeFileHandle(IntPtr(descriptor), true)
            using let file = FileStream(handle, FileAccess.Read)
            if !file.CanSeek {
                throw Exception(failure)
            }
            using let reader = StreamReader(file)
            let recorded = J.Get(run.Element(), "verification")
            let checks = J.Items(recorded)
            let commands = J.Items(J.Get(policy, "verification"))
            if run.Text("failure_stage") != "owner_verification" || run.Text(
                "failure_reason"
            ) != "verification_failed" ||
                checks.Count == 0 ||
                checks.Count > commands.Count ||
                !RequestData.Same(recorded, J.Parse(reader.ReadToEnd())) {
                throw Exception(failure)
            }
            for index in 0 ... checks.Count {
                let check = checks[index]
                if !RequestData.Same(J.Get(check, "command"), commands[index]) {
                    throw Exception(failure)
                }
                let state = J.Text(check, "state")
                let code = J.Get(check, "exit_code")
                if state == "completed" && code.ValueKind == JsonValueKind.Number && code.GetInt32() == 0 {
                    continue
                }
                if index == checks.Count - 1 &&
                    (
                    (state == "completed" && code.ValueKind == JsonValueKind.Number && code.GetInt32() != 0) ||
                        (
                        (state == "failed" || state == "interrupted") &&
                            code.ValueKind == JsonValueKind.Undefined &&
                            J.Text(check, "failure") != ""
                    )
                ) {
                    return
                }
                throw Exception(failure)
            }
            if checks.Count == commands.Count || run.Text("error") != "Verification budget exhausted" {
                throw Exception(failure)
            }
        }

        private func KeepTools(previous JsonElement, current JsonElement) {
            let before = J.Items(previous)
            let after = J.Items(current)
            if after.Count < before.Count {
                throw Exception("Full external tools must retain every prior declaration")
            }
            for index in 0 ... before.Count {
                if !RequestData.Same(before[index], after[index]) {
                    throw Exception("Full external tools must retain prior declarations before correction tools")
                }
            }
        }

        private func History(directory string, run Data, commit string) string {
            let previous = RepositoryIdentity.CommitSha(run.Text("commit"))
            if commit != "" && commit == previous {
                throw Exception("External verification requires a new, never-attempted commit")
            }
            let root = Path.Combine(directory, "external-history")
            let recorded = J.Get(run.Element(), "external_history")
            if recorded.ValueKind != JsonValueKind.Undefined && recorded.ValueKind != JsonValueKind.Array {
                throw Exception("External verification history is invalid")
            }
            let heads = HashSet[string](StringComparer.Ordinal)
            for head in J.Items(recorded) {
                if !heads.Add(RepositoryIdentity.CommitSha(head.GetString() ?? "")) {
                    throw Exception("External verification history contains duplicate attempts")
                }
            }
            if Exists(root) {
                LocalPaths.DirectoryPath(root)
                for entry in Directory.EnumerateFileSystemEntries(root) {
                    let head = RepositoryIdentity.CommitSha(Path.GetFileName(entry))
                    if head == commit || head == previous || !heads.Remove(head) {
                        throw Exception("External verification head was already attempted or its history is incomplete")
                    }
                    let checkout = Path.Combine(entry, "checkout")
                    Verification.Candidate(checkout)
                    if Commands.Git(checkout, "rev-parse", "HEAD") != head {
                        throw Exception("Preserved external checkout changed")
                    }
                    let saved = OriginalEvidence.Load(entry)
                    if saved.Text("commit") != head || saved.Text("state") != "failed" || saved.Text(
                        "failure_stage"
                    ) != "owner_verification" {
                        throw Exception("External verification history is incomplete")
                    }
                    for key in[]string{
                        "version",
                        "id",
                        "repo",
                        "issue",
                        "donor",
                        "donor_id",
                        "head_repo",
                        "approval",
                        "state_sha",
                        "attempt",
                        "base",
                        "base_branch",
                        "policy_hash",
                        "branch",
                        "seconds",
                        "network",
                        "source"
                    } {
                        if !RequestData.Same(J.Get(saved.Element(), key), J.Get(run.Element(), key)) {
                            throw Exception("Preserved external authority changed: " + key)
                        }
                    }
                    KeepTools(J.Get(saved.Element(), "tools"), J.Get(run.Element(), "tools"))
                }
            }
            if heads.Count != 0 {
                throw Exception("External verification history is missing")
            }
            return Path.Combine(root, previous)
        }

        private func Preserve(directory string, target string) {
            let root = Path.GetDirectoryName(target) ?? throw Exception("Missing external history directory")
            Directory.CreateDirectory(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            LocalPaths.DirectoryPath(root)
            let temporary = target + ".tmp"
            if Exists(temporary) || Exists(target) {
                throw Exception("External verification history is incomplete")
            }
            Directory.CreateDirectory(
                temporary,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            LocalPaths.DirectoryPath(temporary)
            let archive = Path.Combine(temporary, "original-evidence")
            Directory.CreateDirectory(
                archive,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            LocalPaths.DirectoryPath(archive)
            for name in[]string{"run.json", "verification.json", "checks.json"} {
                let source = Path.Combine(directory, name)
                if name != "checks.json" || Exists(source) {
                    OriginalEvidence.CopyFile(source, Path.Combine(archive, name))
                }
            }
            OriginalEvidence.VerificationArtifacts(directory, archive)
            OriginalEvidence.Seal(archive)
            Directory.Move(temporary, target)
        }

        internal func External(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = RunStorage.Lease(directory)
            let run = Data.Load(directory)
            let retry = run.Text("state") == "failed"
            if run.Number("version") != 2 || run.Text("source") != "external" ||
                (run.Text("state") != "claimed" && !retry) {
                throw Exception("Expected unexecuted external work or a recorded external verification failure")
            }
            if !retry && (args.Get("seconds") != "" || args.Get("tools") != "") {
                throw Exception("--seconds and --tools require a failed external verification")
            }
            let record = ContributionClaim.Recheck(run)
            let commit = RepositoryIdentity.CommitSha(args.Need("commit"))
            let summary = PublicSummary.FileSummary(args.Get("summary"), commit)
            var seconds = run.Number("seconds")
            var tools = J.Get(run.Element(), "tools")
            var history = ""
            if retry {
                Failed(directory, run, J.Get(record, "policy"))
                args.Need("seconds")
                seconds = args.Number("seconds")
                tools = RequestData.FileData(args.Need("tools"), 4096)
                RequestData.Tools(tools)
                let policy = Policy(J.Write(J.Get(record, "policy")))
                policy.ValidateBudget(seconds, run.Flag("network"))
                policy.ValidateTools(tools, "external")
                KeepTools(J.Get(run.Element(), "tools"), tools)
                if J.Count(tools) == J.Count(J.Get(run.Element(), "tools")) {
                    throw Exception("External correction must append at least one tool declaration")
                }
                Unpublished(directory, run)
                history = History(directory, run, commit)
            }
            let metadata = J.Parse(
                J.Write(
                    map[string, Object?]{"fork": run.Text("head_repo"), "branch": run.Text("branch"), "head": commit}
                )
            )
            RepositoryAccess.ValidateFork(run.Text("repo"), metadata, J.Get(run.Element(), "donor_id"))
            let checkout = Path.Combine(directory, "checkout")
            if retry {
                Verification.Candidate(checkout)
                if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("commit") {
                    throw Exception("Failed external checkout differs from its recorded commit")
                }
                Preserve(directory, history)
                let heads = J.Items(J.Get(run.Element(), "external_history"))
                heads.Add(J.Get(run.Element(), "commit"))
                run.Fields["external_history"] = heads
                run.Fields["commit"] = commit
                run.Fields["verification_seconds"] = seconds
                run.Fields["tools"] = tools
                run.Fields["state"] = "verifying"
                run.Fields["failure_stage"] = "candidate_validation"
                run.Fields["failure_reason"] = "candidate_invalid"
                run.Fields["verification"] = J.Parse("[]")
                for key in[]string{"public_summary", "verification_provenance", "tool_provenance", "error"} {
                    run.Fields.Remove(key)
                }
                run.Save(directory)
                Directory.Move(checkout, Path.Combine(history, "checkout"))
            } else if Exists(checkout) {
                throw Exception("External checkout already exists; interrupted verification requires inspection")
            }
            if summary.ValueKind != JsonValueKind.Undefined {
                run.Fields["public_summary"] = summary
            }
            Directory.CreateDirectory(checkout)
            Commands.Git(checkout, "init", "--quiet", "--template=")
            Commands.Git(
                checkout,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                "https://github.com/" + run.Text("head_repo") + ".git",
                commit
            )
            Commands.Git(
                checkout,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                "https://github.com/" + run.Text("repo") + ".git",
                run.Text("base")
            )
            Commands.Git(checkout, "checkout", "--quiet", "--detach", commit)
            Verification.Candidate(checkout)
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit {
                throw Exception("Fetched commit differs from exact declaration")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), commit)
            run.Fields["commit"] = commit
            try {
                Commands.Git(checkout, "diff", "--check", run.Text("base"), commit)
                ProtectedPaths.Local(
                    checkout,
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    run.Text("base"),
                    commit
                )
            } catch (error Exception) {
                run.Fields["state"] = "failed"
                run.Fields["error"] = error.Message
                run.Save(directory)
                throw error
            }
            let timer = Stopwatch.StartNew()
            run.Fields["state"] = "verifying"
            run.Save(directory)
            let results = List[Object]()
            run.Fields["verification"] = results
            PublicOutput.FailureCode = "verification_failed"
            run.Fields["failure_stage"] = "owner_verification"
            run.Fields["failure_reason"] = "verification_failed"
            run.Save(directory)
            File.WriteAllText(Path.Combine(directory, "verification.json"), J.Write(results))
            try {
                let budget = RuntimeBudget(timer, seconds)
                {
                    using let workspace = VerificationWorkspace.Create(checkout, budget)
                    for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                        let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                        if remaining < 1 {
                            throw Exception("Verification budget exhausted")
                        }
                        let result = Terminal.Verify(
                            directory,
                            results,
                            command,
                            checkout,
                            run.Flag("network"),
                            remaining,
                            budget: budget,
                            workspace: workspace
                        )
                        if result.Code != 0 {
                            throw CliFailure(
                                "verification_failed",
                                "Independent external verification failed; no publication authority granted"
                            )
                        }
                    }
                    PublicOutput.FailureCode = "invalid_state"
                    run.Fields["failure_stage"] = "changed_candidate"
                    run.Fields["failure_reason"] = "candidate_changed"
                    workspace.Unchanged(budget)
                }
                PublicOutput.FailureCode = "invalid_state"
                run.Fields["failure_stage"] = "changed_candidate"
                run.Fields["failure_reason"] = "candidate_changed"
                Verification.Candidate(checkout)
                if Commands.Git(checkout, "rev-parse", "HEAD") != commit || Commands.Git(
                    checkout,
                    "status",
                    "--porcelain"
                ) != "" {
                    throw Exception("Independent verification changed the declared commit or checkout")
                }
                ContributionClaim.Recheck(run)
                if retry {
                    RepositoryAccess.ValidateFork(run.Text("repo"), metadata, J.Get(run.Element(), "donor_id"))
                    Unpublished(directory, run)
                    History(directory, run, "")
                }
                run.Fields["verification"] = results
                run.Fields["verification_provenance"] = "tokate-observed locally, exact commit " + commit
                run.Fields[
                    "tool_provenance"
                ] = "donor-reported; identity, usage and coding time not independently attested"
                run.Fields["state"] = "generated"
                run.Fields.Remove("failure_stage")
                run.Fields.Remove("failure_reason")
                run.Save(directory)
            } catch (error Exception) {
                run.Fields["state"] = "failed"
                run.Fields["error"] = error.Message
                run.Save(directory)
                throw error
            }
            Terminal.Message("Exact external commit passed independent verification. Use submit --run " + directory)
        }
    }
}
