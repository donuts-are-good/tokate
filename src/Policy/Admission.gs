package Tokate

import System
import System.Collections.Generic
import System.Text.Json
import System.Text.RegularExpressions

internal class Admission {
    shared {
        internal func Run(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let event = RequestData.FileData(args.Need("event"), 1024 * 1024)
            let actions = []string{
                "opened",
                "reopened",
                "synchronize",
                "edited",
                "ready_for_review",
                "converted_to_draft",
                "labeled",
                "unlabeled",
                "assigned",
                "unassigned"
            }
            let number = J.Number(J.Get(event, "pull_request"), "number")
            let repository = J.Get(event, "repository")
            if Environment.GetEnvironmentVariable("GITHUB_EVENT_NAME") != "pull_request_target" || Array.IndexOf(
                actions,
                J.Text(event, "action")
            ) < 0 ||
                number < 1 ||
                !RepositoryIdentity
                .SameRepo(J.Text(repository, "full_name"), repo) {
                throw Exception("Expected a supported upstream pull_request_target event")
            }
            let repoId = RepositoryIdentity.PositiveId(J.Get(repository, "id"))
            let path = "repos/" + repo + "/pulls/" + number.ToString()
            var pull = GitHub.Api(path)
            var policy = CurrentPolicy(repo, repoId, pull, number)
            if J.Text(pull, "state") != "open" || Allowed(repo, repoId, pull, policy) {
                Result(repo, number, J.Text(pull, "state"))
                return
            }
            let marker = "<!-- tokate-admission:v1 -->"
            var commented bool
            for page in 1 ... 11 {
                let comments = GitHub.Api(
                    "repos/" + repo + "/issues/" + number.ToString() + "/comments?per_page=100&page=" + page.ToString()
                )
                if comments.ValueKind != JsonValueKind.Array {
                    throw Exception("Malformed canonical PR comments")
                }
                for comment in J.Items(comments) {
                    let user = J.Get(comment, "user")
                    commented = commented ||
                        (
                        J.Text(user, "login") == "github-actions[bot]" && J.Text(user, "type") == "Bot" && J.Text(
                            comment,
                            "body"
                        )
                            .Contains(marker)
                    )
                }
                if comments.GetArrayLength() < 100 {
                    break
                }
                if page == 10 {
                    throw Exception("PR comment inspection exceeded its bounded page limit")
                }
            }
            pull = GitHub.Api(path)
            policy = CurrentPolicy(repo, repoId, pull, number)
            if J.Text(pull, "state") != "open" || Allowed(repo, repoId, pull, policy) {
                Result(repo, number, J.Text(pull, "state"))
                return
            }
            let message = Policy.CloseMessage(policy.Value)
            if !commented && message != "" {
                GitHub.Api(
                    "repos/" + repo + "/issues/" + number.ToString() + "/comments",
                    J.Map("body", message + "\n\n" + marker)
                )
            }
            pull = GitHub.Api(path)
            policy = CurrentPolicy(repo, repoId, pull, number)
            if J.Text(pull, "state") != "open" || Allowed(repo, repoId, pull, policy) {
                Result(repo, number, J.Text(pull, "state"))
                return
            }
            GitHub.Api(path, J.Map("state", "closed"), "PATCH")
            Result(repo, number, "closed")
        }

        private func Result(repo string, number int32, state string) {
            PublicOutput.ResultData = J.Map("repo", repo, "pr", number, "admission", state)
            Terminal.Message("Admission: PR #" + number.ToString() + " " + state)
        }

        private func CurrentPolicy(repo string, repoId int64, pull JsonElement, number int32) Policy {
            let info = GitHub.Api("repos/" + repo)
            let target = J.Get(J.Get(pull, "base"), "repo")
            if RepositoryIdentity.PositiveId(J.Get(info, "id")) != repoId || !RepositoryIdentity.SameRepo(
                J.Text(info, "full_name"),
                repo
            ) ||
                RepositoryIdentity.PositiveId(J.Get(target, "id")) != repoId || !RepositoryIdentity.SameRepo(
                J.Text(target, "full_name"),
                repo
            ) ||
                J.Number(pull, "number") != number ||
                (J.Text(pull, "state") != "open" && J.Text(pull, "state") != "closed") {
                throw Exception("Canonical PR or upstream repository identity changed")
            }
            return Policy.Load(repo, GitHub.Branch(repo, J.Text(info, "default_branch")))
        }

        private func Nomination(repo string, pull JsonElement) int32 {
            let issues = HashSet[int32]()
            let body = J.Text(pull, "body")
            try {
                let receipt = PrBody.Receipt(body)
                if RepositoryIdentity.SameRepo(J.Text(receipt, "repo"), repo) && J.Number(receipt, "issue") > 0 {
                    issues.Add(J.Number(receipt, "issue"))
                }
            } catch { }
            let pattern = "https://github\\.com/" + Regex.Escape(repo) + "/issues/([0-9]+)(?![0-9A-Za-z_/])"
            for match Match in Regex.Matches(body, pattern, RegexOptions.IgnoreCase) {
                var issue int32
                if Int32.TryParse(match.Groups[1].Value, out issue) && issue > 0 {
                    issues.Add(issue)
                }
            }
            for match Match in Regex.Matches(body, "(?im)^\\s*(?:fixes|closes|resolves|issue)\\s*:?\\s*#([0-9]+)\\b") {
                var issue int32
                if Int32.TryParse(match.Groups[1].Value, out issue) && issue > 0 {
                    issues.Add(issue)
                }
            }
            let legacy = Regex.Match(J.Text(J.Get(pull, "head"), "ref"), "^tokate/issue-([0-9]+)-[0-9a-f]{12}$")
            var legacyIssue int32
            if legacy.Success && Int32.TryParse(legacy.Groups[1].Value, out legacyIssue) && legacyIssue > 0 {
                issues.Add(legacyIssue)
            }
            if issues.Count != 1 {
                return 0
            }
            for issue in issues {
                return issue
            }
            return 0
        }

        private func Allowed(repo string, repoId int64, pull JsonElement, policy Policy) bool {
            let author = J.Get(pull, "user")
            var actor = RepositoryIdentity.PositiveId(J.Get(author, "id"))
            var login = J.Text(author, "login")
            let bot = J.Text(author, "type") == "Bot" || login.EndsWith("[bot]", StringComparison.Ordinal)
            if !bot {
                RepositoryIdentity.Login(login)
                let permission = GitHub.Api("repos/" + repo + "/collaborators/" + login + "/permission")
                if RepositoryIdentity.PositiveId(J.Get(J.Get(permission, "user"), "id")) != actor {
                    throw Exception("Canonical maintainer identity changed")
                }
                let level = J.Text(permission, "permission")
                if level == "admin" || level == "write" || level == "maintain" {
                    return true
                }
                if level != "read" && level != "none" && level != "triage" {
                    throw Exception("Malformed canonical maintainer permission")
                }
            }
            let access = AccessState.Load(repo, repoId, missing: true)
            let mode = policy.Eligibility == "" ? "trusted": policy.Eligibility
            if !bot && access.Allows(actor, mode) {
                return true
            }
            var issue = Nomination(repo, pull)
            var state CoordinationState
            if bot {
                state = BoundState(repo, pull)
                if state.Sha == "" {
                    return false
                }
                issue = J.Number(state.Value(), "issue")
            } else {
                if issue == 0 {
                    return false
                }
                state = CoordinationState.Load(repo, issue, missing: true)
            }
            if state.Sha == "" {
                if bot {
                    return false
                }
                let reference = GitHub.Api(
                    "repos/" + repo + "/git/ref/heads/" + OwnerApproval.ApprovalRef(issue),
                    missing: true
                )
                if reference.ValueKind == JsonValueKind.Undefined {
                    return false
                }
                let approval = RequestData.Parse(
                    GitHub.FileAt(
                        repo,
                        ".github/tokate-approval.json",
                        RepositoryIdentity.CommitSha(J.Text(J.Get(reference, "object"), "sha"))
                    ),
                    1024 * 1024
                )
                Authority(approval, repo, issue, 1)
                if J.Text(J.Get(pull, "base"), "ref") != J.Text(approval, "base_branch") {
                    return false
                }
                if !String.Equals(J.Text(approval, "donor"), login, StringComparison.OrdinalIgnoreCase) ||
                    !access.Allows(actor, mode, issue, assigned: true) {
                    return false
                }
                let task = GitHub.Api("repos/" + repo + "/issues/" + issue.ToString(), missing: true)
                if task.ValueKind == JsonValueKind.Undefined || J.Text(task, "state") != "open" || J.Get(
                    task,
                    "pull_request"
                )
                    .ValueKind != JsonValueKind.Undefined ||
                    !GitHub.HasLabel(task) || !GitHub.Assigned(task, login) {
                    return false
                }
                try {
                    OwnerApproval.Approved(repo, issue, login)
                    return true
                } catch (error CliFailure) {
                    if error.Code == "stale_approval" {
                        return false
                    }
                    throw error
                }
            }
            let value = state.Value()
            let approval = J.Get(value, "approval")
            if J.Get(value, "revoked").ValueKind != JsonValueKind.True && J.Get(value, "revoked")
                .ValueKind != JsonValueKind.False {
                throw Exception("Malformed coordination revocation state")
            }
            Authority(approval, repo, issue, 2)
            if J.Text(J.Get(pull, "base"), "ref") != J.Text(approval, "base_branch") {
                return false
            }
            var taskScoped bool = false
            try {
                taskScoped = AccessState.Task(approval)
            } catch (error Exception) {
                throw Exception("Malformed trusted admission eligibility", error)
            }
            if bot {
                let binding = DonorBinding(repo, pull, state)
                if binding.ValueKind == JsonValueKind.Undefined {
                    return false
                }
                actor = RepositoryIdentity.PositiveId(J.Get(binding, "actor"))
                login = RepositoryIdentity.Login(J.Text(binding, "donor"))
                if access.Allows(actor, mode) {
                    return true
                }
            }
            if !access.Allows(
                actor,
                mode,
                issue,
                assigned: !taskScoped && String.Equals(
                    J.Text(approval, "donor"),
                    login,
                    StringComparison.OrdinalIgnoreCase
                )
            ) {
                return false
            }
            let task = GitHub.Api("repos/" + repo + "/issues/" + issue.ToString(), missing: true)
            if task.ValueKind == JsonValueKind.Undefined || J.Text(task, "state") != "open" || J.Get(
                task,
                "pull_request"
            )
                .ValueKind != JsonValueKind.Undefined {
                return false
            }
            try {
                state.Check(repo, issue, login, J.Parse(actor.ToString()))
                return true
            } catch (error CliFailure) {
                if error.Code == "stale_approval" ||
                    (
                    error.Code == "invalid_state" && J.Text(
                        J.Parse(J.Write(PublicOutput.ResultData)),
                        "authority"
                    ) != "unknown"
                ) {
                    return false
                }
                throw error
            }
        }

        internal func DonorBinding(
            repo string,
            pull JsonElement,
            state CoordinationState,
            requireLease bool = true
        ) JsonElement {
            let value = state.Value()
            let contribution = J.Get(value, "contribution")
            let current = CoordinationState.Current(value)
            let outcome = J.Get(current, "outcome")
            let head = J.Get(pull, "head")
            let headRepo = J.Get(head, "repo")
            let fork = J.Text(headRepo, "full_name")
            let branch = J.Text(head, "ref")
            let target = J.Text(J.Get(pull, "base"), "ref")
            if target != J.Text(J.Get(value, "approval"), "base_branch") {
                return JsonElement{}
            }
            var binding JsonElement
            if contribution.ValueKind == JsonValueKind.Object {
                let metadata = J.Get(contribution, "metadata")
                RepositoryIdentity.PositiveId(J.Get(outcome, "pr"))
                RepositoryIdentity.CommitSha(J.Text(outcome, "head"))
                RepositoryIdentity.Branch(J.Text(metadata, "branch"))
                RepositoryIdentity.Repo(J.Text(metadata, "fork"))
                if J.Number(outcome, "pr") != J.Number(pull, "number") || J.Text(metadata, "branch") != branch ||
                    !RepositoryIdentity.SameRepo(J.Text(metadata, "fork"), fork) {
                    return JsonElement{}
                }
                if J.Text(outcome, "head") != J.Text(head, "sha") {
                    if !requireLease {
                        return JsonElement{}
                    }
                    let reservation = J.Get(value, "reservation")
                    if reservation.ValueKind != JsonValueKind.Object || J.Text(reservation, "status") != "active" ||
                        branch != "tokate/v2-" +
                        J.Text(reservation, "reservation") || RepositoryIdentity.PositiveId(
                        J.Get(reservation, "actor")
                    ) != RepositoryIdentity.PositiveId(J.Get(contribution, "actor")) || !String.Equals(
                        J.Text(reservation, "donor"),
                        J.Text(contribution, "donor"),
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        return JsonElement{}
                    }
                    try {
                        state.Reservation(J.Get(contribution, "actor"))
                    } catch (error CliFailure) {
                        if error.Code == "stale_approval" {
                            return JsonElement{}
                        }
                        throw error
                    }
                }
                binding = contribution
            } else {
                if contribution.ValueKind != JsonValueKind.Undefined && contribution.ValueKind != JsonValueKind.Null {
                    throw Exception("Malformed trusted contribution binding")
                }
                let reservation = J.Get(value, "reservation")
                if reservation.ValueKind != JsonValueKind.Object {
                    return JsonElement{}
                }
                let donor = J.Text(reservation, "donor")
                if LeaseLifecycle.Supported(value) && RepositoryIdentity.PositiveId(
                    J.Get(J.Get(value, "identity"), "actor")
                ) != RepositoryIdentity.PositiveId(J.Get(reservation, "actor")) {
                    return JsonElement{}
                }
                if branch != "tokate/v2-" + J.Text(reservation, "reservation") || !fork.StartsWith(
                    donor + "/",
                    StringComparison.OrdinalIgnoreCase
                ) {
                    return JsonElement{}
                }
                if requireLease {
                    try {
                        LeaseLifecycle.Owner(state, J.Get(reservation, "actor"), active: true)
                    } catch (error CliFailure) {
                        if error.Code == "stale_approval" {
                            return JsonElement{}
                        }
                        throw error
                    }
                }
                binding = reservation
            }
            let actor = RepositoryIdentity.PositiveId(J.Get(binding, "actor"))
            let owner = J.Get(headRepo, "owner")
            if RepositoryIdentity.PositiveId(J.Get(owner, "id")) != actor || !String.Equals(
                J.Text(owner, "login"),
                J.Text(binding, "donor"),
                StringComparison.OrdinalIgnoreCase
            ) {
                return JsonElement{}
            }
            let live = GitHub.Api("repos/" + RepositoryIdentity.Repo(fork), missing: true)
            if live.ValueKind == JsonValueKind.Undefined {
                return JsonElement{}
            }
            let parent = J.Get(live, "parent")
            RepositoryIdentity.PositiveId(J.Get(live, "id"))
            if RepositoryIdentity.PositiveId(J.Get(J.Get(live, "owner"), "id")) != actor ||
                !RepositoryIdentity.SameRepo(J.Text(live, "full_name"), fork) ||
                (
                !RepositoryIdentity.SameRepo(fork, repo) &&
                    (
                    !J.Bool(live, "fork") || !RepositoryIdentity.SameRepo(J.Text(parent, "full_name"), repo) ||
                        RepositoryIdentity.PositiveId(J.Get(parent, "id")) != RepositoryIdentity.PositiveId(
                        J.Get(J.Get(J.Get(pull, "base"), "repo"), "id")
                    )
                )
            ) ||
                RepositoryIdentity.PositiveId(J.Get(live, "id")) != RepositoryIdentity.PositiveId(
                J.Get(headRepo, "id")
            ) {
                return JsonElement{}
            }
            let reference = GitHub.Api(
                "repos/" + fork + "/git/ref/heads/" + Uri.EscapeDataString(RepositoryIdentity.Branch(branch)),
                missing: true
            )
            if reference.ValueKind == JsonValueKind.Undefined || J.Text(J.Get(reference, "object"), "sha") != J.Text(
                head,
                "sha"
            ) {
                return JsonElement{}
            }
            return binding
        }

        private func BoundState(repo string, pull JsonElement) CoordinationState {
            let refs = GitHub.Api("repos/" + repo + "/git/matching-refs/heads/tokate/contributions/")
            if refs.ValueKind != JsonValueKind.Array || refs.GetArrayLength() > 1000 {
                throw Exception("Cannot inspect bounded canonical contribution bindings")
            }
            var result = CoordinationState()
            for reference in J.Items(refs) {
                let name = Regex.Match(J.Text(reference, "ref"), "^refs/heads/tokate/contributions/([0-9]+)$")
                var issue int32
                if !name.Success || !Int32.TryParse(name.Groups[1].Value, out issue) || issue < 1 || J.Text(
                    J.Get(reference, "object"),
                    "type"
                ) != "commit" {
                    throw Exception("Malformed canonical contribution reference")
                }
                let state = CoordinationState.At(repo, issue, J.Text(J.Get(reference, "object"), "sha"))
                Authority(J.Get(state.Value(), "approval"), repo, issue, 2)
                if DonorBinding(repo, pull, state).ValueKind == JsonValueKind.Undefined {
                    continue
                }
                if result.Sha != "" {
                    return CoordinationState()
                }
                result = state
            }
            return result
        }

        private func Authority(approval JsonElement, repo string, issue int32, version int32) {
            if J.Number(approval, "version") != version || J.Number(approval, "issue") != issue ||
                !RepositoryIdentity
                .SameRepo(J.Text(approval, "repo"), repo) {
                throw Exception("Malformed trusted admission approval identity")
            }
            RepositoryIdentity.CommitSha(J.Text(approval, "base"))
            RepositoryIdentity.Branch(J.Text(approval, "base_branch"))
            if J.Get(approval, "authority_branch").ValueKind != JsonValueKind.Undefined {
                RepositoryIdentity.Branch(J.Text(approval, "authority_branch"))
            }
            for key in[]string{"policy_hash", "template_hash", "issue_hash"} {
                if !Regex.IsMatch(J.Text(approval, key), "^[0-9a-f]{64}$") {
                    throw Exception("Malformed trusted admission approval digest")
                }
            }
            if !AccessState.Task(approval) {
                RepositoryIdentity.Login(J.Text(approval, "donor"))
            }
        }
    }
}
