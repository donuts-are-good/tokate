package Tokate

import System
import System.Text.Json

internal class ReceiptVerification {
    shared {
        internal func Verify(repo string, number int32, ready bool = true, paths bool = true) Data {
            let pull = GitHub.Api("repos/" + repo + "/pulls/" + number.ToString())
            let body = J.Text(pull, "body")
            let receipt = J.Parse(PrBody.ReceiptText(body, "PR needs exactly one Tokate receipt"))
            if J.Number(receipt, "version") == 2 {
                return ReceiptVerification.VerifyV2(repo, number, pull, receipt, ready, paths)
            }
            let author = J.Get(pull, "user")
            if J.Number(receipt, "version") != 1 || !RepositoryIdentity.SameRepo(J.Text(receipt, "repo"), repo) ||
                J.Text(author, "login") != J.Text(receipt, "donor") {
                throw Exception("PR author or repository does not match the receipt")
            }
            let head = J.Get(pull, "head")
            if J.Text(head, "sha") != J.Text(receipt, "head") {
                throw Exception("PR head changed since the receipt was written")
            }
            let record = OwnerApproval.Approved(
                repo,
                J.Number(receipt, "issue"),
                RepositoryIdentity.Login(J.Text(receipt, "donor"))
            )
            let approval = J.Get(record, "approval")
            let predecessor = J.Get(receipt, "predecessor")
            if J.Text(approval, "predecessor_approval") != "" && predecessor.ValueKind == JsonValueKind.Undefined {
                throw Exception("Continuation receipt omitted interrupted-origin provenance")
            }
            if predecessor.ValueKind != JsonValueKind.Undefined {
                V1Continuation.Grant(record, J.Text(predecessor, "approval"), J.Get(author, "id"))
                V1Continuation.Receipt(predecessor, J.Text(receipt, "import_manifest_sha256"), approval)
                if !PrBody.ReportText(body, "").Contains(PrBody.ContinuationReport(predecessor).Trim()) {
                    throw Exception("PR report omitted interrupted-origin provenance")
                }
            }
            if J.Text(record, "sha") != J.Text(receipt, "approval") || J.Text(approval, "policy_hash") != J.Text(
                receipt,
                "policy"
            ) ||
                J.Text(J.Get(pull, "base"), "ref") != J.Text(approval, "base_branch") {
                throw CliFailure("stale_approval", "PR approval or policy no longer matches")
            }
            let expectedBranch = "tokate/issue-" + J.Number(receipt, "issue").ToString() + "-" + J.Text(record, "sha")
                .Substring(0, 12)
            if J.Text(head, "ref") != expectedBranch || !String.Equals(
                J.Text(J.Get(J.Get(head, "repo"), "owner"), "login"),
                J.Text(receipt, "donor"),
                StringComparison.OrdinalIgnoreCase
            ) {
                throw Exception("PR does not use the assigned donor's claim")
            }
            Policy(J.Write(J.Get(record, "policy"))).Validate(
                J.Text(receipt, "model"),
                J.Text(receipt, "effort"),
                J.Number(receipt, "seconds"),
                J.Bool(receipt, "network")
            )
            let correction = J.Get(receipt, "correction")
            if correction.ValueKind != JsonValueKind.Undefined {
                RequestData.Correction(
                    correction,
                    J.Get(receipt, "amendment").ValueKind == JsonValueKind.Undefined ? J.Text(receipt, "head"):
                    J.Text(receipt, "original_head"),
                    J.Get(record, "policy")
                )
            }
            let history = Synchronization.History(receipt)
            let fork = RepositoryIdentity.Repo(J.Text(J.Get(head, "repo"), "full_name"))
            if history.GetArrayLength() > 0 {
                Synchronization.Live(
                    repo,
                    number,
                    record,
                    J.Text(record, "sha"),
                    history,
                    fork,
                    J.Text(head, "ref"),
                    J.Text(head, "sha"),
                    ready: ready
                )
                if paths {
                    Synchronization.Remote(
                        repo,
                        J.Get(record, "policy"),
                        J.Get(record, "approval"),
                        J.Text(approval, "base"),
                        history,
                        fork,
                        J.Text(head, "sha")
                    )
                }
            } else if paths {
                GitHubPathEvidence.Check(
                    repo,
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    J.Text(approval, "base"),
                    RepositoryIdentity.Repo(J.Text(J.Get(head, "repo"), "full_name")),
                    J.Text(head, "sha")
                )
            }
            let amendment = J.Get(receipt, "amendment")
            if amendment.ValueKind != JsonValueKind.Undefined {
                Amendment.ValidateReceipt(amendment, Policy(J.Write(J.Get(record, "policy"))), J.Text(receipt, "head"))
                RepositoryIdentity.CommitSha(J.Text(receipt, "original_head"))
                if J.Text(amendment, "sync") != "" {
                    Synchronization.Live(
                        repo,
                        number,
                        record,
                        J.Text(record, "sha"),
                        history,
                        fork,
                        J.Text(head, "ref"),
                        J.Text(head, "sha"),
                        J.Text(amendment, "sync"),
                        previous: J.Text(amendment, "previous"),
                        ready: ready
                    )
                }
                let report = PrBody.AmendmentReport(receipt)
                let observedReport = PrBody.ReportText(body, report)
                let prior = J.Get(receipt, "predecessor")
                let legacy = (
                    prior.ValueKind == JsonValueKind.Undefined ? "":
                    PrBody.ContinuationReport(prior)
                ) +
                    Amendment
                    .LegacySummary(
                    J.Text(amendment, "previous"),
                    J.Text(receipt, "head"),
                    J.Number(amendment, "seconds"),
                    J.Get(amendment, "tools")
                )
                if observedReport != report &&
                    (J.Get(amendment, "summary").ValueKind != JsonValueKind.Undefined || observedReport != legacy) {
                    throw Exception("PR amendment report differs from its exact-head receipt")
                }
            }
            if history.GetArrayLength() > 0 {
                if J.Text(
                    OwnerApproval.Approved(repo, J.Number(receipt, "issue"), J.Text(receipt, "donor")),
                    "sha"
                ) != J.Text(record, "sha") {
                    throw Exception("Approval changed during receipt validation")
                }
                Synchronization.Live(
                    repo,
                    number,
                    record,
                    J.Text(record, "sha"),
                    history,
                    fork,
                    J.Text(head, "ref"),
                    J.Text(head, "sha"),
                    ready: ready
                )
            }
            let run = Data()
            run.Fields["repo"] = repo
            run.Fields["pr"] = number
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["commit"] = J.Text(head, "sha")
            run.Fields["policy"] = J.Get(record, "policy")
            Binding(run, receipt, approval, J.Text(record, "sha"))
            return run
        }

        internal func Binding(run Data, receipt JsonElement, approval JsonElement, revision string) {
            for key in[]string{"version", "issue", "approval", "donor"} {
                run.Fields[key] = J.Get(receipt, key)
            }
            for key in[]string{"base", "base_branch"} {
                run.Fields[key] = J.Get(approval, key)
            }
            run.Fields["authority_revision"] = revision
        }

        internal func VerifyV2(
            repo string,
            number int32,
            pull JsonElement,
            receipt JsonElement,
            ready bool = true,
            paths bool = true
        ) Data {
            RequestData.Keys(
                receipt,
                "version,repo,issue,approval,expected,reservation,donor,head,correction,amendment,synchronizations"
            )
            let state = CoordinationState.Load(repo, J.Number(receipt, "issue"))
            let value = state.Value()
            let contribution = J.Get(value, "contribution")
            let metadata = J.Get(contribution, "metadata")
            let current = CoordinationState.Current(value)
            let outcome = J.Get(current, "outcome")
            let exactHead = J.Text(outcome, "head")
            let donor = RepositoryIdentity.Login(J.Text(receipt, "donor"))
            let record = state.Check(repo, J.Number(receipt, "issue"), donor, J.Get(contribution, "actor"))
            state.Reservation(J.Get(contribution, "actor"))
            let stateCommit = GitHub.Api("repos/" + repo + "/git/commits/" + state.Sha)
            let parents = J.Items(J.Get(stateCommit, "parents"))
            let expected = J.Text(receipt, "expected")
            if parents.Count != 1 || J.Text(parents[0], "sha") != expected || J.Text(current, "expected") != expected {
                throw CliFailure("stale_approval", "Receipt does not match the authoritative contribution revision")
            }
            let approval = J.Get(record, "approval")
            let reservation = J.Get(value, "reservation")
            let head = J.Get(pull, "head")
            let headRepo = J.Get(head, "repo")
            let base = J.Get(pull, "base")
            let approvalId = J.Text(value, "approval_id")
            let reservationId = J.Text(reservation, "reservation")
            let branch = J.Text(metadata, "branch")
            let fork = J.Text(metadata, "fork")
            let target = J.Text(approval, "base_branch")
            let failure = "PR receipt lacks current exact-commit coordination authority"
            let receiptApproval = J.Text(receipt, "approval")
            let receiptReservation = J.Text(receipt, "reservation")
            if !RepositoryIdentity.SameRepo(J.Text(receipt, "repo"), repo) {
                throw CliFailure("stale_approval", failure)
            }
            if receiptApproval != approvalId || receiptReservation != reservationId {
                throw CliFailure("stale_approval", failure)
            }
            let receiptHead = J.Text(receipt, "head")
            let physicalHead = J.Text(head, "sha")
            if J.Number(outcome, "pr") != number || receiptHead != exactHead || physicalHead != exactHead {
                throw CliFailure("stale_approval", failure)
            }
            if J.Text(head, "ref") != branch || !RepositoryIdentity.SameRepo(J.Text(headRepo, "full_name"), fork) {
                throw CliFailure("stale_approval", failure)
            }
            if J.Text(base, "ref") != target {
                throw CliFailure("stale_approval", failure)
            }
            if AccessState.Task(approval) {
                if donor != J.Text(contribution, "donor") {
                    throw CliFailure("stale_approval", "Receipt donor differs from the canonical contribution actor")
                }
                RepositoryAccess.ValidateFork(
                    repo,
                    J.Parse(
                        J.Write(
                            J.Map(
                                "fork",
                                J.Text(metadata, "fork"),
                                "branch",
                                J.Text(metadata, "branch"),
                                "head",
                                exactHead
                            )
                        )
                    ),
                    J.Get(contribution, "actor")
                )
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            policy.ValidateTools(J.Get(metadata, "tools"), J.Text(metadata, "source"))
            let amendment = J.Get(receipt, "amendment")
            if current.GetRawText() != contribution.GetRawText() {
                Amendment.ValidateReceipt(amendment, policy, exactHead)
                let report = Amendment.Summary(
                    J.Text(amendment, "previous"),
                    exactHead,
                    J.Number(amendment, "seconds"),
                    J.Get(amendment, "tools"),
                    J.Get(current, "summary"),
                    false,
                    metadata
                )
                if !RequestData.Same(J.Get(amendment, "summary"), J.Get(current, "summary")) {
                    throw Exception("PR amendment summary differs from coordination authority")
                }
                let observedReport = PrBody.ReportText(J.Text(pull, "body"), report)
                let legacy = Amendment.LegacySummary(
                    J.Text(amendment, "previous"),
                    exactHead,
                    J.Number(amendment, "seconds"),
                    J.Get(amendment, "tools")
                )
                if observedReport != report &&
                    (J.Get(current, "summary").ValueKind != JsonValueKind.Undefined || observedReport != legacy) {
                    throw Exception("PR amendment report differs from coordination authority")
                }
                let failure = "Amendment receipt differs from current coordination record"
                if J.Text(amendment, "id") != J.Text(current, "request") || J.Text(amendment, "previous") != J.Text(
                    current,
                    "previous"
                ) ||
                    J.Number(amendment, "seconds") != J.Number(current, "seconds") {
                    throw Exception(failure)
                }
                if RequestData.Canonical(J.Get(amendment, "tools")) != RequestData.Canonical(J.Get(current, "tools")) {
                    throw Exception(failure)
                }
            } else if amendment.ValueKind != JsonValueKind.Undefined {
                throw Exception("Receipt claims an amendment without coordination authority")
            }
            let history = Synchronization.History(receipt)
            let synchronizationFailure = "Synchronization receipt differs from authoritative coordination history"
            if J.Text(amendment, "sync") != J.Text(current, "sync") {
                throw Exception(synchronizationFailure)
            }
            if RequestData.Canonical(history) != RequestData.Canonical(Synchronization.History(current)) {
                throw Exception(synchronizationFailure)
            }
            let correction = J.Get(receipt, "correction")
            if !RequestData.Same(correction, J.Get(metadata, "correction")) {
                throw Exception("Correction receipt differs from authoritative publication metadata")
            }
            if correction.ValueKind != JsonValueKind.Undefined {
                RequestData.Correction(correction, J.Text(metadata, "head"), J.Get(record, "policy"))
            }
            Synchronization.Live(
                repo,
                number,
                record,
                J.Text(value, "approval_id"),
                history,
                J.Text(metadata, "fork"),
                J.Text(metadata, "branch"),
                exactHead,
                ready: ready
            )
            if paths && history.GetArrayLength() > 0 {
                Synchronization.Remote(
                    repo,
                    policy.Value,
                    approval,
                    J.Text(approval, "base"),
                    history,
                    J.Text(metadata, "fork"),
                    exactHead
                )
            } else if paths {
                GitHubPathEvidence.Check(
                    repo,
                    J.Get(record, "policy"),
                    approval,
                    J.Text(approval, "base"),
                    J.Text(metadata, "fork"),
                    exactHead
                )
            }
            if history.GetArrayLength() > 0 {
                let live = CoordinationState.Load(repo, J.Number(receipt, "issue"))
                if live.Sha != state.Sha {
                    throw Exception("Coordination authority changed during receipt validation")
                }
                live.Check(repo, J.Number(receipt, "issue"), donor, J.Get(contribution, "actor"))
                live.Reservation(J.Get(contribution, "actor"))
                Synchronization.Live(
                    repo,
                    number,
                    record,
                    J.Text(value, "approval_id"),
                    history,
                    J.Text(metadata, "fork"),
                    J.Text(metadata, "branch"),
                    exactHead,
                    ready: ready
                )
            }
            if AccessState.Task(approval) {
                AccessState.Check(repo, J.Number(receipt, "issue"), approval, J.Get(contribution, "actor"))
            }
            let run = Data()
            run.Fields["version"] = 2
            run.Fields["repo"] = repo
            run.Fields["pr"] = number
            run.Fields["commit"] = exactHead
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["policy"] = J.Get(record, "policy")
            ReceiptVerification.Binding(run, receipt, approval, state.Sha)
            return run
        }
    }
}
