package Tokate

import System
import System.Collections.Generic
import System.Text.Json
import System.Text.RegularExpressions

// This command uses GitHub data APIs only. It never invokes Git, a harness,
// a verifier, repository scripts, or request-supplied executable content.
internal class Coordinator {
    shared {
        internal func Run(args Args) {
            let repo = Data.Repo(args.Need("repo"))
            let event = RequestData.FileData(args.Need("event"), 1024 * 1024)
            if Environment.GetEnvironmentVariable("GITHUB_EVENT_NAME") != "issue_comment" || J.Text(
                event,
                "action"
            ) != "created" ||
                !J
                .Text(J.Get(event, "comment"), "body").StartsWith("/tokate ", StringComparison.Ordinal) || J.Get(
                J.Get(event, "issue"),
                "pull_request"
            )
                .ValueKind != JsonValueKind.Undefined {
                throw Exception("Expected a created issue_comment /tokate request")
            }
            if J.Text(J.Get(event, "repository"), "full_name") != repo {
                throw Exception("Event repository does not match coordinator repository")
            }
            let number = J.Number(J.Get(event, "issue"), "number")
            let commentId = PositiveId(J.Get(J.Get(event, "comment"), "id"))
            let canonical = GitHub.Api("repos/" + repo + "/issues/comments/" + commentId.ToString())
            let actor = J.Get(J.Get(canonical, "user"), "id")
            PositiveId(actor)
            let donor = Data.Login(J.Text(J.Get(canonical, "user"), "login"))
            let info = Workflow.RequireOwner(repo)
            if number < 1 || J.Get(J.Get(event, "repository"), "id").ToString() != J.Get(info, "id").ToString() ||
                J
                .Get(canonical, "id").ToString() != commentId.ToString() || J.Text(
                canonical,
                "issue_url"
            ) != "https://api.github.com/repos/" +
                repo +
                "/issues/" +
                number.ToString() || actor.ToString() != J.Get(J.Get(J.Get(event, "comment"), "user"), "id")
                .ToString() || J.Text(canonical, "body") != J.Text(J.Get(event, "comment"), "body") {
                throw Exception("Comment author, content, repository or issue identity changed")
            }
            let text = J.Text(canonical, "body")
            if !text.StartsWith("/tokate ", StringComparison.Ordinal) {
                throw Exception("Canonical comment is not a request")
            }
            let request = RequestData.Parse(text.Substring(8))
            RequestData.Request(request)
            let state = CoordinationState.Load(repo, number)
            let binding = Data.Hash(
                RequestData.Canonical(
                    J.Parse(
                        J.Write(
                            J.Map(
                                "actor",
                                actor,
                                "expected",
                                J.Text(request, "expected"),
                                "approval",
                                J.Text(request, "approval"),
                                "request",
                                request
                            )
                        )
                    )
                )
            )
            let outcomes = J.Items(J.Get(state.Value(), "outcomes"))
            for old in outcomes {
                if J.Text(old, "uuid") == J.Text(request, "uuid") {
                    if J.Text(old, "binding") != binding {
                        throw Exception("UUID replay changed actor or request contents")
                    }
                    Terminal.Json(J.Get(old, "outcome"), "Recorded request outcome")
                    return
                }
            }
            if state.Sha != J.Text(request, "expected") || J.Text(state.Value(), "approval_id") != J.Text(
                request,
                "approval"
            ) {
                throw Exception("Stale state or approval; evicted requests cannot repeat effects")
            }
            let record = state.Check(repo, number, donor)
            var outcome Object = J.Map()
            if J.Text(request, "action") == "claim" {
                let reservation = J.Get(state.Value(), "reservation")
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
            } else {
                state.Reservation(actor)
                if J.Get(state.Value(), "contribution").ValueKind == JsonValueKind.Object {
                    throw Exception("Contribution already published; use the recorded outcome or fresh owner approval")
                }
                let metadata = J.Get(request, "metadata")
                Policy(J.Write(J.Get(record, "policy"))).ValidateTools(
                    J.Get(metadata, "tools"),
                    J.Text(metadata, "source")
                )
                ValidateFork(repo, donor, metadata, actor)
                ValidateDiff(repo, record, metadata)
                let reservation = J.Text(J.Get(state.Value(), "reservation"), "reservation")
                if J.Text(metadata, "branch") != "tokate/v2-" + reservation {
                    throw Exception("Publication must use this reservation's branch")
                }
                let marker = "<!-- tokate-v2:" + reservation + " -->"
                let receipt = J.Map(
                    "version",
                    2,
                    "repo",
                    repo,
                    "issue",
                    number,
                    "approval",
                    J.Text(state.Value(), "approval_id"),
                    "expected",
                    J.Text(request, "expected"),
                    "reservation",
                    reservation,
                    "donor",
                    donor,
                    "head",
                    J.Text(metadata, "head")
                )
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
                    if !J.Text(pull, "body").Contains(marker) || J.Text(J.Get(pull, "head"), "sha") != J.Text(
                        metadata,
                        "head"
                    ) ||
                        !J
                        .Text(pull, "body").Contains("<!-- tokate-receipt:" + J.Write(receipt) + " -->") {
                        throw Exception("Existing PR differs from this contribution")
                    }
                }
                Revalidate(repo, number, state, actor, donor)
                ValidateFork(repo, donor, metadata, actor)
                if pull.ValueKind == JsonValueKind.Undefined {
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
                        expires: CoordinationState.Unix(J.Get(state.Value(), "reservation"), "expires")
                    )
                }
                // A PR write and a state ref update cannot be atomic. A losing
                // writer can leave a physical PR, but it receives no authority.
                Revalidate(repo, number, state, actor, donor)
                ValidateFork(repo, donor, metadata, actor)
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
            state.Write(
                repo,
                number,
                J.Text(request, "expected"),
                CoordinationState.Unix(J.Get(state.Value(), "reservation"), "expires")
            )
            Terminal.Json(J.Parse(J.Write(outcome)), "Request outcome")
        }

        private func PositiveId(value JsonElement) int64 {
            var id int64
            if !value.TryGetInt64(out id) || id < 1 {
                throw Exception("Expected a positive numeric GitHub identity")
            }
            return id
        }

        private func Revalidate(repo string, issue int32, state CoordinationState, actor JsonElement, donor string) {
            let live = CoordinationState.Load(repo, issue)
            if live.Sha != state.Sha {
                throw Exception("Coordination revision changed during publication")
            }
            live.Check(repo, issue, donor)
            live.Reservation(actor)
        }

        internal func ValidateFork(repo string, donor string, metadata JsonElement, actor JsonElement) {
            let fork = Data.Repo(J.Text(metadata, "fork"))
            if !String.Equals(fork.Split('/')[0], donor, StringComparison.OrdinalIgnoreCase) || fork == repo {
                throw Exception("Use a donor-owned fork")
            }
            let info = GitHub.Api("repos/" + fork)
            if !String.Equals(J.Text(J.Get(info, "parent"), "full_name"), repo, StringComparison.OrdinalIgnoreCase) ||
                J
                .Get(J.Get(info, "owner"), "id").ToString() != actor.ToString() {
                throw Exception("Fork ownership or upstream identity differs")
            }
            let reference = GitHub.Api("repos/" + fork + "/git/ref/heads/" + J.Text(metadata, "branch"))
            if J.Text(J.Get(reference, "object"), "sha") != J.Text(metadata, "head") {
                throw Exception("Fork branch does not point to the exact declared commit")
            }
        }

        private func ValidateDiff(repo string, record JsonElement, metadata JsonElement) {
            let comparison = GitHub.Api(
                "repos/" + repo + "/compare/" + J.Text(J.Get(record, "approval"), "base") + "..." + J.Text(
                    metadata,
                    "fork"
                )
                    .Split('/')[0] +
                    ":" +
                    J.Text(metadata, "head")
            )
            let files = J.Items(J.Get(comparison, "files"))
            if J.Text(comparison, "status") != "ahead" || files.Count == 0 || files.Count >= 300 {
                throw Exception("Contribution must descend from approved base with a bounded nonempty diff")
            }
            for file in files {
                for name in[]string{J.Text(file, "filename"), J.Text(file, "previous_filename")} {
                    if name.StartsWith(".github/workflows/") || name.StartsWith(".github/tokate") {
                        throw Exception("Contribution changes protected owner configuration")
                    }
                }
            }
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
            values["report"] = "Donor-declared contribution source: " + J.Text(metadata, "source") +
                ". The coordinator did not observe coding execution. Local verification pass is donor-reported to the coordinator. Owner CI and review must validate this exact commit."
            values["donor"] = donor
            values["model"] = "donor-reported tools: " + J.Write(J.Get(metadata, "tools"))
            values["effort"] = "per-tool declaration; not independently attested"
            values["seconds"] = "donor-reported or unknown; reservation is not a compute budget"
            values["base"] = J.Text(J.Get(record, "approval"), "base")
            values["policy"] = J.Text(J.Get(record, "approval"), "policy_hash")
            values["usage"] = "per-tool donor declaration; not independently attested"
            values["receipt"] = marker + "\n<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            return Regex.Replace(
                J.Text(record, "template"),
                "\\{\\{([a-z_]+)\\}\\}",
                (match Match) -> values[match.Groups[1].Value]
            )
        }
    }
}
