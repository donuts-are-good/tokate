package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class AccessState {
    internal var Sha string = ""
    internal var RepoId int64
    internal let Members List[JsonElement] = List[JsonElement]()
    internal func Value() JsonElement -> J.Parse(J.Write(J.Map("version", 1, "repo_id", RepoId, "members", Members)))

    internal func Write(repo string, expected string) {
        let text = J.Write(Value())
        RequestData.Parse(text, 65536)
        let tree = GitHub.Api(
            "repos/" + repo + "/git/trees",
            J.Map("tree", []Object{J.Map("path", "access.json", "mode", "100644", "type", "blob", "content", text)})
        )
        let commit = GitHub.Api(
            "repos/" + repo + "/git/commits",
            GitHub.AutomationCommit("Tokate donor access", J.Text(tree, "sha"), []string{expected})
        )
        let next = RepositoryIdentity.CommitSha(J.Text(commit, "sha"))
        try {
            if Sha == "" {
                GitHub.Api("repos/" + repo + "/git/refs", J.Map("ref", "refs/heads/tokate/access", "sha", next))
            } else {
                GitHub.Api(
                    "repos/" + repo + "/git/refs/heads/tokate/access",
                    J.Map("sha", next, "force", false),
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
            PublicOutput.ResultData = J.Map("repo", repo, "issue", issue, "eligible", false, "authority", "unknown")
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
                var trusted bool
                var denied bool
                var granted bool
                for member in access.Members {
                    if RepositoryIdentity.PositiveId(J.Get(member, "actor")) == id {
                        trusted = J.Bool(member, "trusted")
                        denied = J.Bool(member, "denied")
                        for number in J.Items(J.Get(member, "issues")) {
                            granted = granted || RepositoryIdentity.PositiveId(number) == issue
                        }
                    }
                }
                let mode = J.Text(approval, "eligibility")
                let allowed = !denied && (mode == "open" || granted || (mode == "trusted" && trusted))
                PublicOutput.ResultData = J.Map(
                    "repo",
                    repo,
                    "issue",
                    issue,
                    "actor",
                    id,
                    "eligibility",
                    mode,
                    "eligible",
                    allowed,
                    "access_sha",
                    access.Sha
                )
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
                PublicOutput.ResultData = J.Map("repo", repo, "issue", issue, "eligible", false, "authority", "unknown")
                throw CliFailure(
                    "invalid_state",
                    "Donor access authority is unavailable or malformed. Inspect owner-controlled access before proceeding.",
                    recovery
                )
            }
        }

        internal func Run(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let operation = args.Need("operation")
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
                    PublicOutput.ResultData = J.Map(
                        "repo",
                        repo,
                        "issue",
                        issue,
                        "eligible",
                        true,
                        "eligibility",
                        "assignment"
                    )
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
                        J.Parse(J.Write(J.Map("actor", actor, "trusted", trusted, "denied", denied, "issues", issues)))
                    )
                }
            }
            access.Write(repo, expected)
            PublicOutput.ResultData = J.Map(
                "repo",
                repo,
                "repo_id",
                repoId,
                "actor",
                actor,
                "operation",
                operation,
                "access_sha",
                access.Sha
            )
            if !PublicOutput.Enabled {
                Terminal.Json(J.Parse(J.Write(PublicOutput.ResultData)), "Owner access updated")
            }
        }
    }
}
