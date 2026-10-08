package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class CorrectionPublication {
    shared {
        internal func Remote(run Data, correction Data?, initial bool = false) string {
            let reference = GitHub.Api(
                "repos/" + RepositoryIdentity.Repo(run.Text("head_repo")) + "/git/ref/heads/" + run.Text("branch"),
                missing: true
            )
            if reference.ValueKind == JsonValueKind.Undefined {
                if initial {
                    return ""
                }
                throw Exception("interrupted_publication: contribution branch is missing; intent preserved")
            }
            let head = J.Text(J.Get(reference, "object"), "sha")
            if head != run.Text("base") && head != (correction?.Text("commit") ?? "") {
                throw Exception("interrupted_publication: remote branch changed; refusing to overwrite it")
            }
            return head
        }

        internal func Receipt(run Data, correction Data) Dictionary[string, Object?] {
            let receipt = ContributionReceipt.Coordinated(
                run.Text("repo"),
                run.Number("issue"),
                run.Text("approval"),
                (run.Text("publication_expected") == "" ? run.Text("state_sha"): run.Text("publication_expected")),
                run.Text("id"),
                run.Text("donor"),
                correction.Text("commit")
            )
            receipt["correction"] = Correction.Provenance(correction)
            if AttemptContinuation.Has(run) {
                AttemptContinuation.Keep(receipt, AttemptContinuation.Metadata(run))
            }
            return receipt
        }

        private func CheckSaved(directory string, run Data, correction Data) JsonElement {
            let original = OriginalEvidence.Load(directory, run)
            Correction.Completed(Path.Combine(directory, "original-evidence"), original)
            let failure = "Only the saved verified exact correction can be published"
            if correction.Text("state") != "verified" || run.Text("commit") != correction.Text("commit") {
                throw Exception(failure)
            }
            if !RequestData.Same(J.Get(run.Element(), "correction"), Correction.Provenance(correction)) {
                throw Exception(failure)
            }
            let record = J.Parse(File.ReadAllText(Path.Combine(directory, "original-evidence", "approval.json")))
            Correction.Exact(directory, run, correction, record)
            Verification.Results(run, record)
            if !RequestData.Same(J.Get(run.Element(), "verification"), J.Get(correction.Element(), "verification")) {
                throw Exception("Correction verification results changed")
            }
            return record
        }

        private func Failure(directory string, correction Data, error Exception) {
            correction.Fields["failure_stage"] = "interrupted_publication"
            correction.Fields["failure_reason"] = "publication_interrupted"
            correction.Fields["publication_error"] = error.Message
            Correction.Save(directory, correction)
        }

        private func Preview(path string, expected string) {
            if FileInfo(path).LinkTarget != nil {
                throw Exception("Publication preview must not be a link")
            }
            if File.Exists(path) {
                let value = File.ReadAllText(path)
                if !RequestData.Same(J.Parse(value), J.Parse(expected)) {
                    throw Exception("Saved publication preview differs from exact intent")
                }
            } else {
                File.WriteAllText(path, expected)
            }
        }

        private func SetStage(directory string, correction Data, stage string) {
            let fields = map[string, Object?]{}
            for field in J.Get(correction.Element(), "publication").EnumerateObject() {
                fields[field.Name] = field.Value.Clone()
            }
            fields["stage"] = stage
            correction.Fields["publication"] = fields
            Correction.Save(directory, correction)
        }

        private func Complete(directory string, run Data, correction Data, pull JsonElement) {
            SetStage(directory, correction, "published")
            correction.Fields.Remove("failure_stage")
            correction.Fields.Remove("failure_reason")
            correction.Fields.Remove("publication_error")
            Correction.Save(directory, correction)
            Publication.SavePr(directory, run, pull)
        }

        private func Authority(directory string, run Data, correction Data) CoordinationState {
            let viewer = GitHub.Api("user")
            let actor = J.Get(viewer, "id")
            if !RepositoryIdentity.SameDonor(viewer, run) {
                throw CliFailure(
                    "authentication_required",
                    "Use the original authenticated donor account and numeric identity"
                )
            }
            let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            state.Reservation(actor)
            LeaseLifecycle.Fence(state, run.Text("attempt"))
            let record = state.Check(run.Text("repo"), run.Number("issue"), run.Text("donor"), actor)
            let pinned = J.Parse(File.ReadAllText(Path.Combine(directory, "original-evidence", "approval.json")))
            for key in[]string{"approval", "policy", "template"} {
                if !RequestData.Same(J.Get(record, key), J.Get(pinned, key)) {
                    throw CliFailure("stale_approval", "Original pinned approval, policy or template changed")
                }
            }
            let value = state.Value()
            if J.Text(value, "approval_id") != run.Text("approval") || J.Text(
                J.Get(value, "reservation"),
                "reservation"
            ) != run.Text("id") {
                throw CliFailure("stale_approval", "Original reservation or approval changed")
            }
            if state.Sha == (
                run.Text("publication_expected") == "" ? run.Text("state_sha"): run.Text("publication_expected")
            ) {
                Correction.Authority(directory, run)
                return state
            }
            RepositoryAccess.ValidateRun(run)
            let intent = J.Get(correction.Element(), "publication")
            let request = J.Get(intent, "request")
            let contribution = J.Get(value, "contribution")
            let contributionOutcome = J.Get(contribution, "outcome")
            let publicationRevision = J.Text(value, "publication_revision")
            let commit = GitHub.Api(
                "repos/" + run.Text("repo") +
                    "/git/commits/" +
                    (publicationRevision == "" ? state.Sha: publicationRevision)
            )
            let parents = J.Items(J.Get(commit, "parents"))
            let outcome = RequestData.Recorded(value, actor, request)
            let failure = "Stale coordination revision; only the exact saved publication transition can resume"
            let expected = (
                run.Text("publication_expected") == "" ? run.Text("state_sha"): run.Text("publication_expected")
            )
            if parents.Count != 1 || J.Text(parents[0], "sha") != expected {
                throw CliFailure("stale_approval", failure)
            }
            if !RequestData.Same(request, Submission.PublicationRequest(run, correction)) {
                throw CliFailure("stale_approval", failure)
            }
            let publicationId = correction.Text("publication_uuid")
            let contributor = J.Get(contribution, "actor").ToString()
            if J.Text(contribution, "request") != publicationId || J.Text(contribution, "expected") != expected ||
                contributor != actor.ToString() {
                throw CliFailure("stale_approval", failure)
            }
            if !RequestData.Same(J.Get(contribution, "metadata"), J.Get(request, "metadata")) ||
                outcome.ValueKind != JsonValueKind.Object ||
                !RequestData.Same(outcome, contributionOutcome) {
                throw CliFailure("stale_approval", failure)
            }
            return state
        }

        private func Posted(run Data, request JsonElement) bool -> Submission.Posted(
            RepositoryIdentity.Repo(run.Text("repo")),
            run.Number("issue"),
            J.Get(run.Element(), "donor_id"),
            request
        )

        internal func SubmitLocked(directory string, run Data) {
            let correction = Data.Read(Path.Combine(directory, "correction.json"))
            if run.Number("version") != 2 || run.Text("source") != "tokate" {
                throw Exception("Correction submit requires a managed version-2 contribution")
            }
            try {
                let record = CheckSaved(directory, run, correction)
                var intent = J.Get(correction.Element(), "publication")
                if intent.ValueKind == JsonValueKind.Undefined {
                    Correction.Authority(directory, run)
                    let live = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
                    ContributionClaim.Recheck(run)
                    run.Fields["publication_expected"] = live.Sha
                    run.Save(directory)
                    correction.Fields["publication_uuid"] = Guid.NewGuid().ToString("D")
                    let request = Submission.PublicationRequest(run, correction)
                    RequestData.Parse(J.Write(request))
                    RequestData.Request(request)
                    correction.Fields["publication"] = map[string, Object?]{"stage": "prepared", "request": request}
                    Correction.Save(directory, correction)
                    intent = J.Get(correction.Element(), "publication")
                    File.WriteAllText(Path.Combine(directory, "request.json"), J.Write(request) + "\n")
                    File.WriteAllText(Path.Combine(directory, "publication.json"), J.Write(request) + "\n")
                } else if !RequestData.Same(J.Get(intent, "request"), Submission.PublicationRequest(run, correction)) {
                    throw Exception("Saved version-2 publication intent changed")
                }
                Preview(Path.Combine(directory, "request.json"), J.Write(J.Get(intent, "request")) + "\n")
                Preview(Path.Combine(directory, "publication.json"), J.Write(J.Get(intent, "request")) + "\n")
                let state = Authority(directory, run, correction)
                let stage = J.Text(intent, "stage")
                var remote = Remote(run, correction, stage == "prepared")
                let existing = Publication.Find(run, J.Parse(J.Write(Receipt(run, correction))))
                if state.Sha != (
                    run.Text("publication_expected") == "" ? run.Text("state_sha"): run.Text("publication_expected")
                ) {
                    if existing.ValueKind == JsonValueKind.Undefined || remote != correction.Text("commit") || J.Number(
                        J.Get(J.Get(state.Value(), "contribution"), "outcome"),
                        "pr"
                    ) != J.Number(existing, "number") {
                        throw Exception("Saved coordination outcome lacks exact physical PR and branch")
                    }
                    Complete(directory, run, correction, existing)
                    return
                }
                if existing.ValueKind != JsonValueKind.Undefined && remote != correction.Text("commit") {
                    throw Exception("Physical PR and remote branch disagree")
                }
                if remote != correction.Text("commit") {
                    SetStage(directory, correction, "push_pending")
                    AccessState.Check(
                        run.Text("repo"),
                        run.Number("issue"),
                        J.Get(record, "approval"),
                        J.Get(run.Element(), "donor_id")
                    )
                    Publication.Push(Path.Combine(directory, "checkout"), run, correction.Text("commit"))
                    remote = Remote(run, correction)
                    if remote != correction.Text("commit") {
                        throw Exception("Corrected remote commit missing after push")
                    }
                    Authority(directory, run, correction)
                }
                if stage == "request_pending" || stage == "requested" || existing.ValueKind != JsonValueKind.Undefined {
                    if !Posted(run, J.Get(intent, "request")) {
                        throw Exception(
                            "interrupted_publication: saved request has no unique physical comment; refusing blind retry"
                        )
                    }
                    SetStage(directory, correction, "requested")
                    Terminal.Message(
                        "Exact publication request is already posted; awaiting the coordinator. No write, checks or inference repeated."
                    )
                    return
                }
                Correction.Exact(directory, run, correction, record)
                let latest = Authority(directory, run, correction)
                AccessState.Check(
                    run.Text("repo"),
                    run.Number("issue"),
                    J.Get(record, "approval"),
                    J.Get(run.Element(), "donor_id")
                )
                SetStage(directory, correction, "request_pending")
                Submission.WriteRequest(
                    run.Text("repo"),
                    run.Number("issue"),
                    J.Get(run.Element(), "donor_id"),
                    J.Get(intent, "request"),
                    CoordinationState.Unix(J.Get(latest.Value(), "reservation"), "expires")
                )
                SetStage(directory, correction, "requested")
                Terminal.Message("Exact correction publication request posted. The coordinator remains publisher.")
            } catch (error Exception) {
                Failure(directory, correction, error)
                throw Exception("publication_interrupted (interrupted_publication): " + error.Message)
            }
        }
    }
}
