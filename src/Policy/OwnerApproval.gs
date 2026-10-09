package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class OwnerApproval {
    shared {
        internal func Approve(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let number = args.Number("issue")
            let info = RepositoryAccess.RequireOwner(repo)
            let issue = GitHub.Issue(repo, number)
            let authority = J.Text(info, "default_branch")
            let authorityBase = GitHub.Branch(repo, authority)
            let policy = Policy.Load(repo, authorityBase)
            let configuredTarget = J.Text(policy.Value, "target_branch")
            let branch = ApprovalBase.Select(args, configuredTarget == "" ? authority: configuredTarget)
            let revision = branch == authority ? authorityBase: GitHub.Branch(repo, branch)
            AccessState.Load(repo, RepositoryIdentity.PositiveId(J.Get(info, "id")))
            let template = PrBody.Template(repo, authorityBase, policy)
            PrBody.ValidateTemplate(template)
            let commit = GitHub.Api("repos/" + repo + "/git/commits/" + RepositoryIdentity.CommitSha(revision))
            let decree = Decree.CaptureTree(repo, RepositoryIdentity.CommitSha(J.Text(J.Get(commit, "tree"), "sha")))
            Terminal.Step(
                "Approving target " + branch + " at " + revision + "; policy/template authority: " + authority
            )
            let label = GitHub.Api("repos/" + repo + "/labels/tokate%3Aapproved", missing: true)
            if label.ValueKind == JsonValueKind.Undefined {
                GitHub.Api(
                    "repos/" + repo + "/labels",
                    map[string, Object?]{
                        "name": "tokate:approved",
                        "color": "0e8a16",
                        "description": "Approved for donated AI usage"
                    }
                )
            }
            CoordinationState.Approve(
                repo,
                number,
                map[string, Object?]{
                    "version": 2,
                    "repo": repo,
                    "repo_id": RepositoryIdentity.PositiveId(J.Get(info, "id")),
                    "issue": number,
                    "approval_scope": "task",
                    "eligibility": policy.Eligibility,
                    "issue_hash": GitHub.Fingerprint(issue),
                    "policy_hash": policy.Digest,
                    "template_hash": Data.Hash(template),
                    "base": revision,
                    "base_branch": branch,
                    "decree": decree,
                    "authority_branch": authority,
                    "nonce": Guid.NewGuid().ToString("N")
                }
            )
            GitHub.Api(
                "repos/" + repo + "/issues/" + number.ToString() + "/labels",
                map[string, Object?]{"labels": []string{"tokate:approved"}}
            )
            Terminal.Message("Approval recorded. Request a contribution reservation to begin work.")
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
    }
}
