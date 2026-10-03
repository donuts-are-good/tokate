package Tokate

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text.Json

@DllImport("libc", EntryPoint: "open", SetLastError: true)
func EvidenceOpen(path string, flags int32) int32;

internal class Correction {
    shared {
        internal func Load(path string) Data {
            let data = Data()
            for field in J.Parse(File.ReadAllText(path)).EnumerateObject() {
                data.Fields[field.Name] = field.Value.Clone()
            }
            return data
        }

        internal func Same(left JsonElement, right JsonElement) bool {
            if left.ValueKind == JsonValueKind.Undefined || right.ValueKind == JsonValueKind.Undefined {
                return left.ValueKind == right.ValueKind
            }
            return RequestData.Canonical(left) == RequestData.Canonical(right)
        }

        internal func Write(path string, data Data) {
            File.WriteAllText(path + ".tmp", J.Write(data.Fields) + "\n")
            File.Move(path + ".tmp", path, true)
        }

        internal func Save(directory string, correction Data) {
            let current = Path.Combine(directory, "correction.json")
            if File.Exists(current) {
                let previous = Load(current)
                if previous.Text("uuid") != correction.Text("uuid") {
                    Write(Path.Combine(directory, "correction-" + previous.Text("uuid"), "record.json"), previous)
                }
            }
            Write(Path.Combine(directory, "correction.json"), correction)
            Write(Path.Combine(directory, "correction-" + correction.Text("uuid"), "record.json"), correction)
        }

        internal func GitRaw(checkout string, args ...string) string -> Commands.GitRaw(checkout, args)

        internal func Patch(checkout string, base string, commit string) string -> GitRaw(
            checkout,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            "--full-index",
            "--find-renames=100%",
            base,
            commit,
            "--"
        )

        internal func Candidate(checkout string, run Data, commit string, policy JsonElement) string {
            Verification.Candidate(checkout)
            Data.CommitSha(commit)
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit ||
                GitRaw(checkout, "status", "--porcelain=v1", "--untracked-files=all") != "" {
                throw Exception("Correction requires a clean checkout at the declared exact commit")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), commit)
            Commands.Git(checkout, "diff", "--no-ext-diff", "--no-textconv", "--check", run.Text("base"), commit, "--")
            ProtectedPaths.Local(checkout, policy, run.Text("base"), commit)
            return Patch(checkout, run.Text("base"), commit)
        }

        internal func Exact(directory string, run Data, correction Data, policy JsonElement) {
            let checkout = Path.Combine(directory, "checkout")
            let patch = Candidate(checkout, run, correction.Text("commit"), policy)
            if Commands.Git(checkout, "rev-parse", "HEAD^{tree}") != correction.Text("tree") || Data.Hash(
                patch
            ) != correction.Text("patch_sha256") || patch != File.ReadAllText(
                Path.Combine(directory, "correction-" + correction.Text("uuid"), "candidate.patch")
            ) {
                throw Exception("Corrected head, tree or complete patch changed")
            }
        }

        internal func Completed(directory string, run Data) Dictionary[string, Object?] {
            if (run.Number("version") != 1 && run.Number("version") != 2) ||
                (run.Number("version") == 2 && run.Text("source") != "tokate") {
                throw Exception("Correction requires native v1 or managed v2 work; external work is excluded")
            }
            if run.Number("pr") != 0 || run.Text("state") == "published" {
                throw Exception("Contribution already published; correction recovery is only before first publication")
            }
            if (run.Text("state") != "failed" && run.Text("state") != "generated") || run.Text(
                "failure_reason"
            ) == "inference_failed" ||
                run
                .Text("error").StartsWith("Codex failed.") ||
                (run.Fields.ContainsKey("inference_exit_code") && run.Number("inference_exit_code") != 0) {
                throw Exception("incomplete_turn: correction requires a completed successful inference turn")
            }
            try {
                return Worker.CompletedUsage(directory, File.ReadAllText(Path.Combine(directory, "events.jsonl")))
            } catch (error Exception) {
                throw Exception("incomplete_turn: " + error.Message)
            }
        }

        internal func Fork(run Data) {
            let info = GitHub.Api("repos/" + Data.Repo(run.Text("head_repo")))
            if !J.Bool(J.Get(info, "permissions"), "push") || J.Get(J.Get(info, "owner"), "id").ToString() != J.Get(
                run.Element(),
                "donor_id"
            )
                .ToString() ||
                (
                run.Text("head_repo") != run.Text("repo") && !String.Equals(
                    J.Text(J.Get(info, "parent"), "full_name"),
                    run.Text("repo"),
                    StringComparison.OrdinalIgnoreCase
                )
            ) {
                throw Exception("Fork ownership, write access or upstream changed")
            }
        }

        internal func Authority(directory string, run Data) JsonElement {
            let record = Workflow.Recheck(run)
            Fork(run)
            if run.Number("version") == 2 {
                let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
                if J.Get(state.Value(), "contribution").ValueKind == JsonValueKind.Object {
                    throw Exception("Contribution already published")
                }
            }
            let archive = Path.Combine(directory, "original-evidence")
            if Directory.Exists(archive) {
                OriginalRun(directory, run)
                let pinned = J.Parse(File.ReadAllText(Path.Combine(archive, "approval.json")))
                for key in[]string{"approval", "policy", "template"} {
                    if RequestData.Canonical(J.Get(pinned, key)) != RequestData.Canonical(J.Get(record, key)) {
                        throw CliFailure("stale_approval", "Original approval, policy or template changed")
                    }
                }
            }
            return record
        }

        internal func OriginalRun(directory string, run Data) Data {
            let original = Original(directory)
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
                "base",
                "base_branch",
                "policy_hash",
                "branch",
                "model",
                "effort",
                "seconds",
                "network",
                "source",
                "tools",
                "usage",
                "execution_seconds",
                "elapsed_seconds",
                "codex_version",
                "inference_exit_code",
                "turn_completed"
            } {
                if !Same(J.Get(original.Element(), key), J.Get(run.Element(), key)) {
                    throw Exception("Saved original authority or execution attribution changed: " + key)
                }
            }
            return original
        }

        private func Activate(directory string, run Data, correction Data) {
            run.Fields["commit"] = correction.Text("commit")
            run.Fields["verification"] = J.Get(correction.Element(), "verification")
            run.Fields["correction"] = Provenance(correction)
            run.Fields["state"] = "generated"
            run.Fields.Remove("error")
            run.Fields.Remove("failure_reason")
            run.Fields.Remove("failure_stage")
            run.Save(directory)
        }

        internal func FileHash(path string) string {
            using let stream = File.OpenRead(path)
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()
        }

        private func CopyFile(source string, target string) {
            let descriptor = EvidenceOpen(source, 131072 | 2048)
            if descriptor < 0 {
                throw Exception("Cannot safely capture original evidence: " + source)
            }
            using let handle = SafeFileHandle(IntPtr(descriptor), true)
            using let input = FileStream(handle, FileAccess.Read)
            if !input.CanSeek {
                throw Exception("Original evidence must be a regular file: " + source)
            }
            using let output = File.Open(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)
            input.CopyTo(output)
        }

        private func CopyTree(source string, target string, links List[Object], relative string = "") {
            Directory.CreateDirectory(target)
            for entry in Directory.EnumerateFileSystemEntries(source) {
                let name = Path.GetFileName(entry)
                if relative == "" && name == ".git" {
                    continue
                }
                let path = relative == "" ? name: relative + "/" + name
                let info = FileInfo(entry)
                if info.LinkTarget != nil {
                    links.Add(J.Map("path", path, "target", info.LinkTarget))
                } else if Directory.Exists(entry) {
                    CopyTree(entry, Path.Combine(target, name), links, path)
                } else {
                    CopyFile(entry, Path.Combine(target, name))
                }
            }
        }

        private func Inventory(directory string) Dictionary[string, Object?] {
            let files = Dictionary[string, Object?]()
            for path in Directory.EnumerateFileSystemEntries(directory) {
                if FileInfo(path).LinkTarget != nil {
                    throw Exception("Original archive contains a link")
                }
                if Directory.Exists(path) {
                    for entry in Inventory(path) {
                        files[Path.GetFileName(path) + "/" + entry.Key] = entry.Value
                    }
                } else {
                    files[Path.GetFileName(path)] = FileHash(path)
                }
            }
            return files
        }

        internal func Archive(directory string, run Data, record JsonElement) {
            let final = Path.Combine(directory, "original-evidence")
            if Directory.Exists(final) {
                Original(directory)
                return
            }
            let checkout = Verification.Validate(Path.Combine(directory, "checkout"))
            let temporary = Path.Combine(directory, "original-evidence-" + Guid.NewGuid().ToString("N") + ".tmp")
            Directory.CreateDirectory(
                temporary,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                let missing = List[string]()
                let links = List[Object]()
                for file in[]string{
                    "run.json",
                    "events.jsonl",
                    "report.md",
                    "stderr.log",
                    "candidate.patch",
                    "changes.patch",
                    "verification.json",
                    "checks.json",
                    "publication.json",
                    "request.json",
                    "pr-body.md"
                } {
                    let source = Path.Combine(directory, file)
                    if FileInfo(source).LinkTarget != nil {
                        throw Exception("Original saved records must not be links: " + file)
                    }
                    if File.Exists(source) {
                        CopyFile(source, Path.Combine(temporary, file))
                    } else {
                        missing.Add(file)
                    }
                }
                File.WriteAllText(Path.Combine(temporary, "approval.json"), J.Write(record) + "\n")
                File.WriteAllText(
                    Path.Combine(temporary, "staged.patch"),
                    GitRaw(
                        checkout,
                        "diff",
                        "--cached",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--binary",
                        "--full-index",
                        "--find-renames=100%",
                        run.Text("base"),
                        "--"
                    )
                )
                File.WriteAllText(
                    Path.Combine(temporary, "unstaged.patch"),
                    GitRaw(
                        checkout,
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--binary",
                        "--full-index",
                        "--find-renames=100%",
                        "--"
                    )
                )
                File.WriteAllText(
                    Path.Combine(temporary, "status.txt"),
                    GitRaw(checkout, "status", "--porcelain=v1", "--untracked-files=all")
                )
                CopyTree(checkout, Path.Combine(temporary, "checkout"), links)
                File.WriteAllText(
                    Path.Combine(temporary, "capture.json"),
                    J.Write(
                        J.Map(
                            "captured_at",
                            DateTimeOffset.UtcNow.ToString("O"),
                            "head",
                            Commands.Git(checkout, "rev-parse", "HEAD"),
                            "missing",
                            missing,
                            "links",
                            links,
                            "failure",
                            run.Text("error"),
                            "candidate_provenance",
                            "Available staged/unstaged/untracked evidence captured at preparation; original model provenance is unproven. Missing original artifacts are not reconstructed."
                        )
                    ) +
                        "\n"
                )
                let inventory = Inventory(temporary)
                let manifest = RequestData.Canonical(J.Parse(J.Write(inventory)))
                File.WriteAllText(Path.Combine(temporary, "manifest.json"), manifest + "\n")
                let seal = Data()
                seal.Fields["manifest_sha256"] = Data.Hash(manifest)
                Write(Path.Combine(temporary, "seal.json"), seal)
                Directory.Move(temporary, final)
            } finally {
                if Directory.Exists(temporary) {
                    Directory.Delete(temporary, true)
                }
            }
        }

        internal func Original(directory string) Data {
            let archive = Verification.DirectoryPath(Path.Combine(directory, "original-evidence"))
            let manifest = File.ReadAllText(Path.Combine(archive, "manifest.json")).TrimEnd('\n')
            let seal = Load(Path.Combine(archive, "seal.json"))
            let inventory = Inventory(archive)
            inventory.Remove("manifest.json")
            inventory.Remove("seal.json")
            if Data.Hash(manifest) != seal.Text("manifest_sha256") || RequestData.Canonical(
                J.Parse(J.Write(inventory))
            ) != manifest {
                throw Exception(
                    "Original evidence archive changed or is incomplete; no silent reconstruction is allowed"
                )
            }
            return Data.Load(archive)
        }

        internal func Tools(path string, policy JsonElement) JsonElement {
            let tools = path == "" ? J.Parse("[]"): RequestData.FileData(path, 4096)
            ToolsFromValue(tools, policy)
            return tools
        }

        internal func ToolsFromValue(tools JsonElement, policy JsonElement) {
            if tools.ValueKind != JsonValueKind.Array {
                throw Exception("Correction tools must be an array; [] declares manual editing")
            }
            if J.Items(tools).Count > 0 {
                RequestData.Tools(tools)
                let owner = Policy(J.Write(policy))
                if J.Number(policy, "version") == 2 {
                    owner.ValidateTools(tools)
                } else {
                    for tool in J.Items(tools) {
                        if J.Text(tool, "harness") != "codex" || J.Text(tool, "provider") != "openai" {
                            throw Exception("Version-1 owner policy permits only codex/openai correction tools")
                        }
                        owner.Validate(J.Text(tool, "model"), J.Text(tool, "effort"), 1, false)
                    }
                }
            }
        }

        internal func Provenance(correction Data) JsonElement -> J.Parse(
            J.Write(
                J.Map(
                    "uuid",
                    correction.Text("uuid"),
                    "head",
                    correction.Text("commit"),
                    "tree",
                    correction.Text("tree"),
                    "patch_sha256",
                    correction.Text("patch_sha256"),
                    "seconds",
                    correction.Number("seconds"),
                    "tools",
                    J.Get(correction.Element(), "tools"),
                    "verification",
                    "tokate-observed-locally-exact-commit"
                )
            )
        )

        internal func Recover(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            Completed(directory, run)
            let record = Authority(directory, run)
            if args.Get("prepare") == "true" {
                if CorrectionPublication.Pulls(run).Count != 0 {
                    throw Exception("Contribution already has a physical PR; inspect publication instead")
                }
                CorrectionPublication.Remote(run, nil, true)
                Archive(directory, run, record)
                Terminal.Message(
                    "Original evidence preserved. Correct the checkout, commit explicitly, then recover --commit SHA --seconds N. No inference, checks or publication ran."
                )
                return
            }
            Original(directory)
            let commit = Data.CommitSha(args.Need("commit"))
            let seconds = args.Number("seconds")
            if seconds > J.Number(J.Get(record, "policy"), "max_seconds") {
                throw Exception("Correction verification budget exceeds original owner limit")
            }
            let tools = Tools(args.Get("tools"), J.Get(record, "policy"))
            let current = Path.Combine(directory, "correction.json")
            if File.Exists(current) {
                let saved = Load(current)
                if saved.Text("commit") == commit {
                    if saved.Number("seconds") != seconds || RequestData.Canonical(
                        J.Get(saved.Element(), "tools")
                    ) != RequestData.Canonical(tools) {
                        throw Exception("Saved correction budget or provenance changed")
                    }
                    if saved.Text("state") != "verified" {
                        throw Exception(
                            "Correction verification failed or was interrupted; a new corrected commit is an explicit new attempt"
                        )
                    }
                    Exact(directory, run, saved, J.Get(record, "policy"))
                    Activate(directory, run, saved)
                    if run.Number("version") == 1 {
                        CorrectionPublication.PublishLocked(directory, run, saved, record)
                    } else {
                        Terminal.Message(
                            "Correction already verified. Use submit --run " +
                                directory +
                                "; checks and inference were not repeated."
                        )
                    }
                    return
                }
                if J.Get(saved.Element(), "publication").ValueKind == JsonValueKind.Object {
                    throw Exception(
                        "Interrupted publication intent already binds another candidate; inspect it before any new correction"
                    )
                }
            }
            let correction = Data()
            correction.Fields["version"] = 1
            correction.Fields["uuid"] = Guid.NewGuid().ToString("D")
            correction.Fields["commit"] = commit
            correction.Fields["seconds"] = seconds
            correction.Fields["tools"] = tools
            correction.Fields["state"] = "validating"
            correction.Fields["failure_stage"] = "candidate_validation"
            correction.Fields["failure_reason"] = "candidate_invalid"
            let attempt = Path.Combine(directory, "correction-" + correction.Text("uuid"))
            Directory.CreateDirectory(attempt)
            Save(directory, correction)
            try {
                if CorrectionPublication.Pulls(run).Count != 0 {
                    throw Exception("Contribution already has a physical PR")
                }
                CorrectionPublication.Remote(run, correction, true)
                let checkout = Path.Combine(directory, "checkout")
                let patch = Candidate(checkout, run, commit, J.Get(record, "policy"))
                correction.Fields["tree"] = Commands.Git(checkout, "rev-parse", "HEAD^{tree}")
                correction.Fields["patch_sha256"] = Data.Hash(patch)
                File.WriteAllText(Path.Combine(attempt, "candidate.patch"), patch)
                Save(directory, correction)
                Exact(directory, run, correction, J.Get(record, "policy"))
                correction.Fields["state"] = "verifying"
                correction.Fields["failure_stage"] = "owner_verification"
                correction.Fields["failure_reason"] = "verification_failed"
                Save(directory, correction)
                let results = List[Object]()
                let timer = Stopwatch.StartNew()
                var failed bool
                for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                    let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                    if remaining < 1 {
                        throw CliFailure("verification_failed", "Correction verification budget exhausted")
                    }
                    let words = List[string]()
                    for word in J.Items(command) {
                        words.Add(word.GetString() ?? "")
                    }
                    let result = Verification.Run(
                        checkout,
                        words.ToArray(),
                        run.Flag("network") && J.Bool(J.Get(record, "policy"), "allow_network"),
                        remaining
                    )
                    results.Add(
                        J.Map(
                            "command",
                            command,
                            "exit_code",
                            result.Code,
                            "output",
                            result.Output,
                            "error",
                            result.Error
                        )
                    )
                    correction.Fields["verification"] = results
                    File.WriteAllText(Path.Combine(attempt, "verification.json"), J.Write(results) + "\n")
                    Save(directory, correction)
                    failed = failed || result.Code != 0
                }
                correction.Fields["verification_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
                correction.Fields["failure_stage"] = "changed_candidate"
                correction.Fields["failure_reason"] = "candidate_changed"
                Exact(directory, run, correction, J.Get(record, "policy"))
                if failed {
                    correction.Fields["failure_stage"] = "owner_verification"
                    correction.Fields["failure_reason"] = "verification_failed"
                    throw CliFailure(
                        "verification_failed",
                        "Owner verification failed for the explicit correction; all results are preserved"
                    )
                }
                Authority(directory, run)
                correction.Fields["state"] = "verified"
                correction.Fields.Remove("failure_stage")
                correction.Fields.Remove("failure_reason")
                Save(directory, correction)
                Activate(directory, run, correction)
            } catch (error Exception) {
                correction.Fields["state"] = "failed"
                correction.Fields["error"] = error.Message
                Save(directory, correction)
                let code = error is CliFailure failure ? failure.Code:
                (correction.Text("failure_reason") == "verification_failed" ? "verification_failed": "invalid_state")
                throw CliFailure(
                    code,
                    PublicOutput.Enabled ? PublicOutput.Message(code):
                    correction.Text("failure_reason") + " (" + correction.Text("failure_stage") + "): " + error.Message
                )
            }
            if run.Number("version") == 1 {
                CorrectionPublication.PublishLocked(directory, run, correction, record)
            } else {
                Terminal.Message(
                    "Exact corrected commit passed every original owner check. Use submit --run " + directory
                )
            }
        }
    }
}
