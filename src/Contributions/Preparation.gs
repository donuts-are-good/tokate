package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class Preparation {
    shared {
        internal func RunDirectory(args Args, id string) string {
            let root = Path.GetFullPath(
                args.Get(
                    "runs",
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        ".local",
                        "state",
                        "tokate",
                        "runs"
                    )
                )
            )
            return Path.Combine(root, id)
        }

        private func Identity(run Data, normalized bool = true) string -> Data.Hash(
            J.Write(
                J.Map(
                    "version",
                    run.Number("version"),
                    "id",
                    run.Text("id"),
                    "repo",
                    normalized ? run.Text("repo").ToLowerInvariant(): run.Text("repo"),
                    "issue",
                    run.Number("issue"),
                    "donor_id",
                    J.Get(run.Element(), "donor_id"),
                    "approval",
                    run.Text("approval"),
                    "state_sha",
                    run.Text("state_sha"),
                    "base",
                    run.Text("base"),
                    "base_branch",
                    run.Text("base_branch"),
                    "branch",
                    run.Text("branch"),
                    "source",
                    run.Text("source"),
                    "fork",
                    normalized ? run.Text("requested_fork").ToLowerInvariant(): run.Text("requested_fork"),
                    "head_repo",
                    normalized ? run.Text("head_repo").ToLowerInvariant(): run.Text("head_repo")
                )
            )
        )

        private func Identified(run Data) bool {
            let identity = run.Text("preparation_identity")
            return identity == BoundIdentity(run) || identity == BoundIdentity(run, false)
        }

        private func BoundIdentity(run Data, normalized bool = true) string {
            let identity = Identity(run, normalized)
            if run.Text("attempt") != "" {
                return Data.Hash(identity + ":" + run.Text("attempt"))
            }
            return V1Continuation.Has(run) ? Data.Hash(
                identity + ":" + run.Text("continuation_source") + ":" + RequestData.Canonical(
                    J.Get(run.Element(), "continuation")
                )
            ): identity
        }

        internal func Initialize(directory string, run Data, fork string) {
            for entry in Directory.EnumerateFileSystemEntries(directory) {
                if Path.GetFileName(entry) != ".lock" {
                    Reject(directory)
                }
            }
            run.Fields["requested_fork"] = fork
            run.Fields["preparation_version"] = 1
            run.Fields["preparation_identity"] = BoundIdentity(run)
            run.Fields["state"] = "preparing"
            using let file = FileStream(
                Path.Combine(directory, "run.json"),
                FileStreamOptions{
                    Mode: FileMode.CreateNew,
                    Access: FileAccess.Write,
                    Share: FileShare.None,
                    UnixCreateMode: UnixFileMode.UserRead | UnixFileMode.UserWrite
                }
            )
            using let writer = StreamWriter(file)
            writer.Write(J.Write(run.Fields) + "\n")
        }

        private func Reject(path string) {
            throw CliFailure(
                "invalid_state",
                "Preserved unidentified, dirty or divergent preparation at " +
                    path +
                    ". Inspect and move it aside explicitly, or use its original saved run; then use prepare --run DIR. No files or branches were replaced."
            )
        }

        internal func ControlPaths(directory string) {
            try {
                LocalPaths.DirectoryPath(directory)
            } catch (error Exception) {
                throw Exception(error.Message + "; saved run directory: " + directory, error)
            }
            for name in[]string{".lock", "run.json", "run.json.tmp"} {
                let path = Path.Combine(directory, name)
                if FileInfo(path).LinkTarget != nil {
                    Reject(directory)
                }
                if File.Exists(path) || Directory.Exists(path) {
                    let status = [256]byte
                    if RuntimeMetadataStat(-100, path, 256, 5, status) != 0 ||
                        (BitConverter.ToUInt32(status, 0) & 5) != 5 ||
                        (BitConverter.ToUInt16(status, 28) & 61440) != 32768 ||
                        BitConverter.ToUInt32(status, 16) != 1 {
                        Reject(directory)
                    }
                }
            }
        }

        internal func Lease(directory string) FileStream {
            ControlPaths(directory)
            return File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
        }

        internal func Resume(path string) {
            let directory = Path.GetFullPath(path)
            PublicOutput.RunDirectory = directory
            using let lease = Lease(directory)
            let run = Data.Load(directory)
            Complete(directory, run)
            Terminal.Message("Prepared contribution. Run: " + directory)
        }

        internal func Complete(directory string, run Data) {
            let savedState = run.Text("state")
            let fields = run.Fields
            let failure = "prepare --run requires recorded pre-inference preparation for this contribution; old runs and coding cannot be adopted"
            if run.Number("preparation_version") != 1 || !Identified(run) {
                throw Exception(failure)
            }
            if savedState != "preparing" && savedState != "claimed" {
                throw Exception(failure)
            }
            if fields.ContainsKey("codex_version") || fields.ContainsKey("commit") {
                throw Exception(failure)
            }
            let eventsPath = Path.Combine(directory, "events.jsonl")
            let reportPath = Path.Combine(directory, "report.md")
            if File.Exists(eventsPath) || File.Exists(reportPath) {
                throw Exception(failure)
            }
            let record = ContributionClaim.Recheck(run)
            if V1Continuation.Has(run) && run.Text("continuation_phase") == "" {
                V1Continuation.Capture(directory, run, record)
            }
            let upstream = GitHub.Api("repos/" + RepositoryIdentity.Repo(run.Text("repo")))
            if run.Fields.ContainsKey("preparation_repo_id") && J.Get(upstream, "id").ToString() != J.Get(
                run.Element(),
                "preparation_repo_id"
            )
                .ToString() {
                throw Exception("Selected upstream repository identity changed")
            }
            run.Fields["preparation_repo_id"] = RepositoryIdentity.PositiveId(J.Get(upstream, "id"))
            run.Save(directory)
            Fork(directory, run, upstream)
            Branch(directory, run)
            let checkout = Checkout(directory, run)
            ContributionClaim.Recheck(run)
            CheckFork(run, upstream)
            CheckBranch(run)
            if V1Continuation.Has(run) {
                Source(checkout, run)
                V1Continuation.Import(directory, run, record)
            } else {
                Clean(checkout, run)
            }
            run.Fields["preparation_complete"] = true
            run.Fields["state"] = "claimed"
            run.Save(directory)
            Terminal.Step("Approved source " + run.Text("base") + " for target " + run.Text("base_branch"))
            if run.Text("source") == "external" {
                Terminal.Step("External coding checkout: " + checkout + "; independent verification uses DIR/checkout")
            }
        }

        internal func Ready(directory string, run Data) {
            if !run.Flag("preparation_complete") || !Identified(run) {
                throw Exception("Preparation is incomplete; use prepare --run " + directory + " before work")
            }
            let upstream = GitHub.Api("repos/" + run.Text("repo"))
            if J.Get(upstream, "id").ToString() != J.Get(run.Element(), "preparation_repo_id").ToString() {
                throw Exception("Selected upstream repository identity changed")
            }
            CheckFork(run, upstream)
            CheckBranch(run)
            let checkout = Path.Combine(directory, run.Text("source") == "external" ? "coding": "checkout")
            if V1Continuation.Has(run) {
                Source(checkout, run)
                if run.Text("continuation_phase") != "imported" {
                    throw Exception("Continuation import is incomplete; use prepare --run " + directory)
                }
                V1Continuation.Check(directory, run, ContributionClaim.Recheck(run))
            } else {
                Clean(checkout, run)
            }
        }

        internal func Select(run Data, requested string) {
            let upstream = GitHub.Api("repos/" + RepositoryIdentity.Repo(run.Text("repo")))
            var head = requested
            if head == "" && RepositoryIdentity.PositiveId(
                J.Get(J.Get(upstream, "owner"), "id")
            ) == RepositoryIdentity.PositiveId(J.Get(run.Element(), "donor_id")) {
                head = run.Text("repo")
            }
            if head == "" {
                ApiTransport.BeginDeadline(60)
                try {
                    let candidates = List[string]()
                    var complete bool
                    for page in 1 ... 4 {
                        let items = GitHub.Api(
                            "user/repos?visibility=public&affiliation=owner&per_page=100&page=" + page.ToString()
                        )
                        if items.ValueKind != JsonValueKind.Array {
                            throw Exception("Incomplete fork discovery; select --fork DONOR/NAME explicitly")
                        }
                        let pageItems = J.Items(items)
                        for item in pageItems {
                            if !J.Bool(item, "fork") || RepositoryIdentity.PositiveId(
                                J.Get(J.Get(item, "owner"), "id")
                            ) !=
                            RepositoryIdentity.PositiveId(J.Get(run.Element(), "donor_id")) {
                                continue
                            }
                            let candidate = RepositoryIdentity.Repo(J.Text(item, "full_name"))
                            let info = GitHub.Api("repos/" + candidate)
                            if String.Equals(
                                J.Text(J.Get(info, "parent"), "full_name"),
                                run.Text("repo"),
                                StringComparison.OrdinalIgnoreCase
                            ) {
                                RepositoryAccess.ValidateRepository(
                                    run.Text("repo"),
                                    candidate,
                                    J.Get(run.Element(), "donor_id"),
                                    info,
                                    upstream: upstream
                                )
                                if !candidates.Contains(candidate) {
                                    candidates.Add(candidate)
                                }
                            }
                        }
                        if pageItems.Count < 100 {
                            complete = true
                            break
                        }
                    }
                    if !complete || candidates.Count > 1 {
                        throw Exception(
                            "Ambiguous or incomplete fork discovery; select --fork DONOR/NAME explicitly in a fresh preparation"
                        )
                    }
                    head = candidates.Count == 1 ? candidates[0]: run.Text("donor") + "/" + run.Text("repo")
                        .Split('/')[1]
                } catch (error ApiDeadlineException) {
                    throw Exception("Incomplete fork discovery after 60 seconds; select --fork DONOR/NAME explicitly")
                } finally {
                    ApiTransport.EndDeadline()
                }
            }
            run.Fields["preparation_head"] = RepositoryIdentity.Repo(head)
            run.Fields["head_repo"] = head
            run.Fields["preparation_repo_id"] = RepositoryIdentity.PositiveId(J.Get(upstream, "id"))
        }

        private func Fork(directory string, run Data, upstream JsonElement) {
            let head = RepositoryIdentity.Repo(run.Text("preparation_head"))
            if !RepositoryIdentity.SameRepo(run.Text("head_repo"), head) {
                throw Exception("Saved head repository differs from preparation identity")
            }
            var info = GitHub.Api("repos/" + head, missing: true)
            if info.ValueKind == JsonValueKind.Undefined && !run.Flag("fork_creation_attempted") {
                let donor = run.Text("donor")
                let repo = run.Text("repo")
                if !String.Equals(head.Split('/')[0], donor, StringComparison.OrdinalIgnoreCase) || String.Equals(
                    head,
                    repo,
                    StringComparison.OrdinalIgnoreCase
                ) {
                    throw Exception("A missing fork must belong to the authenticated donor")
                }
                run.Fields["fork_creation_attempted"] = true
                run.Save(directory)
                try {
                    let created = GitHub.Api("repos/" + run.Text("repo") + "/forks", J.Map("name", head.Split('/')[1]))
                    RepositoryAccess.ValidateRepository(
                        run.Text("repo"),
                        head,
                        J.Get(run.Element(), "donor_id"),
                        created,
                        upstream: upstream
                    )
                    run.Fields["preparation_head_id"] = RepositoryIdentity.PositiveId(J.Get(created, "id"))
                    run.Save(directory)
                } catch (error Exception) {
                    run.Fields["fork_creation_error"] = error.Message
                    run.Save(directory)
                }
            }
            for read in 0 ... 5 {
                if read > 0 {
                    select {
                        case <- after(TimeSpan.FromSeconds(1.0)) { }
                    }
                    info = GitHub.Api("repos/" + head, missing: true)
                }
                if info.ValueKind != JsonValueKind.Undefined {
                    RepositoryAccess.ValidateRepository(
                        run.Text("repo"),
                        head,
                        J.Get(run.Element(), "donor_id"),
                        info,
                        upstream: upstream
                    )
                    if run.Fields.ContainsKey("preparation_head_id") && J.Get(info, "id").ToString() != J.Get(
                        run.Element(),
                        "preparation_head_id"
                    )
                        .ToString() {
                        throw Exception("Saved fork identity changed; inspect the original fork")
                    }
                    run.Fields["preparation_head_id"] = RepositoryIdentity.PositiveId(J.Get(info, "id"))
                    run.Save(directory)
                    if run.Flag("fork_creation_attempted") {
                        let branch = RepositoryIdentity.Branch(J.Text(info, "default_branch"))
                        let ready = GitHub.Api(
                            "repos/" + head + "/git/ref/heads/" + Uri.EscapeDataString(branch),
                            missing: true
                        )
                        if ready.ValueKind == JsonValueKind.Undefined {
                            continue
                        }
                    }
                    return
                }
            }
            throw Exception(
                "Fork creation is not ready or its response was lost. Inspect " +
                    head +
                    "; use prepare --run " +
                    directory +
                    " for bounded readiness reads. Creation will not be repeated."
            )
        }

        private func CheckFork(run Data, upstream JsonElement) {
            let info = GitHub.Api("repos/" + RepositoryIdentity.Repo(run.Text("head_repo")))
            RepositoryAccess.ValidateRepository(
                run.Text("repo"),
                run.Text("head_repo"),
                J.Get(run.Element(), "donor_id"),
                info,
                upstream: upstream
            )
            if J.Get(info, "id").ToString() != J.Get(run.Element(), "preparation_head_id").ToString() {
                throw Exception("Saved fork repository identity changed")
            }
        }

        private func Reference(run Data) JsonElement -> GitHub.Api(
            "repos/" + RepositoryIdentity.Repo(run.Text("head_repo")) + "/git/ref/heads/" + Uri.EscapeDataString(
                RepositoryIdentity.Branch(run.Text("branch"))
            ),
            missing: true
        )

        private func CheckBranch(run Data) {
            let reference = Reference(run)
            if reference.ValueKind == JsonValueKind.Undefined {
                throw Exception(
                    "The recorded contribution branch is missing. Inspect remote state and the saved creation result; preparation never repeats a branch mutation. Use the original run after explicitly restoring its approved base branch."
                )
            }
            if J.Text(J.Get(reference, "object"), "sha") != run.Text("base") {
                if run.Text("attempt") != "" {
                    throw Exception("Existing branch work is preserved; continuation remains unsupported until #14")
                }
                Reject("https://github.com/" + run.Text("head_repo") + "/tree/" + run.Text("branch"))
            }
        }

        private func Branch(directory string, run Data) {
            let reference = Reference(run)
            if !run.Flag("branch_creation_attempted") {
                if reference.ValueKind != JsonValueKind.Undefined {
                    if run.Text("attempt") == "" {
                        Reject("https://github.com/" + run.Text("head_repo") + "/tree/" + run.Text("branch"))
                    }
                    ContributionClaim.RecheckV2(run)
                    CheckBranch(run)
                    let pulls = J.Items(
                        GitHub.Api(
                            "repos/" + run.Text("repo") + "/pulls?state=all&head=" + Uri.EscapeDataString(
                                run.Text("donor") + ":" + run.Text("branch")
                            )
                        )
                    )
                    if pulls.Count != 0 {
                        throw Exception("Partial publication is preserved; continuation remains unsupported until #14")
                    }
                    run.Fields["branch_creation_attempted"] = true
                    run.Fields["branch_prepared"] = true
                    run.Save(directory)
                    return
                }
                run.Fields["branch_creation_attempted"] = true
                run.Save(directory)
                try {
                    GitHub.Api(
                        "repos/" + run.Text("head_repo") + "/git/refs",
                        J.Map("ref", "refs/heads/" + run.Text("branch"), "sha", run.Text("base"))
                    )
                } catch (error Exception) {
                    run.Fields["branch_creation_error"] = error.Message
                    run.Save(directory)
                }
            }
            CheckBranch(run)
            run.Fields["branch_prepared"] = true
            run.Save(directory)
        }

        private func Marker(run Data) string -> J.Write(
            J.Map(
                "identity",
                run.Text("preparation_identity"),
                "head_repo",
                run.Text("preparation_head"),
                "head_id",
                J.Get(run.Element(), "preparation_head_id"),
                "repo_id",
                J.Get(run.Element(), "preparation_repo_id")
            )
        )

        private func Owned(checkout string, run Data) {
            LocalPaths.DirectoryPath(checkout)
            LocalPaths.DirectoryPath(Path.Combine(checkout, ".git"))
            let marker = Path.Combine(checkout, ".git/tokate-preparation.json")
            if FileInfo(marker).LinkTarget != nil || !File.Exists(marker) || File.ReadAllText(marker) != Marker(run) {
                Reject(checkout)
            }
        }

        private func Metadata(checkout string) {
            let allowed = []string{
                "core.repositoryformatversion=0",
                "core.filemode=true",
                "core.bare=false",
                "core.logallrefupdates=true"
            }
            for entry in Commands.Git(checkout, "config", "--local", "--no-includes", "--list").Split('\n') {
                if Array.IndexOf(allowed, entry) < 0 {
                    Reject(checkout)
                }
            }
            for name in[]string{"info/attributes", "info/exclude", "hooks"} {
                let path = Path.Combine(checkout, ".git", name)
                if File.Exists(path) || (Directory.Exists(path) && Directory.GetFileSystemEntries(path).Length > 0) {
                    Reject(checkout)
                }
            }
        }

        internal func Source(checkout string, run Data) {
            if run.Number("preparation_version") != 1 || !Identified(run) {
                throw Exception("Unsupported preparation identity; source is preserved")
            }
            Owned(checkout, run)
            Verification.Candidate(checkout)
            Metadata(checkout)
            if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("base") {
                Reject(checkout)
            }
            let branch = Commands.GitResult(checkout, []string{"symbolic-ref", "--quiet", "--short", "HEAD"})
            if run.Text("source") == "external" ? (
                branch.Code != 0 || branch.Output.Trim() != run.Text("branch")
            ): branch.Code != 1 {
                Reject(checkout)
            }
            if run.Text("source") != "external" {
                for file in Commands.Git(checkout, "ls-files").Split('\n') {
                    if file.StartsWith(".codex/") || file.Contains("/.codex/") {
                        throw Exception("Repository Codex configuration is not supported in donor runs")
                    }
                }
            }
        }

        private func Clean(checkout string, run Data) {
            Source(checkout, run)
            if Commands.Git(checkout, "status", "--porcelain", "--untracked-files=all", "--ignored") != "" {
                Reject(checkout)
            }
        }

        private func Checkout(directory string, run Data) string {
            let name = run.Text("source") == "external" ? "coding": "checkout"
            let checkout = Path.Combine(directory, name)
            let staging = Path.Combine(directory, name + ".staging")
            if Directory.Exists(checkout) || File.Exists(checkout) || FileInfo(checkout).LinkTarget != nil {
                if V1Continuation.Has(run) &&
                    (run.Text("continuation_phase") == "importing" || run.Text("continuation_phase") == "imported") {
                    Source(checkout, run)
                    V1Continuation.Check(
                        directory,
                        run,
                        ContributionClaim.Recheck(run),
                        run.Text("continuation_phase") == "importing"
                    )
                } else {
                    Clean(checkout, run)
                }
                if Directory.Exists(staging) || File.Exists(staging) || FileInfo(staging).LinkTarget != nil {
                    Reject(staging)
                }
                return checkout
            }
            if File.Exists(staging) || FileInfo(staging).LinkTarget != nil {
                Reject(staging)
            }
            if !Directory.Exists(staging) {
                run.Fields["checkout_staging"] = name + ".staging"
                run.Save(directory)
                Directory.CreateDirectory(Path.Combine(staging, ".git"))
                File.WriteAllText(Path.Combine(staging, ".git/tokate-preparation.json"), Marker(run))
            }
            Owned(staging, run)
            Verification.Validate(staging)
            if !File.Exists(Path.Combine(staging, ".git/config")) {
                for entry in Directory.EnumerateFileSystemEntries(Path.Combine(staging, ".git")) {
                    if Path.GetFileName(entry) != "tokate-preparation.json" {
                        Reject(staging)
                    }
                }
                Commands.Git(staging, "init", "--quiet", "--template=")
            }
            Metadata(staging)
            let head = Commands.GitResult(staging, []string{"rev-parse", "--verify", "HEAD"})
            if head.Code == 0 {
                Clean(staging, run)
            } else {
                if Commands.Git(staging, "for-each-ref", "--format=%(refname)") != "" || Commands.Git(
                    staging,
                    "ls-files"
                ) != "" {
                    Reject(staging)
                }
                for entry in Directory.EnumerateFileSystemEntries(staging) {
                    if Path.GetFileName(entry) != ".git" {
                        Reject(staging)
                    }
                }
                if File.Exists(Path.Combine(staging, ".git/config")) {
                    Verification.Validate(staging)
                    Metadata(staging)
                }
                Commands.Git(staging, "init", "--quiet", "--template=")
                Verification.Validate(staging)
                Metadata(staging)
                Commands.Git(
                    staging,
                    "fetch",
                    "--quiet",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--",
                    "https://github.com/" + run.Text("repo") + ".git",
                    RepositoryIdentity.CommitSha(run.Text("base"))
                )
                if run.Text("source") == "external" {
                    Commands.Git(
                        staging,
                        "checkout",
                        "--quiet",
                        "-b",
                        RepositoryIdentity.Branch(run.Text("branch")),
                        run.Text("base")
                    )
                } else {
                    Commands.Git(staging, "checkout", "--quiet", "--detach", run.Text("base"))
                }
                Clean(staging, run)
            }
            Directory.Move(staging, checkout)
            Clean(checkout, run)
            run.Fields["checkout_prepared"] = name
            run.Save(directory)
            return checkout
        }
    }
}
