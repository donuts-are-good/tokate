package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class AccessState {
    internal var Sha string = ""
    internal var RepoId int64
    internal let Members List[JsonElement] = List[JsonElement]()
    internal func Allows(actor int64, mode string, issue int32 = 0, assigned bool = false) bool {
        var trusted bool
        var denied bool
        var granted bool
        for member in Members {
            if RepositoryIdentity.PositiveId(J.Get(member, "actor")) == actor {
                trusted = J.Bool(member, "trusted")
                denied = J.Bool(member, "denied")
                for number in J.Items(J.Get(member, "issues")) {
                    granted = granted || RepositoryIdentity.PositiveId(number) == issue
                }
            }
        }
        return !denied && (mode == "open" || granted || assigned || (mode == "trusted" && trusted))
    }

    internal func Value() JsonElement -> J.Parse(
        J.Write(map[string, Object?]{"version": 1, "repo_id": RepoId, "members": Members})
    )

    internal func Write(repo string, expected string) {
        let text = J.Write(Value())
        RequestData.Parse(text, 65536)
        let tree = GitHub.Api(
            "repos/" + repo + "/git/trees",
            map[string, Object?]{
                "tree": []Object{
                    map[string, Object?]{"path": "access.json", "mode": "100644", "type": "blob", "content": text}
                }
            }
        )
        let commit = GitHub.Api(
            "repos/" + repo + "/git/commits",
            GitHub.AutomationCommit("Tokate donor access", J.Text(tree, "sha"), []string{expected})
        )
        let next = RepositoryIdentity.CommitSha(J.Text(commit, "sha"))
        try {
            if Sha == "" {
                GitHub.Api(
                    "repos/" + repo + "/git/refs",
                    map[string, Object?]{"ref": "refs/heads/tokate/access", "sha": next}
                )
            } else {
                GitHub.Api(
                    "repos/" + repo + "/git/refs/heads/tokate/access",
                    map[string, Object?]{"sha": next, "force": false},
                    "PATCH"
                )
            }
        } catch (error Exception) {
            var live AccessState
            try {
                live = Load(repo, RepoId)
            } catch (inspection Exception) {
                throw CliFailure(
                    "invalid_state",
                    "Access write outcome could not be inspected. Read the owner access ref before an explicit new operation; no write was repeated."
                )
            }
            if live.Sha != next || RequestData.Canonical(live.Value()) != RequestData.Canonical(Value()) {
                throw CliFailure(
                    "invalid_state",
                    "Access write is uncertain or lost a concurrent update. Inspect current access before an explicit new operation; no write was repeated."
                )
            }
        }
        Sha = next
    }

    shared {
        internal func Task(approval JsonElement) bool {
            let declaration = J.Get(approval, "approval_scope")
            let mode = J.Get(approval, "eligibility")
            let identity = J.Get(approval, "repo_id")
            if declaration.ValueKind == JsonValueKind.Undefined &&
                mode.ValueKind == JsonValueKind.Undefined &&
                (identity.ValueKind == JsonValueKind.Undefined || J.Number(approval, "version") == 1) {
                return false
            }
            RequestData.Parse(J.Write(approval), 1024 * 1024)
            let eligibility = J.Text(approval, "eligibility")
            let donor = J.Get(approval, "donor")
            if J.Number(approval, "version") != 2 || J.Text(approval, "approval_scope") != "task" ||
                (eligibility != "open" && eligibility != "trusted" && eligibility != "manual") ||
                donor.ValueKind != JsonValueKind.Undefined {
                throw CliFailure("stale_approval", "Malformed or contradictory task eligibility approval")
            }
            RepositoryIdentity.PositiveId(identity)
            return true
        }

        internal func Load(repo string, repoId int64, missing bool = false) AccessState {
            let result = AccessState{RepoId: repoId}
            let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/tokate/access", missing: missing)
            if reference.ValueKind == JsonValueKind.Undefined {
                return result
            }
            if J.Text(J.Get(reference, "object"), "type") != "commit" {
                throw Exception("Donor access ref must identify a commit")
            }
            result.Sha = RepositoryIdentity.CommitSha(J.Text(J.Get(reference, "object"), "sha"))
            let value = RequestData.Parse(GitHub.FileAt(repo, "access.json", result.Sha), 65536)
            RequestData.Keys(value, "version,repo_id,members")
            let members = J.Get(value, "members")
            if J.Number(value, "version") != 1 || RepositoryIdentity.PositiveId(J.Get(value, "repo_id")) != repoId ||
                members.ValueKind != JsonValueKind.Array {
                throw Exception("Invalid donor access repository identity or membership")
            }
            let actors = HashSet[int64]()
            for member in J.Items(members) {
                RequestData.Keys(member, "actor,trusted,denied,issues")
                let actor = RepositoryIdentity.PositiveId(J.Get(member, "actor"))
                if !actors.Add(actor) || J.Get(member, "issues").ValueKind != JsonValueKind.Array {
                    throw Exception("Invalid or duplicate donor access membership")
                }
                for flag in[]string{"trusted", "denied"} {
                    let item = J.Get(member, flag)
                    if item.ValueKind != JsonValueKind.True && item.ValueKind != JsonValueKind.False {
                        throw Exception("Invalid donor access flag")
                    }
                }
                let issues = HashSet[int64]()
                for issue in J.Items(J.Get(member, "issues")) {
                    let id = RepositoryIdentity.PositiveId(issue)
                    if id > Int32.MaxValue || !issues.Add(id) {
                        throw Exception("Invalid or duplicate issue grant")
                    }
                }
                if !J.Bool(member, "trusted") && !J.Bool(member, "denied") && issues.Count == 0 {
                    throw Exception("Empty donor access membership")
                }
                result.Members.Add(member)
            }
            return result
        }

        internal func Check(repo string, issue int32, approval JsonElement, actor JsonElement) {
            if !Task(approval) {
                return
            }
            PublicOutput.ResultData = map[string, Object?]{
                "repo": repo,
                "issue": issue,
                "eligible": false,
                "authority": "unknown"
            }
            let recovery = []string{
                "tokate",
                "access",
                "--repo",
                repo,
                "--operation",
                "check",
                "--issue",
                issue.ToString(),
                "--json"
            }
            try {
                let id = RepositoryIdentity.PositiveId(actor)
                let info = GitHub.Api("repos/" + repo)
                let repoId = RepositoryIdentity.PositiveId(J.Get(info, "id"))
                if repoId != RepositoryIdentity.PositiveId(J.Get(approval, "repo_id")) {
                    throw Exception("Task repository numeric identity changed")
                }
                let access = Load(repo, repoId)
                let mode = J.Text(approval, "eligibility")
                let allowed = access.Allows(id, mode, issue)
                PublicOutput.ResultData = map[string, Object?]{
                    "repo": repo,
                    "issue": issue,
                    "actor": id,
                    "eligibility": mode,
                    "eligible": allowed,
                    "access_sha": access.Sha
                }
                if !allowed {
                    throw CliFailure(
                        "invalid_state",
                        "Current donor access does not permit this task. The owner must restore access or grant the required membership.",
                        recovery
                    )
                }
            } catch (error CliFailure) {
                throw error
            } catch (error Exception) {
                PublicOutput.ResultData = map[string, Object?]{
                    "repo": repo,
                    "issue": issue,
                    "eligible": false,
                    "authority": "unknown"
                }
                throw CliFailure(
                    "invalid_state",
                    "Donor access authority is unavailable or malformed. Inspect owner-controlled access before proceeding.",
                    recovery
                )
            }
        }

        private func Pages(path string) List[JsonElement] {
            let result = List[JsonElement]()
            for page in 1 ... 11 {
                let value = GitHub.Api(path + "per_page=100&page=" + page.ToString())
                if value.ValueKind != JsonValueKind.Array {
                    throw Exception("Expected a paginated GitHub list")
                }
                let rows = J.Items(value)
                result.AddRange(rows)
                if rows.Count < 100 {
                    return result
                }
            }
            throw Exception(
                "Access presentation exceeded 1000 records; inspect GitHub directly or restrict requests to one issue"
            )
        }

        private func AccessRequest(repo string, comment JsonElement) JsonElement {
            let body = J.Text(comment, "body")
            if !body.StartsWith("/tokate-access ") || body.Length > 2048 {
                return JsonElement{}
            }
            try {
                let request = RequestData.Parse(body.Substring(15), 2048)
                RequestData.Keys(request, "version,scope,issue")
                let issue = J.Number(request, "issue")
                let requestScope = J.Text(request, "scope")
                if J.Number(request, "version") != 1 ||
                    issue < 1 ||
                    (requestScope != "issue" && requestScope != "trust") ||
                    !RepositoryIdentity.IsIssueUrl(J.Text(comment, "issue_url"), repo, issue) {
                    return JsonElement{}
                }
                let user = J.Get(comment, "user")
                return J.Parse(
                    J.Write(
                        map[string, Object?]{
                            "comment": RepositoryIdentity.PositiveId(J.Get(comment, "id")),
                            "actor": RepositoryIdentity.PositiveId(J.Get(user, "id")),
                            "donor": RepositoryIdentity.Login(J.Text(user, "login")),
                            "issue": issue,
                            "scope": requestScope
                        }
                    )
                )
            } catch (error Exception) {
                return JsonElement{}
            }
        }

        private func RequestAccess(repo string, args Args) {
            if args.Get("donor") != "" {
                throw Exception("Access requests use the authenticated donor")
            }
            let issue = args.Number("issue")
            GitHub.Issue(repo, issue)
            let viewer = GitHub.Api("user")
            let actor = RepositoryIdentity.PositiveId(J.Get(viewer, "id"))
            let requestScope = args.Get("scope", "issue")
            let comments = Pages("repos/" + repo + "/issues/" + issue.ToString() + "/comments?")
            for comment in comments {
                let request = AccessRequest(repo, comment)
                if request.ValueKind != JsonValueKind.Undefined && RepositoryIdentity.PositiveId(
                    J.Get(request, "actor")
                ) == actor &&
                    J.Text(request, "scope") == requestScope {
                    PublicOutput.ResultData = map[string, Object?]{
                        "repo": repo,
                        "issue": issue,
                        "scope": requestScope,
                        "posted": false,
                        "comment": J.Get(request, "comment")
                    }
                    Terminal.Message("An access request already exists; owner review is still required.")
                    return
                }
            }
            let comment = GitHub.Api(
                "repos/" + repo + "/issues/" + issue.ToString() + "/comments",
                map[string, Object?]{
                    "body": "/tokate-access " + J.Write(
                        map[string, Object?]{"version": 1, "scope": requestScope, "issue": issue}
                    )
                }
            )
            PublicOutput.ResultData = map[string, Object?]{
                "repo": repo,
                "issue": issue,
                "scope": requestScope,
                "posted": true,
                "comment": J.Get(comment, "id")
            }
            Terminal.Message(
                "Access requested. The owner can grant this issue or persistent trust; the request grants no eligibility."
            )
        }

        internal func Pending(
            repo string,
            access AccessState,
            pending List[JsonElement],
            issue int32 = 0,
            actor int64 = 0,
            bounded bool = false
        ) bool {
            let commentsPath = issue == 0 ? "/issues/comments?": "/issues/" + issue.ToString() + "/comments?"
            let seen = HashSet[string]()
            let limit = bounded ? 2: 10
            for page in 1 ... limit + 1 {
                let value = GitHub.Api("repos/" + repo + commentsPath + "per_page=100&page=" + page.ToString())
                if value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > 100 {
                    throw Exception("Expected a bounded paginated GitHub request list")
                }
                for comment in J.Items(value) {
                    let request = AccessRequest(repo, comment)
                    if request.ValueKind == JsonValueKind.Undefined {
                        continue
                    }
                    let id = RepositoryIdentity.PositiveId(J.Get(request, "actor"))
                    if actor != 0 && id != actor {
                        continue
                    }
                    var resolved bool
                    for member in access.Members {
                        if RepositoryIdentity.PositiveId(J.Get(member, "actor")) != id {
                            continue
                        }
                        resolved = J.Bool(member, "denied") ||
                            (J.Text(request, "scope") == "trust" && J.Bool(member, "trusted"))
                        if J.Text(request, "scope") == "issue" {
                            for number in J.Items(J.Get(member, "issues")) {
                                resolved = resolved || RepositoryIdentity.PositiveId(number) == J.Number(
                                    request,
                                    "issue"
                                )
                            }
                        }
                    }
                    let key = id.ToString() + ":" + J.Text(request, "scope") + ":" + J.Number(request, "issue")
                        .ToString()
                    if !resolved && seen.Add(key) {
                        pending.Add(request)
                    }
                }
                if value.GetArrayLength() < 100 {
                    return false
                }
            }
            if bounded {
                return true
            }
            throw Exception(
                "Access presentation exceeded 1000 records; inspect GitHub directly or restrict requests to one issue"
            )
        }

        private func Present(repo string, args Args) {
            let info = GitHub.Api("repos/" + repo)
            let access = Load(repo, RepositoryIdentity.PositiveId(J.Get(info, "id")))
            let donor = args.Get("donor")
            var actor int64
            if donor != "" {
                actor = RepositoryIdentity.PositiveId(
                    J.Get(GitHub.Api("users/" + RepositoryIdentity.Login(donor)), "id")
                )
            }
            let members = List[JsonElement]()
            let trusted = List[JsonElement]()
            for member in access.Members {
                if actor == 0 || RepositoryIdentity.PositiveId(J.Get(member, "actor")) == actor {
                    let displayed = map[string, Object?]{
                        "actor": J.Get(member, "actor"),
                        "trusted": J.Get(member, "trusted"),
                        "denied": J.Get(member, "denied"),
                        "issues": J.Get(member, "issues")
                    }
                    let identity = GitHub.Api(
                        "user/" + RepositoryIdentity.PositiveId(J.Get(member, "actor")).ToString()
                    )
                    if RepositoryIdentity.PositiveId(J.Get(identity, "id")) != RepositoryIdentity.PositiveId(
                        J.Get(member, "actor")
                    ) {
                        throw Exception("Donor display identity changed")
                    }
                    displayed["donor"] = RepositoryIdentity.Login(J.Text(identity, "login"))
                    let row = J.Parse(J.Write(displayed))
                    members.Add(row)
                    if J.Bool(member, "trusted") && !J.Bool(member, "denied") {
                        trusted.Add(row)
                    }
                }
            }
            let history = List[Object]()
            if args.Get("operation") == "history" {
                for pull in Pages("repos/" + repo + "/pulls?state=all&") {
                    try {
                        let receipt = PrBody.Receipt(J.Text(pull, "body"))
                        let headOwner = J.Get(J.Get(J.Get(pull, "head"), "repo"), "owner")
                        let donorId = RepositoryIdentity.PositiveId(J.Get(headOwner, "id"))
                        let donorLogin = RepositoryIdentity.Login(J.Text(headOwner, "login"))
                        if !RepositoryIdentity.SameRepo(J.Text(receipt, "repo"), repo) || !String.Equals(
                            J.Text(receipt, "donor"),
                            donorLogin,
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            (actor != 0 && donorId != actor) ||
                            (args.Get("issue") != "" && J.Number(receipt, "issue") != args.Number("issue")) {
                            continue
                        }
                        history.Add(
                            map[string, Object?]{
                                "pr": J.Number(pull, "number"),
                                "issue": J.Number(receipt, "issue"),
                                "donor": donorLogin,
                                "state": J.Text(pull, "state"),
                                "merged": J.Get(pull, "merged_at").ValueKind == JsonValueKind.String,
                                "evidence": "unverified PR receipt; inspect verify-pr and owner review"
                            }
                        )
                    } catch (error Exception) { }
                }
            }
            let pending = List[JsonElement]()
            if args.Get("operation") == "list" {
                Pending(repo, access, pending, args.Get("issue") == "" ? 0: args.Number("issue"), actor)
            }
            PublicOutput.ResultData = map[string, Object?]{
                "repo": repo,
                "access_sha": access.Sha,
                "members": members,
                "trusted": trusted,
                "pending": pending,
                "history": history
            }
            if !PublicOutput.Enabled {
                Terminal.Json(J.Parse(J.Write(PublicOutput.ResultData)), "Donor access and owner review")
            }
        }

        internal func Run(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let operation = args.Need("operation")
            if operation != "request" && args.Get("scope") != "" {
                throw Exception("Only access request takes --scope")
            }
            if operation == "request" {
                RequestAccess(repo, args)
                return
            }
            if operation == "list" || operation == "history" {
                Present(repo, args)
                return
            }
            if operation == "check" {
                if args.Get("donor") != "" {
                    throw Exception("Access check uses the authenticated donor")
                }
                let viewer = GitHub.Api("user")
                RepositoryIdentity.PositiveId(J.Get(viewer, "id"))
                let issue = args.Number("issue")
                let state = CoordinationState.Load(repo, issue)
                let record = state.Check(
                    repo,
                    issue,
                    RepositoryIdentity.Login(J.Text(viewer, "login")),
                    J.Get(viewer, "id")
                )
                if !Task(J.Get(record, "approval")) {
                    PublicOutput.ResultData = map[string, Object?]{
                        "repo": repo,
                        "issue": issue,
                        "eligible": true,
                        "eligibility": "assignment"
                    }
                }
                if !PublicOutput.Enabled {
                    Terminal.Json(J.Parse(J.Write(PublicOutput.ResultData)), "Donor eligibility")
                }
                return
            }
            if Array.IndexOf(
                []string{"init", "trust", "untrust", "grant", "remove", "deny", "restore"},
                operation
            ) < 0 {
                throw Exception("Unknown access operation")
            }
            RepositoryIdentity.PositiveId(J.Get(GitHub.Api("user"), "id"))
            let info = RepositoryAccess.RequireOwner(repo)
            let repoId = RepositoryIdentity.PositiveId(J.Get(info, "id"))
            let single = operation == "grant" || operation == "remove"
            if (single && args.Get("issue") == "") ||
                (!single && args.Get("issue") != "") ||
                (operation == "init" && args.Get("donor") != "") {
                throw Exception("Only grant/remove require --issue; init takes no donor")
            }
            let access = Load(repo, repoId, true)
            let expected = access.Sha == "" ? GitHub.Branch(repo, J.Text(info, "default_branch")): access.Sha
            var actor int64
            if operation == "init" {
                if access.Sha != "" {
                    throw Exception("Access already exists; inspect current membership")
                }
            } else {
                let donor = RepositoryIdentity.Login(args.Need("donor"))
                actor = RepositoryIdentity.PositiveId(J.Get(GitHub.Api("users/" + donor), "id"))
                var trusted bool
                var denied bool
                let issues = SortedSet[int64]()
                var index int32 = -1
                for i in 0 ... access.Members.Count {
                    let member = access.Members[i]
                    if RepositoryIdentity.PositiveId(J.Get(member, "actor")) == actor {
                        index = i
                        trusted = J.Bool(member, "trusted")
                        denied = J.Bool(member, "denied")
                        for issue in J.Items(J.Get(member, "issues")) {
                            issues.Add(RepositoryIdentity.PositiveId(issue))
                        }
                    }
                }
                if single {
                    let issue = args.Number("issue")
                    if operation == "grant" {
                        GitHub.Issue(repo, issue)
                    }
                    if operation == "grant" {
                        issues.Add(issue)
                    } else {
                        issues.Remove(issue)
                    }
                }
                if operation == "trust" {
                    trusted = true
                }
                if operation == "untrust" {
                    trusted = false
                }
                if operation == "deny" {
                    denied = true
                }
                if operation == "restore" {
                    denied = false
                }
                if index >= 0 {
                    access.Members.RemoveAt(index)
                }
                if trusted || denied || issues.Count > 0 {
                    access.Members.Add(
                        J.Parse(
                            J.Write(
                                map[string, Object?]{
                                    "actor": actor,
                                    "trusted": trusted,
                                    "denied": denied,
                                    "issues": issues
                                }
                            )
                        )
                    )
                }
            }
            access.Write(repo, expected)
            Terminal.Message(
                "Eligibility changes do not alter task scope approval. Revoked access blocks new work and publication; every PR requires owner review.",
                "cyan",
                true
            )
            PublicOutput.ResultData = map[string, Object?]{
                "repo": repo,
                "repo_id": repoId,
                "actor": actor,
                "operation": operation,
                "access_sha": access.Sha
            }
            if !PublicOutput.Enabled {
                Terminal.Json(J.Parse(J.Write(PublicOutput.ResultData)), "Owner access updated")
            }
        }
    }
}
