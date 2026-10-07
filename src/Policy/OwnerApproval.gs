package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class OwnerApproval {
    shared {
        internal func ApprovalRef(number int32) string -> "tokate/approvals/" + number.ToString()

        internal func Approve(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let number = args.Number("issue")
            let info = RepositoryAccess.RequireOwner(repo)
            var donor = ""
            let issue = GitHub.Issue(repo, number)
            if args.Command == "assign" && !GitHub.HasLabel(issue) {
                throw Exception("Approve the issue first")
            }
            var predecessor JsonElement
            if args.Get("continue-approval") != "" {
                let requested = args.Need("donor")
                donor = RepositoryIdentity.Login(requested == "@me" ? J.Text(GitHub.Api("user"), "login"): requested)
                predecessor = Approved(repo, number, donor)
                if J.Text(predecessor, "sha") != args.Need("continue-approval") {
                    throw CliFailure(
                        "stale_approval",
                        "Continuation requires the current valid, unrevoked predecessor approval"
                    )
                }
                V1Continuation.SupportedApproval(J.Get(predecessor, "approval"))
            }
            let continuing = predecessor.ValueKind != JsonValueKind.Undefined
            let authority = J.Text(info, "default_branch")
            let authorityBase = GitHub.Branch(repo, authority)
            let policy = Policy.Load(repo, authorityBase)
            let configuredTarget = J.Text(policy.Value, "target_branch")
            let branch = continuing ? J.Text(J.Get(predecessor, "approval"), "base_branch"): ApprovalBase.Select(
                args,
                configuredTarget == "" ? authority: configuredTarget
            )
            let revision = continuing ? J.Text(J.Get(predecessor, "approval"), "base"): (
                branch == authority ? authorityBase: GitHub.Branch(repo, branch)
            )
            if continuing && J.Number(policy.Value, "version") != 1 {
                throw Exception("Continuation is limited to unpublished same-donor version-1 managed work")
            }
            if policy.Eligibility != "" {
                if args.Get("donor") != "" || args.Command == "assign" {
                    throw Exception("Task-scoped approval cannot assign a donor")
                }
                AccessState.Load(repo, RepositoryIdentity.PositiveId(J.Get(info, "id")))
            } else {
                let donorArg = args.Need("donor")
                donor = RepositoryIdentity.Login(donorArg == "@me" ? J.Text(GitHub.Api("user"), "login"): donorArg)
            }
            let template = PrBody.Template(repo, authorityBase, policy)
            ValidateTemplate(template)
            let commit = GitHub.Api("repos/" + repo + "/git/commits/" + RepositoryIdentity.CommitSha(revision))
            let decree = Decree.CaptureTree(repo, RepositoryIdentity.CommitSha(J.Text(J.Get(commit, "tree"), "sha")))
            Terminal.Step(
                "Approving target " + branch + " at " + revision + "; policy/template authority: " + authority
            )
            let issuePath = "repos/" + repo + "/issues/" + number.ToString()
            if policy.Eligibility == "" && !continuing {
                var assigned = GitHub.Api(issuePath + "/assignees", map[string, Object?]{"assignees": []string{donor}})
                let others = List[string]()
                var found bool
                for person in J.Items(J.Get(assigned, "assignees")) {
                    let login = J.Text(person, "login")
                    if String.Equals(login, donor, StringComparison.OrdinalIgnoreCase) {
                        found = true
                    } else {
                        others.Add(login)
                    }
                }
                if !found {
                    throw Exception(
                        "GitHub could not assign this donor. Ask them to comment on the issue, then approve again. Existing assignees were kept."
                    )
                }
                if others.Count > 0 {
                    assigned = GitHub.Api(issuePath + "/assignees", map[string, Object?]{"assignees": others}, "DELETE")
                }
                if !GitHub.Assigned(assigned, donor) {
                    throw Exception("Issue assignment changed. Approve again with exactly one donor.")
                }
            }
            let label = GitHub.Api("repos/" + repo + "/labels/tokate%3Aapproved", missing: true)
            if label.ValueKind == JsonValueKind.Undefined {
                GitHub.Api(
                    "repos/" + repo + "/labels",
                    map[string, Object?]{
                        "name": "tokate:approved",
                        "color": "0e8a16",
                        "description": "Approved and assigned for donated AI usage"
                    }
                )
            }
            let approval = map[string, Object?]{
                "version": 1,
                "repo": repo,
                "issue": number,
                "donor": donor,
                "issue_hash": GitHub.Fingerprint(issue),
                "policy_hash": policy.Digest,
                "template_hash": Data.Hash(template),
                "base": revision,
                "base_branch": branch,
                "decree": decree,
                "authority_branch": authority,
                "nonce": Guid.NewGuid().ToString("N")
            }
            if continuing {
                let prior = J.Get(predecessor, "approval")
                for key in[]string{
                    "repo",
                    "donor",
                    "base",
                    "base_branch",
                    "issue_hash",
                    "policy_hash",
                    "template_hash",
                    "authority_branch",
                    "decree"
                } {
                    approval[key] = J.Get(prior, key)
                }
                approval["predecessor_approval"] = J.Text(predecessor, "sha")
                approval["donor_id"] = V1Continuation.BindIdentity(
                    prior,
                    "donor_id",
                    J.Get(GitHub.Api("users/" + donor), "id")
                )
                approval["repo_id"] = V1Continuation.BindIdentity(prior, "repo_id", J.Get(info, "id"))
                if J.Text(Approved(repo, number, donor), "sha") != J.Text(predecessor, "sha") {
                    throw CliFailure("stale_approval", "Predecessor changed during continuation approval")
                }
            }
            if J.Number(policy.Value, "version") == 2 {
                approval["version"] = 2
                if policy.Eligibility != "" {
                    approval.Remove("donor")
                    approval["approval_scope"] = "task"
                    approval["eligibility"] = policy.Eligibility
                    approval["repo_id"] = RepositoryIdentity.PositiveId(J.Get(info, "id"))
                }
                CoordinationState.Approve(repo, number, approval)
                GitHub.Api(issuePath + "/labels", map[string, Object?]{"labels": []string{"tokate:approved"}})
                Terminal.Message(
                    "Version-2 approval recorded. Read coordination state before requesting a reservation."
                )
                return
            }
            let old = GitHub.Api("repos/" + repo + "/git/ref/heads/" + ApprovalRef(number), missing: true)
            if continuing && J.Text(J.Get(old, "object"), "sha") != J.Text(predecessor, "sha") {
                throw CliFailure("stale_approval", "Predecessor changed before continuation grant creation")
            }
            let parents = List[string]{revision}
            if old.ValueKind != JsonValueKind.Undefined {
                parents.Add(J.Text(J.Get(old, "object"), "sha"))
            }
            let tree = GitHub.Api(
                "repos/" + repo + "/git/trees",
                map[string, Object?]{
                    "base_tree": J.Text(J.Get(commit, "tree"), "sha"),
                    "tree": []Object{
                        map[string, Object?]{
                            "path": ".github/tokate-approval.json",
                            "mode": "100644",
                            "type": "blob",
                            "content": J.Write(approval)
                        }
                    }
                }
            )
            let record = GitHub.Api(
                "repos/" + repo + "/git/commits",
                GitHub.AutomationCommit(
                    "Approve Tokate issue #" + number.ToString() + " for " + donor,
                    J.Text(tree, "sha"),
                    parents
                )
            )
            if continuing && J.Text(Approved(repo, number, donor), "sha") != J.Text(predecessor, "sha") {
                throw CliFailure(
                    "stale_approval",
                    "Predecessor was changed or revoked before continuation grant issuance"
                )
            }
            if old.ValueKind == JsonValueKind.Undefined {
                GitHub.Api(
                    "repos/" + repo + "/git/refs",
                    map[string, Object?]{"ref": "refs/heads/" + ApprovalRef(number), "sha": J.Text(record, "sha")}
                )
            } else {
                GitHub.Api(
                    "repos/" + repo + "/git/refs/heads/" + ApprovalRef(number),
                    map[string, Object?]{"sha": J.Text(record, "sha"), "force": false},
                    "PATCH"
                )
            }
            if !continuing {
                GitHub.Api(issuePath + "/labels", map[string, Object?]{"labels": []string{"tokate:approved"}})
            }
            Terminal.Message("Approved https://github.com/" + repo + "/issues/" + number.ToString() + " for @" + donor)
        }

        internal func ValidateTemplate(text string) {
            for key in[]string{
                "issue",
                "report",
                "donor",
                "model",
                "effort",
                "seconds",
                "base",
                "policy",
                "usage",
                "receipt"
            } {
                if !text.Contains("{{" + key + "}}") {
                    throw Exception("PR template must contain {{" + key + "}}")
                }
            }
        }

        internal func Revoke(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            RepositoryAccess.RequireOwner(repo)
            let state = CoordinationState.Load(repo, args.Number("issue"), true)
            if state.Sha != "" {
                let expected = state.Sha
                state.Fields["revoked"] = true
                state.Write(repo, args.Number("issue"), expected)
            }
            GitHub.Api(
                "repos/" + repo + "/issues/" + args.Number("issue").ToString() + "/labels/tokate%3Aapproved",
                method: "DELETE"
            )
            Terminal.Message(
                "Approval revoked. Active local computation may continue, but Tokate will refuse publication."
            )
        }

        internal func Approved(repo string, number int32, donor string) JsonElement {
            let issue = GitHub.Issue(repo, number)
            if !GitHub.HasLabel(issue) || !GitHub.Assigned(issue, donor) {
                throw CliFailure(
                    "stale_approval",
                    "Issue needs Tokate approval and exactly one assigned donor matching your account"
                )
            }
            let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/" + ApprovalRef(number))
            let sha = J.Text(J.Get(reference, "object"), "sha")
            let approval = J.Parse(GitHub.FileAt(repo, ".github/tokate-approval.json", sha))
            if J.Number(approval, "version") != 1 {
                throw Exception("Version-1 operations require a version-1 approval")
            }
            let failure = "Issue or assignment changed. The owner must approve again."
            if !RepositoryIdentity.SameRepo(J.Text(approval, "repo"), repo) || J.Number(approval, "issue") != number {
                throw CliFailure("stale_approval", failure)
            }
            if !String.Equals(J.Text(approval, "donor"), donor, StringComparison.OrdinalIgnoreCase) {
                throw CliFailure("stale_approval", failure)
            }
            if J.Text(approval, "issue_hash") != GitHub.Fingerprint(issue) {
                throw CliFailure("stale_approval", failure)
            }
            let configuration = ApprovalBase.Check(repo, approval, 1)
            return J.Parse(
                J.Write(
                    map[string, Object?]{
                        "approval": approval,
                        "sha": sha,
                        "issue": issue,
                        "policy": configuration.Item1.Value,
                        "template": configuration.Item2
                    }
                )
            )
        }
    }
}
