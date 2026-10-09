package Tokate

import System
import System.Text.Json

internal class ContributionHandoff {
    shared {
        internal func Has(run Data) bool -> J.Get(run.Element(), "handoff").ValueKind != JsonValueKind.Undefined

        internal func StartHead(run Data) string -> Has(run) ? J.Text(
            J.Get(run.Element(), "handoff"),
            "head"
        ): run.Text("base")

        internal func Declaration(value JsonElement) {
            if value.ValueKind == JsonValueKind.Undefined {
                return
            }
            RequestData.Keys(value, "revision,pr,head,fork,donor,actor,id")
            RepositoryIdentity.CommitSha(J.Text(value, "revision"))
            RepositoryIdentity.CommitSha(J.Text(value, "head"))
            RepositoryIdentity.Repo(J.Text(value, "fork"))
            RepositoryIdentity.Login(J.Text(value, "donor"))
            RepositoryIdentity.PositiveId(J.Get(value, "actor"))
            if J.Number(value, "pr") < 1 {
                throw Exception("Handoff needs the prior pull request")
            }
            var id Guid
            if !Guid.TryParseExact(J.Text(value, "id"), "D", out id) || id.ToString("D") != J.Text(value, "id") {
                throw Exception("Handoff needs the prior contribution identity")
            }
        }

        private func Source(state CoordinationState) JsonElement {
            let value = state.Value()
            let original = J.Get(value, "contribution")
            let current = CoordinationState.Current(value)
            let identity = J.Get(value, "identity")
            let actor = RepositoryIdentity.PositiveId(J.Get(identity, "actor"))
            if original.ValueKind != JsonValueKind.Object || RepositoryIdentity.PositiveId(
                J.Get(original, "actor")
            ) != actor {
                throw Exception("Handoff requires published progress from the prior donor")
            }
            let source = J.Parse(
                J.Write(
                    map[string, Object?]{
                        "revision": state.Sha,
                        "pr": J.Number(J.Get(current, "outcome"), "pr"),
                        "head": CoordinationState.Head(value),
                        "fork": J.Text(J.Get(original, "metadata"), "fork"),
                        "donor": J.Text(original, "donor"),
                        "actor": actor,
                        "id": J.Text(identity, "id")
                    }
                )
            )
            Declaration(source)
            return source
        }

        internal func Read(state CoordinationState, actor JsonElement, record JsonElement, number int32) JsonElement {
            let value = state.Value()
            var prior = state
            if RepositoryIdentity.PositiveId(J.Get(J.Get(value, "identity"), "actor")) == RepositoryIdentity.PositiveId(
                actor
            ) {
                let predecessor = J.Get(J.Get(value, "identity"), "predecessor")
                prior = CoordinationState.At(
                    J.Text(value, "repo"),
                    J.Number(value, "issue"),
                    J.Text(predecessor, "revision")
                )
            }
            let source = Source(prior)
            if J.Number(source, "pr") != number || RepositoryIdentity.PositiveId(
                J.Get(source, "actor")
            ) == RepositoryIdentity.PositiveId(actor) || J.Text(prior.Value(), "approval_id") != J.Text(
                value,
                "approval_id"
            ) {
                throw Exception(
                    "Handoff requires another donor's published contribution under the same approval; use amend --resume for your own work"
                )
            }
            if prior.Sha != state.Sha {
                Authority(state, source)
            }
            let pull = GitHub.Api("repos/" + J.Text(value, "repo") + "/pulls/" + number.ToString())
            if J.Number(pull, "number") != number || J.Bool(pull, "merged") || J.Get(pull, "merged_at")
                .ValueKind == JsonValueKind.String ||
                (J.Text(pull, "state") != "open" && J.Text(pull, "state") != "closed") ||
                !RepositoryIdentity
                .SameRepo(J.Text(J.Get(J.Get(pull, "head"), "repo"), "full_name"), J.Text(source, "fork")) {
                throw Exception("Prior pull request no longer identifies unmerged donor work")
            }
            let repo = J.Text(value, "repo")
            RepositoryAccess.ValidateRepository(
                repo,
                J.Text(source, "fork"),
                J.Get(source, "actor"),
                GitHub.Api("repos/" + J.Text(source, "fork")),
                push: false,
                upstream: GitHub.Api("repos/" + repo)
            )
            GitHubPathEvidence.Check(
                repo,
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                J.Text(J.Get(record, "approval"), "base"),
                J.Text(source, "fork"),
                J.Text(source, "head")
            )
            return source
        }

        internal func Authority(state CoordinationState, source JsonElement) {
            if source.ValueKind == JsonValueKind.Undefined {
                return
            }
            Declaration(source)
            let value = state.Value()
            let identity = J.Get(value, "identity")
            let predecessor = J.Get(identity, "predecessor")
            if J.Text(predecessor, "revision") != J.Text(source, "revision") || J.Text(predecessor, "id") != J.Text(
                source,
                "id"
            ) ||
                RepositoryIdentity.PositiveId(J.Get(predecessor, "actor")) != RepositoryIdentity.PositiveId(
                J.Get(source, "actor")
            ) ||
                RepositoryIdentity.PositiveId(J.Get(identity, "actor")) == RepositoryIdentity.PositiveId(
                J.Get(source, "actor")
            ) {
                throw Exception("Handoff differs from the authoritative donor takeover")
            }
            let repo = J.Text(value, "repo")
            let prior = CoordinationState.At(repo, J.Number(value, "issue"), J.Text(source, "revision"))
            if J.Text(prior.Value(), "approval_id") != J.Text(value, "approval_id") || !RequestData.Same(
                Source(prior),
                source
            ) {
                throw Exception("Handoff source or approval changed")
            }
            Synchronization.Ancestor(repo, prior.Sha, repo, state.Sha)
        }

        internal func Candidate(source JsonElement, fork string, head string) {
            if source.ValueKind != JsonValueKind.Undefined {
                Declaration(source)
                Synchronization.Ancestor(J.Text(source, "fork"), J.Text(source, "head"), fork, head)
            }
        }

        internal func Supersede(state CoordinationState, request JsonElement) {
            let contribution = J.Get(state.Value(), "contribution")
            let source = J.Get(J.Get(contribution, "metadata"), "handoff")
            if source.ValueKind == JsonValueKind.Undefined || J.Text(contribution, "request") != J.Text(
                request,
                "uuid"
            ) {
                return
            }
            Authority(state, source)
            let number = J.Number(J.Get(contribution, "outcome"), "pr")
            let repo = J.Text(state.Value(), "repo")
            let path = "repos/" + repo + "/pulls/" + J.Number(source, "pr").ToString()
            let pull = GitHub.Api(path)
            if number < 1 || number == J.Number(source, "pr") || J.Number(pull, "number") != J.Number(source, "pr") ||
                !RepositoryIdentity
                .SameRepo(J.Text(J.Get(J.Get(pull, "base"), "repo"), "full_name"), repo) {
                throw Exception("Cannot link the superseded contribution")
            }
            let marker = "<!-- tokate-superseded:" + number.ToString() + " -->"
            let body = J.Text(pull, "body")
            if !body.Contains(marker, StringComparison.Ordinal) {
                GitHub.Api(
                    path,
                    map[string, Object?]{
                        "body": body + "\n\n" + marker + "\nSuperseded by #" + number.ToString() +
                            ". The repository owner may close this prior draft after reviewing the successor."
                    },
                    "PATCH"
                )
            }
        }

        internal func Import(checkout string, run Data) {
            let source = J.Get(run.Element(), "handoff")
            if source.ValueKind == JsonValueKind.Undefined {
                return
            }
            let head = Commands.Git(checkout, "rev-parse", "HEAD")
            if head == J.Text(source, "head") {
                return
            }
            if head != run.Text("base") {
                throw Exception("Handoff checkout changed before import; saved work is preserved")
            }
            Commands.Git(
                checkout,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                "https://github.com/" + J.Text(source, "fork") + ".git",
                J.Text(source, "head")
            )
            Commands.Git(checkout, "merge", "--quiet", "--ff-only", "--no-edit", J.Text(source, "head"))
        }
    }
}
