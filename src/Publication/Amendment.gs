package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class Amendment {
    shared {
        internal func Tools(policy Policy, tools JsonElement) {
            if tools.ValueKind != JsonValueKind.Array {
                throw Exception("Amendment tools must be an array; [] declares manual editing")
            }
            if J.Items(tools).Count == 0 {
                return
            }
            RequestData.Tools(tools)
            policy.ValidateEditingTools(tools, "Version-1 amendments permit only declared codex/openai tools")
        }

        internal func ValidateReceipt(value JsonElement, policy Policy, head string) {
            RequestData.Keys(value, "id,previous,seconds,tools,sync,summary")
            var id Guid
            let seconds = J.Number(value, "seconds")
            if !Guid.TryParseExact(J.Text(value, "id"), "D", out id) || seconds < 1 || seconds > J.Number(
                policy.Value,
                "max_seconds"
            ) {
                throw Exception("Invalid amendment receipt or verification budget")
            }
            RepositoryIdentity.CommitSha(J.Text(value, "previous"))
            let summary = J.Get(value, "summary")
            if summary.ValueKind != JsonValueKind.Undefined {
                PublicSummary.Validate(summary, head)
            }
            Tools(policy, J.Get(value, "tools"))
            if J.Get(value, "sync").ValueKind != JsonValueKind.Undefined {
                RepositoryIdentity.CommitSha(J.Text(value, "sync"))
            }
        }

        internal func Summary(
            previous string,
            head string,
            seconds int32,
            tools JsonElement,
            summary JsonElement = default(JsonElement),
            observed bool = false,
            original JsonElement = default(JsonElement)
        ) string {
            if summary.ValueKind != JsonValueKind.Undefined {
                PublicSummary.Validate(summary, head)
            }
            return PublicSummary.Report(
                summary,
                observed ?
                "Tokate observed locally: all original owner checks passed on this amended candidate.":
                "Donor-reported: all original owner checks passed locally; coordinator did not observe execution."
            ) +
                "\n\n- Review amendment: " +
                previous +
                " → " +
                head +
                "; separate " +
                seconds.ToString() +
                " second verification budget; no inference launched by amend.\n" +
                "- Original execution and usage cover original work only." +
                PublicSummary.Tools(tools, "Amendment donor-reported tools") +
                (original.ValueKind == JsonValueKind.Undefined ? "": PrBody.OriginalProvenance(original))
        }

        internal func LegacySummary(previous string, head string, seconds int32, tools JsonElement) string ->
        "Review amendment: " +
            previous +
            " → " +
            head +
            ". Donor reports all original owner commands passed locally with a separate " +
            seconds.ToString() +
            " second verification budget; no inference was launched by amend.\n\n" +
            "Original execution/model/effort/runtime/usage observations cover original work only. Amendment editing: " +
            (
            J.Items(tools).Count == 0 ? "manual; coding time and usage unknown":
            "donor-reported tools " + RequestData.Canonical(tools) +
                "; identity, coding time and usage not independently attested"
        ) +
            ". Owner CI and review must validate this exact amended commit."

        internal func Pull(run Data, number int32, previous string, candidate string) JsonElement {
            let pull = GitHub.Api("repos/" + run.Text("repo") + "/pulls/" + number.ToString())
            let head = J.Get(pull, "head")
            let base = J.Get(pull, "base")
            let headRepo = J.Text(J.Get(head, "repo"), "full_name")
            let mergedAt = J.Get(pull, "merged_at").ValueKind
            let marker = run.Number("version") == 2 ? "<!-- tokate-v2:" + run.Text("id") + " -->":
            "<!-- tokate-run:" + run.Text("id") + " -->"
            let failure = "Existing PR changed, closed or merged; saved amendment retained"
            if J.Number(pull, "number") != number || J.Text(pull, "state") != "open" || J.Bool(pull, "merged") ||
                (mergedAt != JsonValueKind.Undefined && mergedAt != JsonValueKind.Null) {
                throw Exception(failure)
            }
            if !J.Text(pull, "body").Contains(marker) || J.Text(head, "ref") != run.Text("branch") ||
                !RepositoryIdentity.SameRepo(headRepo, run.Text("head_repo")) {
                throw Exception(failure)
            }
            let baseRepo = J.Text(J.Get(base, "repo"), "full_name")
            if J.Text(base, "ref") != run.Text("base_branch") {
                throw Exception(failure)
            }
            if baseRepo != "" && !RepositoryIdentity.SameRepo(baseRepo, run.Text("repo")) {
                throw Exception(failure)
            }
            let headSha = J.Text(head, "sha")
            if headSha != previous && headSha != candidate {
                throw Exception(failure)
            }
            return pull
        }

        internal func Authority(run Data, amendment Data?) JsonElement {
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, run) {
                throw CliFailure("authentication_required", "Use the same donor account and numeric identity")
            }
            if run.Number("version") == 1 {
                let record = ContributionClaim.Recheck(run)
                SyncAuthority(run, amendment, record)
                return record
            }
            if run.Number("version") != 2 {
                throw Exception("Amend requires a native version-1 or version-2 run")
            }
            RepositoryAccess.ValidateRun(run)
            let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(run.Text("repo"), run.Number("issue"), run.Text("donor"), J.Get(viewer, "id"))
            let value = state.Value()
            let original = J.Get(value, "contribution")
            let metadata = J.Get(original, "metadata")
            let approval = J.Get(record, "approval")
            let reservation = J.Get(value, "reservation")
            let actor = J.Get(viewer, "id").ToString()
            let originalActor = J.Get(original, "actor").ToString()
            let reservationId = J.Text(reservation, "reservation")
            if LeaseLifecycle.Supported(value) && run.Text("attempt") != J.Text(reservation, "attempt") {
                throw CliFailure("stale_approval", "Saved amendment attempt fence changed")
            }
            let target = J.Text(approval, "base_branch")
            let policyHash = J.Text(approval, "policy_hash")
            let failure = "Published contribution authority changed"
            if J.Text(value, "approval_id") != run.Text("approval") || reservationId != run.Text("id") ||
                originalActor != actor {
                throw CliFailure("stale_approval", failure)
            }
            if !RepositoryIdentity.SameRepo(J.Text(metadata, "fork"), run.Text("head_repo")) {
                throw CliFailure("stale_approval", failure)
            }
            if J.Text(metadata, "branch") != run.Text("branch") || run.Text("branch") != "tokate/v2-" + run.Text("id") {
                throw CliFailure("stale_approval", failure)
            }
            if run.Text("base") != J.Text(approval, "base") || run.Text("base_branch") != target || run.Text(
                "policy_hash"
            ) != policyHash {
                throw CliFailure("stale_approval", failure)
            }
            if amendment != nil && state.Sha != amendment.Text("expected") {
                let current = CoordinationState.Current(value)
                let outcome = J.Get(current, "outcome")
                let saved = amendment.Element()
                let stale = "Amendment has stale coordination revision"
                let requestId = amendment.Text("id")
                let expected = amendment.Text("expected")
                let savedCommit = amendment.Text("commit")
                let pr = amendment.Number("pr")
                if J.Text(current, "request") != requestId || J.Text(current, "expected") != expected {
                    throw CliFailure("stale_approval", stale)
                }
                let currentActor = J.Get(current, "actor").ToString()
                if J.Text(outcome, "head") != savedCommit || J.Number(outcome, "pr") != pr || currentActor != actor {
                    throw CliFailure("stale_approval", stale)
                }
                let previous = amendment.Text("previous")
                let seconds = amendment.Number("seconds")
                if J.Text(current, "previous") != previous || J.Number(current, "seconds") != seconds {
                    throw CliFailure("stale_approval", stale)
                }
                let declaredTools = RequestData.Canonical(J.Get(current, "tools"))
                let savedTools = RequestData.Canonical(J.Get(saved, "tools"))
                if declaredTools != savedTools {
                    throw CliFailure("stale_approval", stale)
                }
                let syncFailure = "Amendment synchronization differs from coordination authority"
                if J.Text(current, "sync") != amendment.Text("sync") {
                    throw Exception(syncFailure)
                }
                let currentHistory = RequestData.Canonical(Synchronization.History(current))
                let savedHistory = RequestData.Canonical(Synchronization.History(saved))
                if currentHistory != savedHistory {
                    throw Exception(syncFailure)
                }
                let publicationRevision = J.Text(value, "publication_revision")
                let commit = GitHub.Api(
                    "repos/" + run.Text("repo") +
                        "/git/commits/" +
                        (publicationRevision == "" ? state.Sha: publicationRevision)
                )
                let parents = J.Items(J.Get(commit, "parents"))
                if parents.Count != 1 || J.Text(parents[0], "sha") != amendment.Text("expected") {
                    throw Exception("Amendment state is not the exact saved coordination transition")
                }
            } else if CoordinationState.Head(value) != (amendment?.Text("previous") ?? run.Text("commit")) {
                throw Exception("Current published head differs from saved contribution")
            }
            let remoteHead = Remote(
                run,
                amendment?.Text("previous") ?? run.Text("commit"),
                amendment?.Text("commit") ?? ""
            )
            RepositoryAccess.ValidateFork(
                run.Text("repo"),
                J.Parse(
                    J.Write(
                        map[string, Object?]{
                            "fork": run.Text("head_repo"),
                            "branch": run.Text("branch"),
                            "head": remoteHead
                        }
                    )
                ),
                J.Get(viewer, "id")
            )
            SyncAuthority(run, amendment, record, original)
            return J.Parse(J.Write(map[string, Object?]{"record": record, "state": value, "sha": state.Sha}))
        }

        private func SyncAuthority(
            run Data,
            amendment Data?,
            record JsonElement,
            contribution JsonElement = default(JsonElement)
        ) {
            if amendment != nil {
                Synchronization.Live(
                    run.Text("repo"),
                    amendment.Number("pr"),
                    record,
                    run.Text("approval"),
                    Synchronization.History(amendment.Element()),
                    run.Text("head_repo"),
                    run.Text("branch"),
                    amendment.Text("commit"),
                    amendment.Text("sync"),
                    amendment.Text("expected"),
                    amendment.Text("previous"),
                    contribution: contribution
                )
            }
        }

        private func Snapshot(
            checkout string,
            run Data,
            commit string,
            previous string,
            record JsonElement,
            history JsonElement
        ) string {
            let policy = J.Get(record, "policy")
            let approval = J.Get(record, "approval")
            Verification.Candidate(checkout)
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit || Commands.Git(
                checkout,
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignore-submodules=none"
            ) != "" {
                throw Exception("Amend requires a clean checkout at the declared exact commit")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), commit)
            Commands.Git(checkout, "merge-base", "--is-ancestor", previous, commit)
            Commands.Git(checkout, "diff", "--no-ext-diff", "--no-textconv", "--check", run.Text("base"), commit)
            for name in[]string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"} {
                if File.Exists(Path.Combine(checkout, ".git", name)) {
                    throw Exception(
                        "Unresolved or ambiguous conflict operation; preserve evidence and commit an owner-reviewed resolution"
                    )
                }
            }
            if history.GetArrayLength() > 0 {
                Synchronization.Local(checkout, run.Text("repo"), policy, approval, run.Text("base"), history, commit)
            } else {
                ProtectedPaths.Local(checkout, policy, approval, run.Text("base"), commit)
                ProtectedPaths.Local(checkout, policy, approval, previous, commit)
            }
            return Commands.Git(checkout, "rev-parse", "HEAD^{tree}") + "\n" + Commands.Git(
                checkout,
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                run.Text("base"),
                commit
            )
        }

        private func Archive(directory string, run Data) string {
            LocalPaths.DirectoryPath(directory)
            let archive = Path.Combine(directory, "original-evidence")
            if FileInfo(archive).LinkTarget != nil {
                throw Exception("Original evidence archive must not be a link")
            }
            if Directory.Exists(archive) {
                OriginalEvidence.Amended(directory, run)
                let seal = Path.Combine(archive, "seal.json")
                return File.Exists(seal) ? Data.Read(seal).Text("manifest_sha256"): ""
            }
            let staging = Path.Combine(directory, "archive-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(
                staging,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                for file in Directory.EnumerateFiles(directory) {
                    if Path.GetFileName(file) != ".lock" {
                        OriginalEvidence.CopyFile(file, Path.Combine(staging, Path.GetFileName(file)))
                    }
                }
                OriginalEvidence.VerificationArtifacts(directory, staging)
                OriginalEvidence.Seal(staging)
                Directory.Move(staging, archive)
            } finally {
                if Directory.Exists(staging) {
                    Directory.Delete(staging, true)
                }
            }
            return Data.Read(Path.Combine(archive, "seal.json")).Text("manifest_sha256")
        }

        internal func Run(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = Preparation.Lease(directory)
            let run = Data.Load(directory)
            let commit = RepositoryIdentity.CommitSha(args.Need("commit"))
            let seconds = args.Number("seconds")
            let sync = args.Get("sync") == "" ? "": RepositoryIdentity.CommitSha(args.Need("sync"))
            let tools = args.Get("tools") == "" ? J.Parse("[]"): RequestData.FileData(args.Need("tools"), 8192)
            let summary = PublicSummary.FileSummary(args.Get("summary"), commit)
            let location = Path.Combine(directory, "amendments", commit)
            var amendment Data
            if Directory.Exists(location) {
                amendment = Data.Load(location)
                OriginalEvidence.Amended(directory, run, amendment)
                if !RequestData.Same(J.Get(amendment.Element(), "public_summary"), summary) || amendment.Text(
                    "sync"
                ) != sync ||
                    amendment.Number("seconds") != seconds || RequestData.Canonical(
                    J.Get(amendment.Element(), "tools")
                ) != RequestData.Canonical(tools) {
                    throw Exception("Saved amendment budget or editing provenance changed")
                }
            } else {
                let authority = Authority(run, nil)
                let record = run.Number("version") == 2 ? J.Get(authority, "record"): authority
                let policy = Policy(J.Write(J.Get(record, "policy")))
                Tools(policy, tools)
                if seconds > J.Number(policy.Value, "max_seconds") {
                    throw Exception("Amendment verification budget exceeds owner policy")
                }
                let number = run.Number("version") == 2 ? J.Number(
                    J.Get(CoordinationState.Current(J.Get(authority, "state")), "outcome"),
                    "pr"
                ): run.Number("pr")
                let pull = Pull(run, number, run.Text("commit"), "")
                ReceiptVerification.Verify(run.Text("repo"), number, sync == "")
                Remote(run, run.Text("commit"), "")
                let checkout = Verification.Validate(Path.Combine(directory, "checkout"))
                let history = Synchronization.Append(
                    run.Text("repo"),
                    Synchronization.History(PrBody.Receipt(J.Text(pull, "body"))),
                    sync
                )
                let expected = run.Number("version") == 2 ? J.Text(authority, "sha"): ""
                Synchronization.Live(
                    run.Text("repo"),
                    number,
                    record,
                    run.Text("approval"),
                    history,
                    run.Text("head_repo"),
                    run.Text("branch"),
                    commit,
                    sync,
                    expected,
                    run.Text("commit"),
                    contribution: J.Get(J.Get(authority, "state"), "contribution")
                )
                let snapshot = Snapshot(checkout, run, commit, run.Text("commit"), record, history)
                let archive = Archive(directory, run)
                Directory.CreateDirectory(location)
                amendment = Data()
                if archive != "" {
                    amendment.Fields["original_evidence_sha256"] = archive
                }
                amendment.Fields["id"] = Guid.NewGuid().ToString("D")
                amendment.Fields["previous"] = run.Text("commit")
                amendment.Fields["commit"] = commit
                amendment.Fields["seconds"] = seconds
                if summary.ValueKind != JsonValueKind.Undefined {
                    amendment.Fields["public_summary"] = summary
                }
                amendment.Fields["tools"] = tools
                amendment.Fields["pr"] = number
                amendment.Fields["expected"] = run.Number("version") == 2 ? J.Text(authority, "sha"): ""
                if sync != "" {
                    amendment.Fields["sync"] = sync
                    amendment.Fields["synchronization_grant"] = Synchronization.Load(run.Text("repo"), sync)
                }
                Synchronization.Keep(amendment.Fields, history)
                amendment.Fields["state"] = "verifying"
                amendment.Fields["previous_body"] = J.Text(pull, "body")
                amendment.Fields["snapshot"] = Data.Hash(snapshot)
                amendment.Fields["provenance"] =
                "Editing tools, coding time and usage are manual/unknown or donor-reported; " +
                    "original observations cover original execution only"
                amendment.Save(location)
                File.WriteAllText(Path.Combine(location, "candidate.patch"), snapshot)
                File.WriteAllText(
                    Path.Combine(location, "conflict-evidence.txt"),
                    Commands.Git(checkout, "show", "--format=raw", "--cc", "--no-ext-diff", "--no-textconv", commit)
                )
                let timer = Stopwatch.StartNew()
                let results = List[Object]()
                try {
                    Terminal.Step("Verifying review amendment independently. No inference will run.")
                    let budget = RuntimeBudget(timer, seconds)
                    {
                        using let workspace = VerificationWorkspace.Create(checkout, budget)
                        for command in J.Items(J.Get(policy.Value, "verification")) {
                            let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                            if remaining < 1 {
                                throw CliFailure("verification_failed", "Amendment verification budget exhausted")
                            }
                            amendment.Fields["verification"] = results
                            PublicOutput.FailureCode = "verification_failed"
                            amendment.Fields["failure_stage"] = "owner_verification"
                            amendment.Fields["failure_reason"] = "verification_failed"
                            amendment.Save(location)
                            let result = Terminal.Verify(
                                location,
                                results,
                                command,
                                checkout,
                                run.Flag("network") && J.Bool(policy.Value, "allow_network"),
                                remaining,
                                budget: budget,
                                workspace: workspace
                            )
                            if result.Code != 0 {
                                throw CliFailure(
                                    "verification_failed",
                                    "Amendment owner verification failed; saved progress retained"
                                )
                            }
                        }
                        PublicOutput.FailureCode = "invalid_state"
                        amendment.Fields["failure_stage"] = "changed_candidate"
                        amendment.Fields["failure_reason"] = "candidate_changed"
                        workspace.Unchanged(budget)
                    }
                    PublicOutput.FailureCode = "invalid_state"
                    amendment.Fields["failure_stage"] = "changed_candidate"
                    amendment.Fields["failure_reason"] = "candidate_changed"
                    if Snapshot(
                        checkout,
                        run,
                        commit,
                        amendment.Text("previous"),
                        record,
                        Synchronization.History(amendment.Element())
                    ) != snapshot {
                        throw Exception("Verification changed the exact amendment candidate")
                    }
                    amendment.Fields["verification"] = results
                    amendment.Fields["elapsed_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
                    amendment.Fields["state"] = "verified"
                    amendment.Fields.Remove("failure_stage")
                    amendment.Fields.Remove("failure_reason")
                    amendment.Save(location)
                } catch (error Exception) {
                    amendment.Fields["state"] = "failed"
                    amendment.Fields["error"] = error.Message
                    if error is CliFailure failure {
                        amendment.Fields["failure_reason"] = failure.Code
                    } else if !amendment.Fields.ContainsKey("failure_reason") {
                        amendment.Fields["failure_reason"] = "invalid_state"
                    }
                    amendment.Save(location)
                    throw error
                }
            }
            if amendment.Text("state") == "failed" || amendment.Text("state") == "verifying" {
                throw CliFailure(
                    "verification_failed",
                    "Amendment verification failed or interrupted; inspect saved progress and declare a corrected commit"
                )
            }
            try {
                Publish(directory, location, run, amendment)
            } catch (error Exception) {
                amendment.Fields["error"] = error.Message
                amendment.Fields["failure_reason"] = error is CliFailure failure ? failure.Code:
                "publication_interrupted"
                amendment.Save(location)
                if error is CliFailure {
                    throw error
                }
                PublicOutput.FailureCode = "command_failed"
                throw Exception(
                    error.Message +
                        "\nSaved amendment: " +
                        location +
                        ". Remote/PR/state updates are not atomic; a physical PR may have an invalid receipt. Use verify-pr to inspect authority. Re-run the same amend command to resume only saved publication intent without inference or repeating passed checks.",
                    error
                )
            }
        }

        internal func Remote(run Data, previous string, candidate string) string {
            let reference = GitHub.Api("repos/" + run.Text("head_repo") + "/git/ref/heads/" + run.Text("branch"))
            let head = J.Text(J.Get(reference, "object"), "sha")
            if head != previous && head != candidate {
                throw Exception("Remote PR branch changed; saved amendment retained")
            }
            return head
        }

        private func Publish(directory string, location string, run Data, amendment Data) {
            let authority = Authority(run, amendment)
            let record = run.Number("version") == 2 ? J.Get(authority, "record"): authority
            let policy = Policy(J.Write(J.Get(record, "policy")))
            Tools(policy, J.Get(amendment.Element(), "tools"))
            if amendment.Number("seconds") < 1 || amendment.Number("seconds") > J.Number(policy.Value, "max_seconds") ||
                (run.Flag("network") && !J.Bool(policy.Value, "allow_network")) {
                throw Exception("Amendment budget or network exceeds current owner policy")
            }
            Verification.Results(amendment, record)
            let checkout = Verification.Validate(Path.Combine(directory, "checkout"))
            let snapshot = Snapshot(
                checkout,
                run,
                amendment.Text("commit"),
                amendment.Text("previous"),
                record,
                Synchronization.History(amendment.Element())
            )
            let patchPath = Path.Combine(location, "candidate.patch")
            if Data.Hash(snapshot) != amendment.Text("snapshot") || snapshot != File.ReadAllText(patchPath) {
                throw Exception("Verified amendment candidate changed")
            }
            let pull = Pull(run, amendment.Number("pr"), amendment.Text("previous"), amendment.Text("commit"))
            let remote = Remote(run, amendment.Text("previous"), amendment.Text("commit"))
            if J.Text(J.Get(pull, "head"), "sha") != remote {
                throw Exception("Remote branch and PR head disagree")
            }
            let receipt = PrBody.Receipt(J.Text(pull, "body"))
            let previousReceipt = PrBody.Receipt(amendment.Text("previous_body"))
            let legacyReport = run.Number("version") == 1 ? PrBody.LegacyVerificationReport(
                run,
                record,
                previousReceipt
            ):
            PrBody.OriginalReport(J.Get(J.Get(J.Get(authority, "state"), "contribution"), "metadata"))
            if amendment.Text("state") == "verified" {
                if remote != amendment.Text("previous") || J.Text(receipt, "head") != amendment.Text("previous") {
                    throw Exception("Remote changed before amendment publication intent")
                }
                if RequestData.Canonical(receipt) != RequestData.Canonical(previousReceipt) {
                    throw Exception("Previous receipt changed after amendment acceptance")
                }
                let intent = map[string, Object?]{
                    "previous": amendment.Text("previous"),
                    "head": amendment.Text("commit"),
                    "pr": amendment.Number("pr"),
                    "uuid": amendment.Text("id")
                }
                amendment.Fields["publication"] = intent
                let updatedReceipt = Dictionary[string, Object?]()
                for field in receipt.EnumerateObject() {
                    updatedReceipt[field.Name] = field.Value
                }
                updatedReceipt["head"] = amendment.Text("commit")
                if run.Number("version") == 1 {
                    if !updatedReceipt.ContainsKey("original_head") {
                        updatedReceipt["original_head"] = amendment.Text("previous")
                    }
                } else {
                    updatedReceipt["expected"] = amendment.Text("expected")
                }
                updatedReceipt["amendment"] = PublicRecord(amendment)
                Synchronization.Keep(updatedReceipt, Synchronization.History(amendment.Element()))
                if run.Number("version") == 1 {
                    let report = PrBody.AmendmentReport(J.Parse(J.Write(updatedReceipt)))
                    amendment.Fields["body"] = PrBody.ReplaceBody(
                        J.Text(pull, "body"),
                        legacyReport,
                        report,
                        J.Parse(J.Write(updatedReceipt))
                    )
                    amendment.Fields["previous_body"] = J.Text(pull, "body")
                } else {
                    let original = J.Get(J.Get(authority, "state"), "contribution")
                    amendment.Fields["body"] = PrBody.ReplaceBody(
                        J.Text(pull, "body"),
                        PrBody.OriginalReport(J.Get(original, "metadata")),
                        Summary(
                            amendment.Text("previous"),
                            amendment.Text("commit"),
                            amendment.Number("seconds"),
                            J.Get(amendment.Element(), "tools"),
                            J.Get(amendment.Element(), "public_summary"),
                            false,
                            J.Get(original, "metadata")
                        ),
                        J.Parse(J.Write(updatedReceipt))
                    )
                    let metadata = PublicSummary.Attach(
                        map[string, Object?]{
                            "fork": run.Text("head_repo"),
                            "branch": run.Text("branch"),
                            "previous": amendment.Text("previous"),
                            "head": amendment.Text("commit"),
                            "pr": amendment.Number("pr"),
                            "seconds": amendment.Number("seconds"),
                            "tools": J.Get(amendment.Element(), "tools"),
                            "verification": "donor-reported-pass"
                        },
                        J.Get(amendment.Element(), "public_summary")
                    )
                    if run.Text("attempt") != "" {
                        metadata["attempt"] = run.Text("attempt")
                    }
                    if amendment.Text("sync") != "" {
                        metadata["sync"] = amendment.Text("sync")
                    }
                    amendment.Fields["request"] = map[string, Object?]{
                        "uuid": amendment.Text("id"),
                        "expected": amendment.Text("expected"),
                        "approval": run.Text("approval"),
                        "action": "amend",
                        "metadata": metadata
                    }
                }
                amendment.Fields["state"] = "publishing"
                amendment.Save(location)
                File.WriteAllText(Path.Combine(location, "publication.json"), J.Write(amendment.Element()) + "\n")
            }
            let previousOwned = PrBody.Owned(amendment.Text("previous_body"), legacyReport)
            let owned = PrBody.Owned(J.Text(pull, "body"), legacyReport)
            if owned != previousOwned && owned != PrBody.Owned(amendment.Text("body"), legacyReport) {
                throw Exception("PR owned regions differ from saved previous or candidate state")
            }
            if remote == amendment.Text("previous") {
                if RequestData.Canonical(receipt) != RequestData.Canonical(previousReceipt) || owned != previousOwned {
                    throw Exception("Invalid physical state: candidate receipt on the previous remote head")
                }
                Authority(run, amendment)
                Pull(run, amendment.Number("pr"), amendment.Text("previous"), "")
                Remote(run, amendment.Text("previous"), "")
                if Snapshot(
                    checkout,
                    run,
                    amendment.Text("commit"),
                    amendment.Text("previous"),
                    record,
                    Synchronization.History(amendment.Element())
                ) != snapshot {
                    throw Exception("Amendment checkout changed before push")
                }
                AccessState.Check(
                    run.Text("repo"),
                    run.Number("issue"),
                    J.Get(record, "approval"),
                    J.Get(run.Element(), "donor_id")
                )
                Commands.Git(
                    checkout,
                    "-c",
                    "credential.helper=",
                    "-c",
                    "credential.helper=!gh auth git-credential",
                    "push",
                    "https://github.com/" + run.Text("head_repo") + ".git",
                    amendment.Text("commit") + ":refs/heads/" + run.Text("branch")
                )
            }
            Authority(run, amendment)
            Remote(run, amendment.Text("commit"), "")
            let latest = Pull(run, amendment.Number("pr"), amendment.Text("commit"), "")
            let history = Synchronization.History(amendment.Element())
            if history.GetArrayLength() > 0 {
                Synchronization.Remote(
                    run.Text("repo"),
                    policy.Value,
                    J.Get(record, "approval"),
                    run.Text("base"),
                    history,
                    run.Text("head_repo"),
                    amendment.Text("commit")
                )
            } else {
                GitHubPathEvidence.Check(
                    run.Text("repo"),
                    policy.Value,
                    J.Get(record, "approval"),
                    run.Text("base"),
                    run.Text("head_repo"),
                    amendment.Text("commit")
                )
            }
            Authority(run, amendment)
            if run.Number("version") == 1 {
                let body = J.Text(latest, "body")
                let candidateOwned = PrBody.Owned(amendment.Text("body"), legacyReport)
                if PrBody.Owned(body, legacyReport) != candidateOwned {
                    if PrBody.Owned(body, legacyReport) != previousOwned {
                        throw Exception(
                            "PR owned regions changed during interrupted publication; physical state retained for inspection"
                        )
                    }
                    let updated = PrBody.ReplaceBody(
                        body,
                        legacyReport,
                        PrBody.ReportText(amendment.Text("body"), legacyReport),
                        PrBody.Receipt(amendment.Text("body"))
                    )
                    amendment.Fields["body"] = updated
                    amendment.Save(location)
                    File.WriteAllText(Path.Combine(location, "publication.json"), J.Write(amendment.Element()) + "\n")
                    Authority(run, amendment)
                    Remote(run, amendment.Text("commit"), "")
                    let beforeWrite = Pull(run, amendment.Number("pr"), amendment.Text("commit"), "")
                    if J.Text(beforeWrite, "body") != body ||
                        Snapshot(
                        checkout,
                        run,
                        amendment.Text("commit"),
                        amendment.Text("previous"),
                        record,
                        Synchronization.History(amendment.Element())
                    ) != snapshot {
                        throw Exception("PR body or amendment checkout changed before body write")
                    }
                    GitHub.Api(
                        "repos/" + run.Text("repo") + "/pulls/" + amendment.Number("pr").ToString(),
                        map[string, Object?]{"body": updated},
                        "PATCH"
                    )
                }
                Authority(run, amendment)
                Remote(run, amendment.Text("commit"), "")
                let finalPull = Pull(run, amendment.Number("pr"), amendment.Text("commit"), "")
                if PrBody.Owned(J.Text(finalPull, "body"), legacyReport) != candidateOwned {
                    throw Exception("Published owned report/receipt changed")
                }
                ReceiptVerification.Verify(run.Text("repo"), amendment.Number("pr"))
                Complete(directory, location, run, amendment, latest)
            } else {
                if J.Text(authority, "sha") != amendment.Text("expected") {
                    ReceiptVerification.Verify(run.Text("repo"), amendment.Number("pr"))
                    Complete(directory, location, run, amendment, latest)
                    return
                }
                let request = J.Get(amendment.Element(), "request")
                let path = Path.Combine(location, "request.json")
                File.WriteAllText(path, J.Write(request) + "\n")
                if amendment.Text("state") != "requested" {
                    Submission.Request(
                        Args(
                            []string{
                                "request",
                                "--repo",
                                run.Text("repo"),
                                "--issue",
                                run.Number("issue").ToString(),
                                "--file",
                                path
                            }
                        )
                    )
                    Authority(run, amendment)
                    amendment.Fields["state"] = "requested"
                    amendment.Save(location)
                }
                let pr = amendment.Number("pr").ToString()
                Terminal.Message(
                    "Amendment request saved: " +
                        path +
                        ". Await coordinator outcome, then re-run the same amend command to record publication. PR " +
                        pr +
                        " may temporarily have an invalid receipt until body and coordination state agree."
                )
            }
        }

        internal func PublicRecord(amendment Data) Object {
            let fields = map[string, Object?]{
                "id": amendment.Text("id"),
                "previous": amendment.Text("previous"),
                "seconds": amendment.Number("seconds"),
                "tools": J.Get(amendment.Element(), "tools")
            }
            if amendment.Text("sync") != "" {
                fields["sync"] = amendment.Text("sync")
            }
            return PublicSummary.Attach(fields, J.Get(amendment.Element(), "public_summary"))
        }

        private func Complete(directory string, location string, run Data, amendment Data, pull JsonElement) {
            amendment.Fields["state"] = "published"
            amendment.Fields.Remove("error")
            amendment.Fields.Remove("failure_reason")
            amendment.Save(location)
            let history = List[Object]()
            var found bool
            for old in J.Items(J.Get(run.Element(), "amendments")) {
                history.Add(old)
                if J.Text(old, "id") == amendment.Text("id") {
                    found = true
                }
            }
            if !found {
                history.Add(
                    map[string, Object?]{
                        "id": amendment.Text("id"),
                        "previous": amendment.Text("previous"),
                        "head": amendment.Text("commit")
                    }
                )
            }
            run.Fields["amendments"] = history
            Synchronization.Keep(run.Fields, Synchronization.History(amendment.Element()))
            run.Fields["commit"] = amendment.Text("commit")
            Publication.SavePr(directory, run, pull)
            Terminal.Message(
                "Verified amendment published; original evidence: " + Path.Combine(directory, "original-evidence")
            )
        }
    }
}
