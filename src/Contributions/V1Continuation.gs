package Tokate

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

@DllImport("libc", EntryPoint: "fstat")
func ContinuationStat(descriptor int32, buffer IntPtr) int32;

internal class V1Continuation {
    shared {
        private let Limit int32 = 32 * 1024 * 1024

        internal func Has(run Data) bool -> run.Text("continuation_source") != ""

        internal func Confirm(args Args, selection JsonElement) {
            let confirmed = J.Map()
            for field in selection.EnumerateObject() {
                confirmed[field.Name] = field.Value.Clone()
            }
            confirmed["source"] = "explicit continuation import"
            DonorSelection.Confirm(args, J.Parse(J.Write(confirmed)))
        }

        internal func SupportedApproval(approval JsonElement) {
            if J.Number(approval, "version") != 1 || !Decree.HasSnapshot(approval) || J.Text(
                approval,
                "authority_branch"
            ) == "" ||
                J.Text(approval, "nonce") == "" {
                throw Exception(
                    "Continuation requires a v1 approval with explicit base, authority and owner-instruction evidence; unsupported legacy state is preserved"
                )
            }
            RepositoryIdentity.CommitSha(J.Text(approval, "base"))
            RepositoryIdentity.Branch(J.Text(approval, "base_branch"))
            Decree.Validate(J.Get(approval, "decree"))
        }

        internal func Grant(record JsonElement, priorSha string, donorId JsonElement) JsonElement {
            let approval = J.Get(record, "approval")
            SupportedApproval(approval)
            if J.Text(approval, "predecessor_approval") != RepositoryIdentity.CommitSha(priorSha) || J.Text(
                record,
                "sha"
            ) == priorSha ||
                RepositoryIdentity.PositiveId(J.Get(approval, "donor_id")) != RepositoryIdentity.PositiveId(donorId) {
                throw CliFailure(
                    "stale_approval",
                    "Import requires fresh owner continuation approval naming this predecessor and the same numeric donor"
                )
            }
            let prior = J.Parse(GitHub.FileAt(J.Text(approval, "repo"), ".github/tokate-approval.json", priorSha))
            SupportedApproval(prior)
            for key in[]string{
                "version",
                "repo",
                "issue",
                "donor",
                "base",
                "base_branch",
                "authority_branch",
                "issue_hash",
                "policy_hash",
                "template_hash",
                "decree"
            } {
                if !RequestData.Same(J.Get(approval, key), J.Get(prior, key)) {
                    throw CliFailure("stale_approval", "Continuation changed predecessor binding: " + key)
                }
            }
            if J.Text(approval, "nonce") == J.Text(prior, "nonce") {
                throw Exception("Continuation requires a new approval nonce")
            }
            for key in[]string{"donor_id", "repo_id"} {
                if J.Get(prior, key).ValueKind != JsonValueKind.Undefined && RepositoryIdentity.PositiveId(
                    J.Get(prior, key)
                ) != RepositoryIdentity
                    .PositiveId(J.Get(approval, key)) {
                    throw CliFailure("stale_approval", "Continuation changed predecessor identity: " + key)
                }
            }
            let info = GitHub.Api("repos/" + J.Text(approval, "repo"))
            if RepositoryIdentity.PositiveId(J.Get(info, "id")) != RepositoryIdentity.PositiveId(
                J.Get(approval, "repo_id")
            ) {
                throw Exception("Continuation repository identity changed")
            }
            return prior
        }

        internal func SourceLease(directory string) FileStream {
            LocalPaths.DirectoryPath(directory)
            if !File.Exists(Path.Combine(directory, ".lock")) {
                throw Exception("Unsupported source lease state; source is preserved")
            }
            try {
                return Preparation.Lease(directory)
            } catch (error IOException) {
                throw Exception(
                    "Source attempt is active or leased; stop it and explicitly retry this command after its lease is released",
                    error
                )
            }
        }

        internal func Source(directory string, run Data, record JsonElement) Data {
            let source = Data()
            for field in J.Parse(Encoding.UTF8.GetString(Bytes(Path.Combine(directory, "run.json"), 1048576)))
                .EnumerateObject() {
                source.Fields[field.Name] = field.Value.Clone()
            }
            let state = source.Text("state")
            if source.Number("version") != 1 || source.Number("preparation_version") != 1 ||
                (source.Text("source") != "" && source.Text("source") != "tokate") ||
                source.Text("codex_version") == "" || source.Flag("turn_completed") || source.Text(
                "harness"
            ) != "codex" ||
                source.Text("provider") != "openai" || (state != "failed" && state != "running") || source.Text(
                "failure_stage"
            ) != "inference" ||
                (state == "failed" && source.Text("failure_reason") != "inference_interrupted") ||
                source.Text("commit") != "" || source.Number("pr") != 0 || source.Text("pr_url") != "" || File.Exists(
                Path.Combine(directory, "correction.json")
            ) {
                throw Exception(
                    "Source must be stopped, unpublished interrupted same-donor v1 managed work; unsupported legacy or completed work is preserved"
                )
            }
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, source) || !RepositoryIdentity.SameDonor(viewer, run) ||
                !RepositoryIdentity.SameRepo(source.Text("repo"), run.Text("repo")) || source.Number(
                "issue"
            ) != run.Number("issue") {
                throw Exception("Continuation source has a different donor, repository or issue")
            }
            let prior = Grant(record, source.Text("approval"), J.Get(source.Element(), "donor_id"))
            if source.Text("base") != J.Text(prior, "base") || source.Text("base_branch") != J.Text(
                prior,
                "base_branch"
            ) ||
                source.Text("policy_hash") != J.Text(prior, "policy_hash") || source.Text("branch") != "tokate/issue-" +
                source
                .Number("issue").ToString() + "-" + source.Text("approval").Substring(0, 12) {
                throw Exception("Interrupted source differs from immutable predecessor approval")
            }
            if !Regex.IsMatch(source.Text("id"), "^[0-9a-f]{32}$") {
                throw Exception("Unsupported source attempt identity")
            }
            Preparation.Source(Path.Combine(directory, "checkout"), source)
            Correction.Fork(source)
            if CorrectionPublication.Pulls(source).Count != 0 {
                throw Exception("Published contributions cannot be imported")
            }
            let reference = GitHub.Api(
                "repos/" + RepositoryIdentity.Repo(source.Text("head_repo")) + "/git/ref/heads/" + Uri.EscapeDataString(
                    source.Text("branch")
                )
            )
            if J.Text(J.Get(reference, "object"), "sha") != source.Text("base") {
                throw Exception("Prior branch changed or was published; source is preserved")
            }
            return source
        }

        internal func Provenance(source Data) JsonElement -> J.Parse(
            J.Write(
                J.Map(
                    "id",
                    source.Text("id"),
                    "approval",
                    source.Text("approval"),
                    "base",
                    source.Text("base"),
                    "donor_id",
                    J.Get(source.Element(), "donor_id"),
                    "state",
                    source.Text("state"),
                    "failure_reason",
                    source.Text("failure_reason"),
                    "model",
                    source.Text("model"),
                    "effort",
                    source.Text("effort"),
                    "harness",
                    source.Text("harness"),
                    "provider",
                    source.Text("provider")
                )
            )
        )

        internal func Receipt(prior JsonElement, manifestHash string, approval JsonElement) {
            RequestData.Keys(prior, "id,approval,base,donor_id,state,failure_reason,model,effort,harness,provider")
            if !Regex.IsMatch(J.Text(prior, "id"), "^[0-9a-f]{32}$") || !Regex.IsMatch(
                manifestHash,
                "^[0-9a-f]{64}$"
            ) ||
                J.Text(prior, "approval") != J.Text(approval, "predecessor_approval") || J.Text(
                prior,
                "base"
            ) != J.Text(approval, "base") || RepositoryIdentity.PositiveId(
                J.Get(prior, "donor_id")
            ) != RepositoryIdentity.PositiveId(J.Get(approval, "donor_id")) ||
                (J.Text(prior, "state") != "failed" && J.Text(prior, "state") != "running") ||
                (J.Text(prior, "state") == "failed" && J.Text(prior, "failure_reason") != "inference_interrupted") {
                throw Exception("Invalid interrupted-origin receipt provenance")
            }
        }

        private func PathName(path string) {
            if path.Length == 0 || path.Length > 1024 || path.Contains('\\') || path.StartsWith('/') {
                throw Exception("Unsafe continuation path")
            }
            for character in path {
                if Char.IsControl(character) {
                    throw Exception("Unsafe continuation path")
                }
            }
            for part in path.Split('/') {
                if part == "" || part == "." || part == ".." || part.Equals(
                    ".git",
                    StringComparison.OrdinalIgnoreCase
                ) ||
                    part.Contains(':') {
                    throw Exception("Unsafe continuation path")
                }
            }
        }

        private func Excluded(path string) bool {
            for part in path.Split('/') {
                if part == ".env" || part.StartsWith(".env.", StringComparison.Ordinal) {
                    return true
                }
                if Array.IndexOf(
                    []string{
                        ".git",
                        ".verification-data",
                        ".ssh",
                        ".gnupg",
                        ".secrets",
                        ".netrc",
                        ".git-credentials",
                        "credentials.json",
                        "auth.json",
                        ".tokate",
                        ".state",
                        ".runs",
                        "tool-output",
                        ".tokate-scratch",
                        ".codex",
                        ".cache",
                        ".nuget",
                        ".npm",
                        ".local",
                        ".config",
                        "node_modules",
                        "__pycache__",
                        ".venv",
                        "venv",
                        "codex-home",
                        "gh-home",
                        "credential-home",
                        "package-cache",
                        "home",
                        "logs",
                        "artifacts",
                        "bin",
                        "obj",
                        "dist",
                        "build",
                        "target",
                        "coverage",
                        ".pytest_cache",
                        ".gradle"
                    },
                    part
                ) >= 0 {
                    return true
                }
            }
            return path.EndsWith(".log", StringComparison.OrdinalIgnoreCase) || Array.IndexOf(
                []string{
                    "events.jsonl",
                    "stderr.log",
                    "run.json",
                    "verification.json",
                    "checks.json",
                    "report.md",
                    "candidate.patch",
                    "changes.patch"
                },
                path
            ) >= 0
        }

        private func Open(path string) FileStream {
            let descriptor = EvidenceOpen(path, 131072 | 2048)
            if descriptor < 0 {
                throw Exception("Cannot safely read continuation file: " + path)
            }
            let handle = SafeFileHandle(IntPtr(descriptor), true)
            let stat = Marshal.AllocHGlobal(144)
            try {
                if ContinuationStat(descriptor, stat) != 0 ||
                    (Marshal.ReadInt32(stat, 24) & 61440) != 32768 ||
                    Marshal.ReadInt64(stat, 16) != 1 {
                    throw Exception("Continuation requires regular files without links: " + path)
                }
                return FileStream(handle, FileAccess.Read)
            } catch (error Exception) {
                handle.Dispose()
                rethrow
            } finally {
                Marshal.FreeHGlobal(stat)
            }
        }

        private func Bytes(path string, limit int32 = 33554432)[]byte {
            using let input = Open(path)
            if !input.CanSeek || input.Length > limit {
                throw Exception("Continuation file exceeds bounded regular-file capture: " + path)
            }
            using let output = MemoryStream()
            let buffer = [8192]byte
            var count int32
            while (
                count = input.Read(buffer, 0, Math.Min(buffer.Length, limit - Convert.ToInt32(output.Length) + 1))
            ) > 0 {
                if output.Length + count > limit {
                    throw Exception("Continuation capture exceeds byte limit")
                }
                output.Write(buffer, 0, count)
            }
            return output.ToArray()
        }

        private func Blob(bytes[]byte) string {
            using let hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1)
            hash.AppendData(Encoding.UTF8.GetBytes("blob " + bytes.Length.ToString() + "\0"))
            hash.AppendData(bytes)
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant()
        }

        private func Files(
            root string,
            relative string,
            files HashSet[string],
            visited HashSet[string],
            exclude bool,
            depth int32 = 0
        ) {
            if depth > 64 || visited.Count > 100000 {
                throw Exception("Continuation inventory exceeds bounded path count or depth")
            }
            for entry in Directory.EnumerateFileSystemEntries(Path.Combine(root, relative)) {
                let name = Path.GetFileName(entry)
                let path = relative == "" ? name: relative + "/" + name
                if path == ".git" || (exclude && Excluded(path)) {
                    continue
                }
                PathName(path)
                if !visited.Add(path) || visited.Count > 100000 {
                    throw Exception("Continuation inventory exceeds bounded path count")
                }
                if FileInfo(entry).LinkTarget != nil {
                    throw Exception("Continuation refuses symbolic links: " + path)
                }
                if Directory.Exists(entry) {
                    Files(root, path, files, visited, exclude, depth + 1)
                } else {
                    using let file = Open(entry)
                    files.Add(path)
                }
            }
        }

        private func Paths(output string)[]string {
            if output != "" && !output.EndsWith("\0", StringComparison.Ordinal) {
                throw Exception("Incomplete continuation Git path evidence")
            }
            return output.Split('\0', StringSplitOptions.RemoveEmptyEntries)
        }

        private func Scan(checkout string, run Data, record JsonElement, exclude bool) JsonElement {
            Verification.Candidate(checkout)
            let baseline = ProtectedPaths.LocalTree(checkout, run.Text("base"))
            for entry in baseline {
                PathName(entry.Key)
                if Excluded(entry.Key) ||
                    (
                    !entry.Value.StartsWith("040000 tree ") && !entry.Value.StartsWith("100644 blob ") &&
                        !entry
                        .Value
                        .StartsWith("100755 blob ")
                ) {
                    throw Exception("Unsupported generated, linked or submodule path in approved base: " + entry.Key)
                }
            }
            let index = Dictionary[string, string](StringComparer.Ordinal)
            for entry in Paths(Commands.GitRaw(checkout, []string{"ls-files", "--stage", "-z"})) {
                let tab = entry.IndexOf('\t')
                let fields = (tab < 0 ? "": entry.Substring(0, tab)).Split(' ')
                let path = tab < 0 ? "": entry.Substring(tab + 1)
                PathName(path)
                if fields.Length != 3 || fields[2] != "0" || !index.TryAdd(
                    path,
                    fields[0] + " blob " + RepositoryIdentity.CommitSha(fields[1])
                ) ||
                    Excluded(path) {
                    throw Exception("Ambiguous or unsupported continuation index")
                }
            }
            let files = HashSet[string](StringComparer.Ordinal)
            Files(checkout, "", files, HashSet[string](StringComparer.Ordinal), exclude)
            let changed = HashSet[string](StringComparer.Ordinal)
            for entry in index {
                var original string
                if !baseline.TryGetValue(entry.Key, out original) || original != entry.Value {
                    changed.Add(entry.Key)
                }
            }
            for path in Paths(
                Commands.GitRaw(
                    checkout,
                    []string{
                        "-c",
                        "diff.autoRefreshIndex=false",
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-renames",
                        "--name-only",
                        "-z",
                        run.Text("base"),
                        "--"
                    }
                )
            ) {
                PathName(path)
                changed.Add(path)
            }
            for path in files {
                if !baseline.ContainsKey(path) {
                    changed.Add(path)
                }
            }
            if changed.Count > 1000 {
                throw Exception("Continuation exceeds 1000 changed paths")
            }
            let entries = List[Object]()
            let ordered = List[string](changed)
            ordered.Sort(StringComparer.Ordinal)
            var total int32
            for path in ordered {
                PathName(path)
                if Excluded(path) {
                    throw Exception("Tracked generated or credential path changes cannot be imported: " + path)
                }
                var mode = "deleted"
                var content = ""
                var blob = ""
                if files.Contains(path) {
                    let bytes = Bytes(Path.Combine(checkout, path), Limit - total)
                    total += bytes.Length
                    mode = (
                        File.GetUnixFileMode(Path.Combine(checkout, path)) & (
                            UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute
                        )
                    ) != 0 ? "100755": "100644"
                    content = Convert.ToBase64String(bytes)
                    blob = Blob(bytes)
                }
                var staged string
                var original string
                let hasStaged = index.TryGetValue(path, out staged)
                let hasOriginal = baseline.TryGetValue(path, out original)
                if hasOriginal && original.StartsWith("040000 tree ") {
                    throw Exception("Continuation does not support file/directory replacement: " + path)
                }
                let current = mode == "deleted" ? "": mode + " blob " + blob
                if (hasStaged ? staged: "") != (hasOriginal ? original: "") && (hasStaged ? staged: "") != current {
                    throw Exception("Staged and available file evidence disagree: " + path)
                }
                if hasOriginal && original == current {
                    continue
                }
                ProtectedPaths.Check(J.Get(record, "policy"), J.Get(record, "approval"), path)
                entries.Add(J.Map("path", path, "mode", mode, "blob", blob, "content", content))
            }
            return J.Parse(J.Write(entries))
        }

        private func Evidence(directory string) JsonElement {
            let result = J.Map()
            for name in[]string{
                "run.json",
                "events.jsonl",
                "stderr.log",
                "report.md",
                "verification.json",
                "candidate.patch",
                "changes.patch"
            } {
                let path = Path.Combine(directory, name)
                if FileInfo(path).LinkTarget != nil {
                    throw Exception("Source evidence must not be linked")
                }
                result[name] = File.Exists(path) ? Convert.ToHexString(SHA256.HashData(Bytes(path)))
                    .ToLowerInvariant(): nil
            }
            return J.Parse(J.Write(result))
        }

        internal func Capture(directory string, run Data, record JsonElement) {
            let sourceDirectory = run.Text("continuation_source")
            using let sourceLease = SourceLease(sourceDirectory)
            let source = Source(sourceDirectory, run, record)
            let sourceText = Encoding.UTF8.GetString(Bytes(Path.Combine(sourceDirectory, "run.json"), 1024 * 1024))
            if Data.Hash(sourceText) != run.Text("continuation_source_metadata_sha256") || !RequestData.Same(
                Provenance(source),
                J.Get(run.Element(), "continuation")
            ) {
                throw Exception(
                    "Source metadata or attribution changed since explicit preparation; source is preserved"
                )
            }
            let evidence = Evidence(sourceDirectory)
            let entries = Scan(Path.Combine(sourceDirectory, "checkout"), source, record, true)
            if entries.GetArrayLength() == 0 {
                throw Exception("No supported preserved changes to import")
            }
            if !RequestData.Same(evidence, Evidence(sourceDirectory)) || !RequestData.Same(
                entries,
                Scan(Path.Combine(sourceDirectory, "checkout"), source, record, true)
            ) {
                throw Exception("Source changed during capture; source is preserved")
            }
            let path = Path.Combine(directory, "continuation.json")
            let manifest = J.Write(
                J.Map(
                    "version",
                    1,
                    "source_metadata",
                    sourceText,
                    "evidence",
                    evidence,
                    "predecessor",
                    Provenance(source),
                    "entries",
                    entries
                )
            )
            if File.Exists(path) {
                if Encoding.UTF8.GetString(Bytes(path, 48 * 1024 * 1024)) != manifest {
                    throw Exception(
                        "Interrupted capture differs from source; inspect this saved preparation, no new reservation is created"
                    )
                }
            } else {
                if FileInfo(path).LinkTarget != nil || FileInfo(path + ".tmp").LinkTarget != nil {
                    throw Exception("Unsafe capture manifest path")
                }
                File.WriteAllText(path + ".tmp", manifest)
                File.Move(path + ".tmp", path)
            }
            run.Fields["continuation"] = Provenance(source)
            run.Fields["continuation_manifest_sha256"] = Data.Hash(manifest)
            run.Fields["continuation_phase"] = "captured"
            run.Save(directory)
        }

        private func Manifest(directory string, run Data) JsonElement {
            let text = Encoding.UTF8.GetString(Bytes(Path.Combine(directory, "continuation.json"), 48 * 1024 * 1024))
            if Data.Hash(text) != run.Text("continuation_manifest_sha256") {
                throw Exception("Captured continuation manifest changed; inspect the original preparation")
            }
            let manifest = J.Parse(text)
            if J.Number(manifest, "version") != 1 || !RequestData.Same(
                J.Get(manifest, "predecessor"),
                J.Get(run.Element(), "continuation")
            ) {
                throw Exception("Continuation predecessor evidence changed")
            }
            let paths = HashSet[string](StringComparer.Ordinal)
            var total int32
            for entry in J.Items(J.Get(manifest, "entries")) {
                let path = J.Text(entry, "path")
                PathName(path)
                if !paths.Add(path) || paths.Count > 1000 || Excluded(path) {
                    throw Exception("Unsafe or ambiguous captured continuation paths")
                }
                let mode = J.Text(entry, "mode")
                let bytes = Convert.FromBase64String(J.Text(entry, "content"))
                total += bytes.Length
                if total > Limit ||
                    (mode != "deleted" && mode != "100644" && mode != "100755") ||
                    (
                    mode == "deleted" ? bytes.Length != 0 || J.Text(entry, "blob") != "": Blob(bytes) != J.Text(
                        entry,
                        "blob"
                    )
                ) {
                    throw Exception("Inconsistent captured continuation content")
                }
            }
            return manifest
        }

        internal func Check(directory string, run Data, record JsonElement, allowPartial bool = false) {
            let manifest = Manifest(directory, run)
            Grant(record, J.Text(J.Get(manifest, "predecessor"), "approval"), J.Get(run.Element(), "donor_id"))
            let checkout = Path.Combine(directory, "checkout")
            let staged = Commands.GitResult(checkout, []string{"diff", "--cached", "--quiet", run.Text("base"), "--"})
            if staged.Code != 0 || staged.Truncated || staged.ReadFailed {
                throw Exception("Import target index differs from the approved base")
            }
            let actual = Scan(checkout, run, record, false)
            let expected = J.Get(manifest, "entries")
            if !allowPartial {
                if !RequestData.Same(actual, expected) {
                    throw Exception(
                        "Imported edits differ from their captured manifest; inspect this preparation before inference"
                    )
                }
            } else {
                let allowed = Dictionary[string, string](StringComparer.Ordinal)
                for entry in J.Items(expected) {
                    allowed.Add(J.Text(entry, "path"), RequestData.Canonical(entry))
                }
                for entry in J.Items(actual) {
                    var value string
                    if !allowed.TryGetValue(J.Text(entry, "path"), out value) || value != RequestData.Canonical(entry) {
                        throw Exception(
                            "Interrupted import has dirty or unrelated edits; inspect this saved preparation"
                        )
                    }
                }
            }
        }

        internal func Import(directory string, run Data, record JsonElement) {
            if run.Text("continuation_phase") == "" {
                Capture(directory, run, record)
            }
            let manifest = Manifest(directory, run)
            Check(directory, run, record, run.Text("continuation_phase") != "imported")
            if run.Text("continuation_phase") == "imported" {
                return
            }
            run.Fields["continuation_phase"] = "importing"
            run.Save(directory)
            let checkout = Path.Combine(directory, "checkout")
            for entry in J.Items(J.Get(manifest, "entries")) {
                let path = Path.Combine(checkout, J.Text(entry, "path"))
                if J.Text(entry, "mode") == "deleted" {
                    File.Delete(path)
                } else {
                    Directory.CreateDirectory(Path.GetDirectoryName(path) ?? checkout)
                    LocalPaths.DirectoryPath(Path.GetDirectoryName(path) ?? checkout)
                    if FileInfo(path).LinkTarget != nil || Directory.Exists(path) {
                        throw Exception("Unsafe import target")
                    }
                    File.WriteAllBytes(path, Convert.FromBase64String(J.Text(entry, "content")))
                    File.SetUnixFileMode(
                        path,
                        J.Text(
                            entry,
                            "mode"
                        ) == "100755" ? UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute: UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead
                    )
                }
            }
            Check(directory, run, record)
            run.Fields["continuation_phase"] = "imported"
            run.Save(directory)
        }
    }
}
