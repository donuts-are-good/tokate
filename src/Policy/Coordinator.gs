package Tokate

import System
import System.Collections.Generic
import System.Text.Json
import System.Text.RegularExpressions

internal class Coordinator {
    shared {
        internal func Run(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let event = RequestData.FileData(args.Need("event"), 1024 * 1024)
            let eventComment = J.Get(event, "comment")
            let eventIssue = J.Get(event, "issue")
            let eventRepository = J.Get(event, "repository")
            let failure = "Expected a created issue_comment /tokate request"
            if Environment.GetEnvironmentVariable("GITHUB_EVENT_NAME") != "issue_comment" || J.Text(
                event,
                "action"
            ) != "created" {
                throw Exception(failure)
            }
            if !J.Text(eventComment, "body").StartsWith("/tokate ", StringComparison.Ordinal) || J.Get(
                eventIssue,
                "pull_request"
            )
                .ValueKind != JsonValueKind.Undefined {
                throw Exception(failure)
            }
            if J.Text(eventRepository, "full_name") != repo {
                throw Exception("Event repository does not match coordinator repository")
            }
            let number = J.Number(eventIssue, "number")
            let commentId = RepositoryIdentity.PositiveId(J.Get(eventComment, "id"))
            let canonical = GitHub.Api("repos/" + repo + "/issues/comments/" + commentId.ToString())
            let canonicalUser = J.Get(canonical, "user")
            let actor = J.Get(canonicalUser, "id")
            RepositoryIdentity.PositiveId(actor)
            let donor = RepositoryIdentity.Login(J.Text(canonicalUser, "login"))
            let info = RepositoryAccess.RequireOwner(repo)
            let issueUrl = "https://api.github.com/repos/" + repo + "/issues/" + number.ToString()
            let eventActor = J.Get(J.Get(eventComment, "user"), "id")
            if number < 1 || J.Get(eventRepository, "id").ToString() != J.Get(info, "id").ToString() || J.Get(
                canonical,
                "id"
            )
                .ToString() != commentId.ToString() || J.Text(canonical, "issue_url") != issueUrl ||
                actor.ToString() != eventActor.ToString() || J.Text(canonical, "body") != J.Text(eventComment, "body") {
                throw Exception("Comment author, content, repository or issue identity changed")
            }
            let text = J.Text(canonical, "body")
            if !text.StartsWith("/tokate ", StringComparison.Ordinal) {
                throw Exception("Canonical comment is not a request")
            }
            let request = RequestData.Parse(text.Substring(8))
            RequestData.Request(request)
            let state = CoordinationState.Load(repo, number)
            let binding = RequestData.Binding(actor, request)
            let initial = state.Value()
            let outcomes = J.Items(J.Get(initial, "outcomes"))
            for old in outcomes {
                if J.Text(old, "uuid") == J.Text(request, "uuid") {
                    if J.Text(old, "binding") != binding {
                        throw Exception("UUID replay changed actor or request contents")
                    }
                    if AccessState.Task(J.Get(initial, "approval")) {
                        state.Check(repo, number, donor, actor)
                    }
                    if J.Text(request, "action") == "amend" {
                        ReceiptVerification.Verify(repo, J.Number(J.Get(old, "outcome"), "pr"))
                    }
                    Terminal.Json(J.Get(old, "outcome"), "Recorded request outcome")
                    return
                }
            }
            if state.Sha != J.Text(request, "expected") || J.Text(initial, "approval_id") != J.Text(
                request,
                "approval"
            ) {
                throw CliFailure("stale_approval", "Stale state or approval; evicted requests cannot repeat effects")
            }
            let record = state.Check(repo, number, donor, actor)
            var outcome Object = J.Map()
            if J.Text(request, "action") == "claim" {
                let reservation = J.Get(initial, "reservation")
                let now = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                if reservation.ValueKind == JsonValueKind.Object && CoordinationState.Unix(
                    reservation,
                    "expires"
                ) > now {
                    throw Exception("An unexpired reservation already owns this contribution")
                }
                let policy = J.Get(record, "policy")
                let duration = J.Get(policy, "reservation_seconds").ValueKind == JsonValueKind.Undefined ? 86400:
                J.Number(policy, "reservation_seconds")
                outcome = J.Map(
                    "reservation",
                    J.Text(request, "uuid"),
                    "donor",
                    donor,
                    "actor",
                    actor,
                    "created",
                    now,
                    "expires",
                    now + duration
                )
                state.Fields["reservation"] = outcome
                state.Fields["contribution"] = nil
                state.Fields["amendments"] = []Object{}
            } else if J.Text(request, "action") == "amend" {
                outcome = Amend(repo, number, state, record, request, actor, donor)
            } else {
                state.Reservation(actor)
                let value = state.Value()
                if J.Get(value, "contribution").ValueKind == JsonValueKind.Object {
                    throw Exception("Contribution already published; use the recorded outcome or fresh owner approval")
                }
                let metadata = J.Get(request, "metadata")
                Policy(J.Write(J.Get(record, "policy"))).ValidateTools(
                    J.Get(metadata, "tools"),
                    J.Text(metadata, "source")
                )
                let correction = J.Get(metadata, "correction")
                if correction.ValueKind != JsonValueKind.Undefined {
                    RequestData.Correction(correction, J.Text(metadata, "head"), J.Get(record, "policy"))
                }
                RepositoryAccess.ValidateFork(repo, metadata, actor)
                ValidateDiff(repo, record, metadata)
                let reservation = J.Text(J.Get(value, "reservation"), "reservation")
                if J.Text(metadata, "branch") != "tokate/v2-" + reservation {
                    throw Exception("Publication must use this reservation's branch")
                }
                let marker = "<!-- tokate-v2:" + reservation + " -->"
                let receipt = ContributionReceipt.Coordinated(
                    repo,
                    number,
                    J.Text(value, "approval_id"),
                    J.Text(request, "expected"),
                    reservation,
                    donor,
                    J.Text(metadata, "head")
                )
                if correction.ValueKind != JsonValueKind.Undefined {
                    receipt["correction"] = correction
                }
                let pulls = J.Items(
                    GitHub.Api(
                        "repos/" + repo + "/pulls?state=all&head=" + Uri.EscapeDataString(
                            donor + ":" + J.Text(metadata, "branch")
                        ) +
                            "&base=" +
                            Uri.EscapeDataString(J.Text(J.Get(record, "approval"), "base_branch"))
                    )
                )
                if pulls.Count > 1 {
                    throw Exception("Ambiguous publication; owner inspection required")
                }
                var pull = pulls.Count == 0 ? JsonElement{}: pulls[0]
                if pull.ValueKind != JsonValueKind.Undefined {
                    let body = J.Text(pull, "body")
                    let receiptMarker = "<!-- tokate-receipt:" + J.Write(receipt) + " -->"
                    if !body.Contains(marker) || J.Text(J.Get(pull, "head"), "sha") != J.Text(metadata, "head") ||
                        !body.Contains(receiptMarker) {
                        throw Exception("Existing PR differs from this contribution")
                    }
                }
                Revalidate(repo, number, state, actor, donor)
                RepositoryAccess.ValidateFork(repo, metadata, actor)
                if pull.ValueKind == JsonValueKind.Undefined {
                    AccessState.Check(repo, number, J.Get(record, "approval"), actor)
                    pull = GitHub.Api(
                        "repos/" + repo + "/pulls",
                        J.Map(
                            "title",
                            J.Text(J.Get(record, "issue"), "title"),
                            "body",
                            Body(record, metadata, donor, receipt, marker),
                            "head",
                            donor + ":" + J.Text(metadata, "branch"),
                            "base",
                            J.Text(J.Get(record, "approval"), "base_branch"),
                            "draft",
                            true,
                            "maintainer_can_modify",
                            true
                        ),
                        expires: CoordinationState.Unix(J.Get(value, "reservation"), "expires")
                    )
                }
                Revalidate(repo, number, state, actor, donor)
                RepositoryAccess.ValidateFork(repo, metadata, actor)
                if J.Text(J.Get(pull, "head"), "sha") != J.Text(metadata, "head") {
                    throw Exception("PR commit differs from declaration")
                }
                outcome = J.Map(
                    "pr",
                    J.Number(pull, "number"),
                    "url",
                    J.Text(pull, "html_url"),
                    "head",
                    J.Text(metadata, "head"),
                    "reservation",
                    reservation
                )
                state.Fields["contribution"] = J.Map(
                    "request",
                    J.Text(request, "uuid"),
                    "expected",
                    J.Text(request, "expected"),
                    "metadata",
                    metadata,
                    "actor",
                    actor,
                    "donor",
                    donor,
                    "outcome",
                    outcome,
                    "verification_provenance",
                    "donor-reported; exact-commit owner CI required"
                )
            }
            let retained = List[Object]()
            for i in Math.Max(0, outcomes.Count - 31) ... outcomes.Count {
                retained.Add(outcomes[i])
            }
            retained.Add(J.Map("uuid", J.Text(request, "uuid"), "binding", binding, "outcome", outcome))
            state.Fields["outcomes"] = retained
            let updated = state.Value()
            if J.Text(request, "action") == "amend" {
                Revalidate(repo, number, state, actor, donor)
                SyncProof(repo, record, updated, J.Get(request, "metadata"), J.Text(request, "expected"))
            }
            if AccessState.Task(J.Get(updated, "approval")) {
                let live = CoordinationState.Load(repo, number)
                if live.Sha != state.Sha {
                    throw CliFailure("stale_approval", "Coordination changed before reservation update")
                }
                AccessState.Check(repo, number, J.Get(live.Value(), "approval"), actor)
            }
            try {
                state.Write(
                    repo,
                    number,
                    J.Text(request, "expected"),
                    CoordinationState.Unix(J.Get(updated, "reservation"), "expires")
                )
            } catch (error Exception) {
                throw Exception(
                    error.Message +
                        "\nPR and coordination writes are not atomic. A physical PR may lack valid authority; inspect verify-pr and redeliver the same saved UUID request only after reading current state.",
                    error
                )
            }
            if AccessState.Task(J.Get(updated, "approval")) {
                let acquired = CoordinationState.Load(repo, number)
                if acquired.Sha != state.Sha {
                    throw CliFailure(
                        "stale_approval",
                        "Coordination changed after reservation update; inspect current state"
                    )
                }
                acquired.Check(repo, number, donor, actor)
                acquired.Reservation(actor)
            }
            if J.Text(request, "action") == "amend" {
                ReceiptVerification.Verify(repo, J.Number(J.Parse(J.Write(outcome)), "pr"))
            }
            Terminal.Json(J.Parse(J.Write(outcome)), "Request outcome")
        }

        private func Amend(
            repo string,
            number int32,
            state CoordinationState,
            record JsonElement,
            request JsonElement,
            actor JsonElement,
            donor string
        ) Object {
            state.Reservation(actor)
            let value = state.Value()
            let original = J.Get(value, "contribution")
            let current = CoordinationState.Current(value)
            let metadata = J.Get(request, "metadata")
            let old = J.Get(original, "metadata")
            let policy = Policy(J.Write(J.Get(record, "policy")))
            Amendment.Tools(policy, J.Get(metadata, "tools"))
            let reservation = J.Get(value, "reservation")
            let branch = J.Text(metadata, "branch")
            if J.Number(metadata, "seconds") > J.Number(policy.Value, "max_seconds") || J.Get(original, "actor")
                .ToString() != actor.ToString() || J.Text(metadata, "previous") != CoordinationState.Head(value) ||
                J.Number(metadata, "pr") != J.Number(J.Get(current, "outcome"), "pr") || J.Text(
                metadata,
                "fork"
            ) != J.Text(old, "fork") || branch != J.Text(old, "branch") || branch != "tokate/v2-" + J.Text(
                reservation,
                "reservation"
            ) {
                throw Exception("Amendment differs from current published contribution authority")
            }
            RepositoryAccess.ValidateFork(repo, metadata, actor)
            let history = Synchronization.Append(repo, Synchronization.History(current), J.Text(metadata, "sync"))
            SyncProofHistory(repo, record, value, metadata, J.Text(request, "expected"), history)
            let run = Data()
            run.Fields["version"] = 2
            run.Fields["repo"] = repo
            run.Fields["id"] = J.Text(reservation, "reservation")
            run.Fields["head_repo"] = J.Text(metadata, "fork")
            run.Fields["branch"] = branch
            run.Fields["base_branch"] = J.Text(J.Get(record, "approval"), "base_branch")
            let amendment = Data()
            amendment.Fields["id"] = J.Text(request, "uuid")
            amendment.Fields["previous"] = J.Text(metadata, "previous")
            amendment.Fields["seconds"] = J.Number(metadata, "seconds")
            amendment.Fields["tools"] = J.Get(metadata, "tools")
            if J.Text(metadata, "sync") != "" {
                amendment.Fields["sync"] = J.Text(metadata, "sync")
            }
            Synchronization.Keep(amendment.Fields, history)
            let fields = ContributionReceipt.Coordinated(
                repo,
                number,
                J.Text(value, "approval_id"),
                J.Text(request, "expected"),
                run.Text("id"),
                donor,
                J.Text(metadata, "head")
            )
            fields["amendment"] = Amendment.PublicRecord(amendment)
            let correction = J.Get(old, "correction")
            if correction.ValueKind != JsonValueKind.Undefined {
                fields["correction"] = correction
            }
            Synchronization.Keep(fields, history)
            let receipt = J.Parse(J.Write(fields))
            let pull = Amendment.Pull(run, J.Number(metadata, "pr"), J.Text(metadata, "head"), "")
            let body = J.Text(pull, "body")
            let oldReceipt = PrBody.Receipt(body)
            let report = Amendment.Summary(
                J.Text(metadata, "previous"),
                J.Text(metadata, "head"),
                J.Number(metadata, "seconds"),
                J.Get(metadata, "tools")
            )
            let oldCanonical = RequestData.Canonical(oldReceipt)
            let candidateCanonical = RequestData.Canonical(receipt)
            if oldCanonical == candidateCanonical && PrBody.ReportText(body, PrBody.OriginalReport(old)) != report {
                throw Exception("Candidate PR report differs from saved amendment intent")
            }
            if oldCanonical != candidateCanonical {
                if oldCanonical != RequestData.Canonical(ContributionReceipt.FromState(value)) {
                    throw Exception("PR receipt differs from saved previous or candidate state")
                }
                let previousReport = J.Items(J.Get(value, "amendments")).Count == 0 ? PrBody.OriginalReport(old):
                Amendment.Summary(
                    J.Text(current, "previous"),
                    J.Text(current, "head"),
                    J.Number(current, "seconds"),
                    J.Get(current, "tools")
                )
                if PrBody.ReportText(body, PrBody.OriginalReport(old)) != previousReport {
                    throw Exception("Previous PR report differs from current contribution")
                }
                let updated = PrBody.ReplaceBody(body, PrBody.OriginalReport(old), report, receipt)
                Revalidate(repo, number, state, actor, donor)
                SyncProofHistory(repo, record, value, metadata, J.Text(request, "expected"), history)
                RepositoryAccess.ValidateFork(repo, metadata, actor)
                let fresh = Amendment.Pull(run, J.Number(metadata, "pr"), J.Text(metadata, "head"), "")
                if J.Text(fresh, "body") != body {
                    throw Exception("PR body changed before amendment write")
                }
                AccessState.Check(repo, number, J.Get(record, "approval"), actor)
                GitHub.Api(
                    "repos/" + repo + "/pulls/" + J.Number(metadata, "pr").ToString(),
                    J.Map("body", updated),
                    "PATCH",
                    expires: CoordinationState.Unix(reservation, "expires")
                )
            }
            Revalidate(repo, number, state, actor, donor)
            SyncProofHistory(repo, record, value, metadata, J.Text(request, "expected"), history)
            RepositoryAccess.ValidateFork(repo, metadata, actor)
            let latest = Amendment.Pull(run, J.Number(metadata, "pr"), J.Text(metadata, "head"), "")
            if RequestData.Canonical(PrBody.Receipt(J.Text(latest, "body"))) != candidateCanonical || PrBody.ReportText(
                J.Text(latest, "body"),
                PrBody.OriginalReport(old)
            ) != report {
                throw Exception("Physical PR receipt changed; amendment has no coordination authority")
            }
            let outcome = J.Map(
                "pr",
                J.Number(metadata, "pr"),
                "url",
                J.Text(latest, "html_url"),
                "head",
                J.Text(metadata, "head"),
                "reservation",
                run.Text("id")
            )
            let retainedHistory = List[Object]()
            for prior in J.Items(J.Get(value, "amendments")) {
                retainedHistory.Add(prior)
            }
            let entry = J.Map(
                "request",
                J.Text(request, "uuid"),
                "expected",
                J.Text(request, "expected"),
                "previous",
                J.Text(metadata, "previous"),
                "head",
                J.Text(metadata, "head"),
                "seconds",
                J.Number(metadata, "seconds"),
                "tools",
                J.Get(metadata, "tools"),
                "actor",
                actor,
                "donor",
                donor,
                "outcome",
                outcome,
                "verification_provenance",
                "donor-reported; exact-commit owner CI required"
            )
            if J.Text(metadata, "sync") != "" {
                entry["sync"] = J.Text(metadata, "sync")
            }
            Synchronization.Keep(entry, history)
            retainedHistory.Add(entry)
            state.Fields["amendments"] = retainedHistory
            return outcome
        }

        private func SyncProof(
            repo string,
            record JsonElement,
            state JsonElement,
            metadata JsonElement,
            expected string
        ) {
            SyncProofHistory(
                repo,
                record,
                state,
                metadata,
                expected,
                Synchronization.History(CoordinationState.Current(state))
            )
        }

        private func SyncProofHistory(
            repo string,
            record JsonElement,
            state JsonElement,
            metadata JsonElement,
            expected string,
            history JsonElement
        ) {
            Synchronization.Live(
                repo,
                J.Number(metadata, "pr"),
                record,
                J.Text(state, "approval_id"),
                history,
                J.Text(metadata, "fork"),
                J.Text(metadata, "branch"),
                J.Text(metadata, "head"),
                J.Text(metadata, "sync"),
                expected,
                J.Text(metadata, "previous")
            )
            if history.GetArrayLength() > 0 {
                Synchronization.Remote(
                    repo,
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    J.Text(J.Get(record, "approval"), "base"),
                    history,
                    J.Text(metadata, "fork"),
                    J.Text(metadata, "head")
                )
            } else {
                ValidateDiff(repo, record, metadata)
                ProtectedPaths.Remote(
                    repo,
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    J.Text(metadata, "previous"),
                    J.Text(metadata, "fork"),
                    J.Text(metadata, "head")
                )
            }
            Synchronization.Live(
                repo,
                J.Number(metadata, "pr"),
                record,
                J.Text(state, "approval_id"),
                history,
                J.Text(metadata, "fork"),
                J.Text(metadata, "branch"),
                J.Text(metadata, "head"),
                J.Text(metadata, "sync"),
                expected,
                J.Text(metadata, "previous")
            )
        }

        private func Revalidate(repo string, issue int32, state CoordinationState, actor JsonElement, donor string) {
            let live = CoordinationState.Load(repo, issue)
            if live.Sha != state.Sha {
                throw CliFailure("stale_approval", "Coordination revision changed during publication")
            }
            live.Check(repo, issue, donor, actor)
            live.Reservation(actor)
        }

        private func ValidateDiff(repo string, record JsonElement, metadata JsonElement) {
            ProtectedPaths.Remote(
                repo,
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                J.Text(J.Get(record, "approval"), "base"),
                J.Text(metadata, "fork"),
                J.Text(metadata, "head")
            )
        }

        private func Body(
            record JsonElement,
            metadata JsonElement,
            donor string,
            receipt Object,
            marker string
        ) string {
            let values = Dictionary[string, string]()
            values["issue"] = J.Number(J.Get(record, "issue"), "number").ToString()
            values["report"] = PrBody.Report(PrBody.OriginalReport(metadata))
            values["donor"] = donor
            values["model"] = "donor-reported tools: " + J.Write(J.Get(metadata, "tools"))
            values["effort"] = "per-tool declaration; not independently attested"
            values["seconds"] = "donor-reported or unknown; reservation is not a compute budget"
            values["base"] = J.Text(J.Get(record, "approval"), "base")
            values["policy"] = J.Text(J.Get(record, "approval"), "policy_hash")
            values["usage"] = "per-tool donor declaration; not independently attested"
            values["receipt"] = marker + "\n<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            return PrBody.Render(J.Text(record, "template"), values)
        }
    }
}
