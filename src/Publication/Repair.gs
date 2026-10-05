package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class Repair {
    shared {
        internal func Summary(value JsonElement) string ->
        "Repair provenance: original private state was unavailable. Original logs, usage and verification were not reconstructed or re-attested. " +
            "Only this exact correction received new independent owner verification; no coding inference was launched. " +
            "Original execution observations describe original work only. Owner CI and review remain required."

        internal func Receipt(repo string, pull JsonElement, receipt JsonElement, record JsonElement) {
            let value = J.Get(receipt, "repair")
            RequestData.Keys(value, "id,previous,head,seconds,sync,donor_id,head_repository_id,original_private_state")
            var id Guid
            let policy = Policy(J.Write(J.Get(record, "policy")))
            if !Guid.TryParseExact(J.Text(value, "id"), "D", out id) || J.Text(
                value,
                "original_private_state"
            ) != "unavailable" ||
                J.Number(value, "seconds") < 1 || J.Number(value, "seconds") > J.Number(policy.Value, "max_seconds") {
                throw Exception("Invalid repair provenance")
            }
            RepositoryIdentity.CommitSha(J.Text(value, "head"))
            RepositoryIdentity.CommitSha(J.Text(value, "previous"))
            let actor = RepositoryIdentity.PositiveId(J.Get(value, "donor_id"))
            if actor != RepositoryIdentity.PositiveId(J.Get(J.Get(pull, "user"), "id")) {
                throw Exception("Repair numeric donor differs from PR author")
            }
            let grant = Synchronization.Load(repo, RepositoryIdentity.CommitSha(J.Text(value, "sync")))
            let original = J.Get(grant, "receipt")
            for key in[]string{
                "version",
                "repo",
                "issue",
                "donor",
                "approval",
                "model",
                "effort",
                "seconds",
                "network",
                "policy",
                "correction"
            } {
                if !RequestData.Same(J.Get(original, key), J.Get(receipt, key)) {
                    throw Exception("Repair changed original public provenance: " + key)
                }
            }
            let approval = J.Get(record, "approval")
            let head = J.Get(pull, "head")
            let headInfo = GitHub.Api("repos/" + RepositoryIdentity.Repo(J.Text(J.Get(head, "repo"), "full_name")))
            if RepositoryIdentity.PositiveId(J.Get(headInfo, "id")) != RepositoryIdentity.PositiveId(
                J.Get(value, "head_repository_id")
            ) {
                throw Exception("Repair receipt head repository identity changed")
            }
            RepositoryAccess.ValidateFork(
                repo,
                J.Parse(
                    J.Write(
                        J.Map(
                            "fork",
                            J.Text(J.Get(head, "repo"), "full_name"),
                            "branch",
                            J.Text(head, "ref"),
                            "head",
                            J.Text(head, "sha")
                        )
                    )
                ),
                J.Get(value, "donor_id")
            )
            if J.Number(grant, "approval_version") != 1 || J.Number(grant, "pr") != J.Number(pull, "number") || J.Text(
                grant,
                "candidate"
            ) != J.Text(value, "head") || J.Text(grant, "previous") != J.Text(value, "previous") || J.Text(
                grant,
                "approval"
            ) != J.Text(receipt, "approval") || J.Text(grant, "base") != J.Text(approval, "base") || J.Text(
                original,
                "donor"
            ) != J.Text(receipt, "donor") || J.Number(grant, "issue") != J.Number(receipt, "issue") ||
                !RepositoryIdentity.SameRepo(J.Text(grant, "fork"), J.Text(J.Get(head, "repo"), "full_name")) || J.Text(
                grant,
                "branch"
            ) != J.Text(head, "ref") {
                throw Exception("Repair receipt differs from exact owner grant")
            }
            var found bool
            for item in J.Items(Synchronization.History(receipt)) {
                found = found ||
                    (
                    J.Text(item, "grant") == J.Text(value, "sync") && J.Text(item, "candidate") == J.Text(value, "head")
                )
            }
            if !found {
                throw Exception("Repair lacks historical synchronization authority")
            }
            let amendment = J.Get(receipt, "amendment")
            if J.Text(amendment, "id") == J.Text(value, "id") {
                if J.Text(receipt, "head") != J.Text(value, "head") || J.Text(amendment, "previous") != J.Text(
                    value,
                    "previous"
                ) ||
                    J.Number(amendment, "seconds") != J.Number(value, "seconds") || J.Text(amendment, "sync") != J.Text(
                    value,
                    "sync"
                ) ||
                    J
                    .Items(J.Get(amendment, "tools")).Count != 0 {
                    throw Exception("Repair differs from current exact-head amendment")
                }
            }
        }

        private func Marker(body string) string {
            let matches = Regex.Matches(body, "<!-- tokate-run:[0-9a-f]{32} -->")
            if matches.Count != 1 || Regex.Matches(body, "<!-- tokate-run:").Count != 1 || body.Contains(
                "<!-- tokate-v2:"
            ) ||
                !body
                .Contains("<!-- tokate-report:start -->") {
                throw Exception("Repair requires unambiguous native v1 ownership and marked report regions")
            }
            PrBody.Owned(body, "")
            return matches[0].Value
        }

        private func Pull(intent Data) JsonElement {
            let pull = GitHub.Api("repos/" + intent.Text("repo") + "/pulls/" + intent.Number("pr").ToString())
            let head = J.Get(pull, "head")
            let base = J.Get(pull, "base")
            let mergedAt = J.Get(pull, "merged_at").ValueKind
            if J.Number(pull, "number") != intent.Number("pr") || J.Text(pull, "state") != "open" || !J.Bool(
                pull,
                "draft"
            ) ||
                J.Bool(pull, "merged") ||
                (mergedAt != JsonValueKind.Null && mergedAt != JsonValueKind.Undefined) ||
                !RepositoryIdentity.SameDonor(J.Get(pull, "user"), intent) || J.Text(head, "ref") != intent.Text(
                "branch"
            ) ||
                !RepositoryIdentity.SameRepo(J.Text(J.Get(head, "repo"), "full_name"), intent.Text("head_repo")) ||
                J.Text(base, "ref") != intent.Text("base_branch") || !RepositoryIdentity.SameRepo(
                J.Text(J.Get(base, "repo"), "full_name"),
                intent.Text("repo")
            ) ||
                Marker(J.Text(pull, "body")) != intent.Text("marker") {
                throw Exception("Repair PR identity, draft status or ownership changed")
            }
            let sha = J.Text(head, "sha")
            let reference = GitHub.Api("repos/" + intent.Text("head_repo") + "/git/ref/heads/" + intent.Text("branch"))
            let object = J.Get(reference, "object")
            if J.Text(object, "type") != "commit" || J.Text(object, "sha") != sha ||
                (sha != intent.Text("previous") && sha != intent.Text("commit")) ||
                (
                sha == intent.Text("commit") && intent.Text("state") != "publishing" && intent.Text(
                    "state"
                ) != "published"
            ) {
                throw Exception("Exact remote PR branch head changed; repair intent retained")
            }
            return pull
        }

        private func Authority(intent Data) JsonElement {
            let repo = intent.Text("repo")
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, intent) {
                throw CliFailure("authentication_required", "Repair requires the original authenticated numeric donor")
            }
            let info = GitHub.Api("repos/" + intent.Text("head_repo"))
            RepositoryAccess.ValidateRepository(
                repo,
                intent.Text("head_repo"),
                J.Get(viewer, "id"),
                info,
                upstream: GitHub.Api("repos/" + repo)
            )
            if RepositoryIdentity.PositiveId(J.Get(info, "id")) != RepositoryIdentity.PositiveId(
                J.Get(intent.Element(), "head_repository_id")
            ) {
                throw Exception("Repair head repository identity changed")
            }
            let record = OwnerApproval.Approved(repo, intent.Number("issue"), intent.Text("donor"))
            let approval = J.Get(record, "approval")
            if J.Text(record, "sha") != intent.Text("approval") || J.Text(approval, "base") != intent.Text("base") ||
                J.Text(approval, "base_branch") != intent.Text("base_branch") || J.Text(
                approval,
                "policy_hash"
            ) != intent.Text("policy_hash") || J.Text(approval, "template_hash") != intent.Text("template_hash") {
                throw CliFailure("stale_approval", "Original repair approval changed")
            }
            if !RequestData.Same(Synchronization.Load(repo, intent.Text("sync")), J.Get(intent.Element(), "grant")) {
                throw Exception("Saved repair grant changed")
            }
            if !RequestData.Same(
                PrBody.Receipt(intent.Text("previous_body")),
                J.Get(J.Get(intent.Element(), "grant"), "receipt")
            ) {
                throw Exception("Saved original receipt differs from repair grant")
            }
            Synchronization.Live(
                repo,
                intent.Number("pr"),
                record,
                intent.Text("approval"),
                Synchronization.History(intent.Element()),
                intent.Text("head_repo"),
                intent.Text("branch"),
                intent.Text("commit"),
                intent.Text("sync"),
                previous: intent.Text("previous")
            )
            Policy(J.Write(J.Get(record, "policy"))).ValidateBudget(intent.Number("seconds"), intent.Flag("network"))
            Pull(intent)
            return record
        }

        private func Snapshot(intent Data, record JsonElement) string {
            let checkout = Verification.Candidate(intent.Text("checkout"))
            if Commands.Git(checkout, "rev-parse", "--is-bare-repository") != "false" || Path.GetFullPath(
                Commands.Git(checkout, "rev-parse", "--show-toplevel")
            ) != checkout ||
                Path.GetFullPath(Commands.Git(checkout, "rev-parse", "--absolute-git-dir")) != Path.Combine(
                checkout,
                ".git"
            ) {
                throw Exception("Repair requires self-contained Git metadata for this exact checkout")
            }
            let commit = intent.Text("commit")
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit || Commands.Git(
                checkout,
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignore-submodules=none"
            ) != "" {
                throw Exception("Repair requires a clean checkout at the exact authorized candidate")
            }
            for name in[]string{
                "MERGE_HEAD",
                "CHERRY_PICK_HEAD",
                "REVERT_HEAD",
                "shallow",
                "rebase-apply",
                "rebase-merge",
                "sequencer"
            } {
                if Path.Exists(Path.Combine(checkout, ".git", name)) {
                    throw Exception("Repair refuses incomplete or ambiguous Git metadata: " + name)
                }
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", intent.Text("previous"), commit)
            Commands.Git(checkout, "merge-base", "--is-ancestor", intent.Text("base"), commit)
            Commands.Git(checkout, "diff", "--no-ext-diff", "--no-textconv", "--check", intent.Text("base"), commit)
            Synchronization.Local(
                checkout,
                intent.Text("repo"),
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                intent.Text("base"),
                Synchronization.History(intent.Element()),
                commit
            )
            return Commands.Git(checkout, "show", "-s", "--format=raw", commit) + "\n" + Commands.Git(
                checkout,
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                intent.Text("base"),
                commit
            )
        }

        private func Candidate(directory string, intent Data, record JsonElement) {
            let snapshot = Snapshot(intent, record)
            let file = Path.Combine(directory, "candidate.patch")
            if FileInfo(file).LinkTarget != nil || Data.Hash(snapshot) != intent.Text("snapshot") || File.ReadAllText(
                file
            ) != snapshot {
                throw Exception("Verified repair candidate changed; saved evidence retained")
            }
        }

        private func Output(directory string, intent Data) {
            PublicOutput.ResultData = J.Map(
                "repair",
                PublicOutput.ChangeSummary(intent, directory),
                "original_private_state",
                "unavailable",
                "repair_directory",
                directory,
                "repo",
                intent.Text("repo"),
                "pr",
                intent.Number("pr"),
                "pr_url",
                intent.Text("pr_url")
            )
        }

        internal func Run(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            let checkout = Verification.Validate(args.Need("path"))
            if directory == checkout || directory.StartsWith(checkout + "/") || checkout.StartsWith(directory + "/") {
                throw Exception("Repair evidence and candidate checkout must be separate directories")
            }
            LocalPaths.DirectoryPath(Path.GetDirectoryName(directory) ?? "/")
            if FileInfo(directory).LinkTarget != nil {
                throw Exception("Repair evidence directory must not be a link")
            }
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            LocalPaths.DirectoryPath(directory)
            let path = Path.Combine(directory, "repair.json")
            if File.Exists(Path.Combine(directory, "run.json")) || FileInfo(path).LinkTarget != nil || FileInfo(
                Path.Combine(directory, ".lock")
            ).LinkTarget != nil {
                throw Exception("Use a separate repair evidence directory without linked records")
            }
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            var intent Data
            if File.Exists(path) {
                intent = Data.Read(path)
                if intent.Text("repo") != args.Need("repo") || intent.Number("pr") != args.Number("pr") || intent.Text(
                    "checkout"
                ) != checkout ||
                    intent.Text("commit") != args.Need("commit") || intent.Text("sync") != args.Need("sync") ||
                    intent.Number("seconds") != args.Number("seconds") || intent.Flag("network") != (
                    args.Get("allow-network") == "true"
                ) {
                    throw Exception(
                        "Saved repair inputs changed; preserve this intent and use an explicit new correction"
                    )
                }
            } else {
                for entry in Directory.EnumerateFileSystemEntries(directory) {
                    if Path.GetFileName(entry) != ".lock" {
                        throw Exception("New repair evidence directory must be empty")
                    }
                }
                let repo = args.Need("repo")
                let pr = args.Number("pr")
                ReceiptVerification.Verify(repo, pr, false)
                let pull = GitHub.Api("repos/" + repo + "/pulls/" + pr.ToString())
                let receipt = PrBody.Receipt(J.Text(pull, "body"))
                if J.Number(receipt, "version") != 1 {
                    throw Exception("Repair supports only native version-1 draft PRs")
                }
                let viewer = GitHub.Api("user")
                let author = J.Get(pull, "user")
                if RepositoryIdentity.PositiveId(J.Get(viewer, "id")) != RepositoryIdentity.PositiveId(
                    J.Get(author, "id")
                ) ||
                    J.Text(viewer, "login") != J.Text(receipt, "donor") {
                    throw CliFailure(
                        "authentication_required",
                        "Repair requires the original authenticated numeric donor"
                    )
                }
                let record = OwnerApproval.Approved(repo, J.Number(receipt, "issue"), J.Text(receipt, "donor"))
                let approval = J.Get(record, "approval")
                let grant = Synchronization.Load(repo, args.Need("sync"))
                if !RequestData.Same(J.Get(grant, "receipt"), receipt) || J.Number(grant, "pr") != pr || J.Text(
                    grant,
                    "candidate"
                ) != args.Need("commit") || J.Text(grant, "candidate") == J.Text(receipt, "head") {
                    throw Exception("Owner grant must authorize this exact correction and original receipt")
                }
                intent = Data()
                intent.Fields["id"] = Guid.NewGuid().ToString("D")
                intent.Fields["repo"] = repo
                intent.Fields["pr"] = pr
                intent.Fields["pr_url"] = J.Text(pull, "html_url")
                intent.Fields["issue"] = J.Number(receipt, "issue")
                intent.Fields["donor"] = J.Text(receipt, "donor")
                intent.Fields["donor_id"] = J.Get(author, "id")
                intent.Fields["head_repo"] = J.Text(grant, "fork")
                intent.Fields["head_repository_id"] = RepositoryIdentity.PositiveId(
                    J.Get(GitHub.Api("repos/" + J.Text(grant, "fork")), "id")
                )
                intent.Fields["branch"] = J.Text(grant, "branch")
                intent.Fields["approval"] = J.Text(record, "sha")
                for key in[]string{"base", "base_branch", "policy_hash", "template_hash"} {
                    intent.Fields[key] = J.Get(approval, key)
                }
                intent.Fields["checkout"] = checkout
                intent.Fields["previous"] = J.Text(receipt, "head")
                intent.Fields["commit"] = args.Need("commit")
                intent.Fields["seconds"] = args.Number("seconds")
                intent.Fields["network"] = args.Get("allow-network") == "true"
                intent.Fields["sync"] = args.Need("sync")
                intent.Fields["grant"] = grant
                intent.Fields["original_private_state"] = "unavailable"
                intent.Fields["previous_body"] = J.Text(pull, "body")
                intent.Fields["marker"] = Marker(J.Text(pull, "body"))
                Synchronization.Keep(
                    intent.Fields,
                    Synchronization.Append(repo, Synchronization.History(receipt), args.Need("sync"))
                )
                intent.Fields["state"] = "prepared"
                Authority(intent)
                let snapshot = Snapshot(intent, record)
                intent.Fields["snapshot"] = Data.Hash(snapshot)
                File.WriteAllText(Path.Combine(directory, "candidate.patch"), snapshot)
                intent.Write(path)
            }
            Output(directory, intent)
            try {
                let record = Authority(intent)
                Candidate(directory, intent, record)
                if intent.Text("state") == "failed" || intent.Text("state") == "verifying" {
                    throw CliFailure(
                        "verification_failed",
                        "Repair verification failed or was interrupted; evidence retained, checks will not repeat"
                    )
                }
                if intent.Text("state") == "prepared" {
                    Verify(directory, intent, record)
                }
                if intent.Text("state") != "verified" && intent.Text("state") != "publishing" && intent.Text(
                    "state"
                ) != "published" {
                    throw Exception("Invalid saved repair state")
                }
                PublicOutput.FailureCode = "command_failed"
                Publish(directory, intent)
            } catch (error Exception) {
                intent.Fields["error"] = error.Message
                intent.Fields["failure_reason"] = error is CliFailure failure ? failure.Code: PublicOutput.FailureCode
                intent.Write(path)
                Terminal.Message(
                    "Repair evidence retained: " + directory + ". No automatic retry was made.",
                    error: true
                )
                throw error
            } finally {
                Output(directory, intent)
            }
        }

        private func Verify(directory string, intent Data, record JsonElement) {
            let path = Path.Combine(directory, "repair.json")
            let seconds = intent.Number("seconds")
            let timer = Stopwatch.StartNew()
            let results = List[Object]()
            intent.Fields["state"] = "verifying"
            intent.Write(path)
            try {
                Terminal.Step("Verifying repair independently. No coding inference will run.")
                let budget = RuntimeBudget(timer, seconds)
                {
                    using let workspace = VerificationWorkspace.Create(intent.Text("checkout"), budget)
                    for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                        let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                        if remaining < 1 {
                            throw CliFailure("verification_failed", "Repair verification budget exhausted")
                        }
                        intent.Fields["verification"] = results
                        intent.Write(path)
                        let result = Terminal.Verify(
                            directory,
                            results,
                            command,
                            intent.Text("checkout"),
                            intent.Flag("network"),
                            remaining,
                            budget: budget,
                            workspace: workspace
                        )
                        intent.Write(path)
                        if result.Code != 0 {
                            throw CliFailure(
                                "verification_failed",
                                "Repair owner verification failed; saved progress retained"
                            )
                        }
                    }
                    workspace.Unchanged(budget)
                }
                Candidate(directory, intent, record)
                Verification.Results(intent, record)
                intent.Fields["state"] = "verified"
            } catch (error Exception) {
                intent.Fields["state"] = "failed"
                throw error
            } finally {
                intent.Fields["verification"] = results
                intent.Fields["elapsed_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
                intent.Write(path)
            }
        }

        private func Publish(directory string, intent Data) {
            let record = Authority(intent)
            Verification.Results(intent, record)
            Candidate(directory, intent, record)
            let pull = Pull(intent)
            let oldBody = intent.Text("previous_body")
            let oldOwned = PrBody.Owned(oldBody, "")
            if intent.Text("state") == "verified" {
                if PrBody.Owned(J.Text(pull, "body"), "") != oldOwned || J.Text(
                    J.Get(pull, "head"),
                    "sha"
                ) != intent.Text("previous") {
                    throw Exception("Original owned receipt/report or head changed before repair publication")
                }
                let fields = Dictionary[string, Object?]()
                for field in PrBody.Receipt(oldBody).EnumerateObject() {
                    fields[field.Name] = field.Value
                }
                fields["head"] = intent.Text("commit")
                if !fields.ContainsKey("original_head") {
                    fields["original_head"] = intent.Text("previous")
                }
                fields["amendment"] = J.Map(
                    "id",
                    intent.Text("id"),
                    "previous",
                    intent.Text("previous"),
                    "seconds",
                    intent.Number("seconds"),
                    "tools",
                    J.Parse("[]"),
                    "sync",
                    intent.Text("sync")
                )
                let provenance = J.Map(
                    "id",
                    intent.Text("id"),
                    "previous",
                    intent.Text("previous"),
                    "head",
                    intent.Text("commit"),
                    "seconds",
                    intent.Number("seconds"),
                    "sync",
                    intent.Text("sync"),
                    "donor_id",
                    J.Get(intent.Element(), "donor_id"),
                    "head_repository_id",
                    J.Get(intent.Element(), "head_repository_id"),
                    "original_private_state",
                    "unavailable"
                )
                fields["repair"] = provenance
                Synchronization.Keep(fields, Synchronization.History(intent.Element()))
                let report = Amendment.Summary(
                    intent.Text("previous"),
                    intent.Text("commit"),
                    intent.Number("seconds"),
                    J.Parse("[]")
                ) +
                    "\n\n" +
                    Summary(J.Parse(J.Write(provenance)))
                intent.Fields["body"] = PrBody.ReplaceBody(J.Text(pull, "body"), "", report, J.Parse(J.Write(fields)))
                intent.Fields["state"] = "publishing"
                intent.Write(Path.Combine(directory, "repair.json"))
                File.WriteAllText(Path.Combine(directory, "publication.json"), J.Write(intent.Element()) + "\n")
            }
            let candidateOwned = PrBody.Owned(intent.Text("body"), "")
            var latest = Pull(intent)
            let owned = PrBody.Owned(J.Text(latest, "body"), "")
            if owned != oldOwned && owned != candidateOwned {
                throw Exception("Repair owned regions changed; uncertain physical state retained")
            }
            if J.Text(J.Get(latest, "head"), "sha") == intent.Text("previous") {
                if owned != oldOwned || intent.Text("state") == "published" {
                    throw Exception("Invalid repair physical state on original head")
                }
                Authority(intent)
                Candidate(directory, intent, record)
                Commands.Git(
                    intent.Text("checkout"),
                    "-c",
                    "credential.helper=",
                    "-c",
                    "credential.helper=!gh auth git-credential",
                    "push",
                    "https://github.com/" + intent.Text("head_repo") + ".git",
                    intent.Text("commit") + ":refs/heads/" + intent.Text("branch"),
                    "--force-with-lease=refs/heads/" + intent.Text("branch") + ":" + intent.Text("previous")
                )
            }
            Authority(intent)
            latest = Pull(intent)
            if J.Text(J.Get(latest, "head"), "sha") != intent.Text("commit") {
                throw Exception("Repair publication is uncertain; repeat the same explicit command to inspect")
            }
            Synchronization.Remote(
                intent.Text("repo"),
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                intent.Text("base"),
                Synchronization.History(intent.Element()),
                intent.Text("head_repo"),
                intent.Text("commit")
            )
            let body = J.Text(latest, "body")
            if PrBody.Owned(body, "") != candidateOwned {
                if PrBody.Owned(body, "") != oldOwned || intent.Text("state") == "published" {
                    throw Exception("PR owned regions changed during repair publication")
                }
                let updated = PrBody.ReplaceBody(
                    body,
                    "",
                    PrBody.ReportText(intent.Text("body"), ""),
                    PrBody.Receipt(intent.Text("body"))
                )
                Authority(intent)
                Candidate(directory, intent, record)
                if J.Text(Pull(intent), "body") != body {
                    throw Exception("PR body changed before repair write; explicit resume required")
                }
                GitHub.Api(
                    "repos/" + intent.Text("repo") + "/pulls/" + intent.Number("pr").ToString(),
                    J.Map("body", updated),
                    "PATCH"
                )
            }
            Authority(intent)
            Candidate(directory, intent, record)
            if PrBody.Owned(J.Text(Pull(intent), "body"), "") != candidateOwned {
                throw Exception("Published repair report/receipt changed")
            }
            ReceiptVerification.Verify(intent.Text("repo"), intent.Number("pr"))
            intent.Fields["state"] = "published"
            intent.Fields.Remove("error")
            intent.Fields.Remove("failure_reason")
            intent.Write(Path.Combine(directory, "repair.json"))
            Terminal.Message(
                "Verified repair published: " + intent.Text("pr_url") +
                    ". Owner CI and review are still required. Saved repair: " +
                    directory
            )
        }
    }
}
