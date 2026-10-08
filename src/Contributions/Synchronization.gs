package Tokate

import System
import System.Collections.Generic
import System.Text.Json
import System.Text.RegularExpressions

internal class Synchronization {
    shared {
        internal func Ancestor(repo string, base string, fork string, head string) {
            RepositoryIdentity.Repo(repo)
            RepositoryIdentity.Repo(fork)
            RepositoryIdentity.CommitSha(base)
            RepositoryIdentity.CommitSha(head)
            let value = GitHub.Api("repos/" + repo + "/compare/" + base + "..." + fork.Split('/')[0] + ":" + head)
            let commits = J.Items(J.Get(value, "commits"))
            let failure = "Missing or mismatched synchronization ancestry evidence"
            let baseCommit = J.Text(J.Get(value, "base_commit"), "sha")
            let mergeBase = J.Text(J.Get(value, "merge_base_commit"), "sha")
            if baseCommit != base || mergeBase != base || J.Get(value, "behind_by")
                .ValueKind != JsonValueKind.Number ||
                J.Number(value, "behind_by") != 0 {
                throw Exception(failure)
            }
            let status = J.Text(value, "status")
            if base == head {
                if status != "identical" {
                    throw Exception(failure)
                }
            } else if status != "ahead" || commits.Count == 0 || J.Text(commits[commits.Count - 1], "sha") != head {
                throw Exception(failure)
            }
        }

        internal func History(value JsonElement) JsonElement {
            let history = J.Get(value, "synchronizations")
            if history.ValueKind == JsonValueKind.Undefined {
                return J.Parse("[]")
            }
            if history.ValueKind != JsonValueKind.Array || history.GetArrayLength() > 64 {
                throw Exception("Invalid or excessive synchronization history")
            }
            for item in J.Items(history) {
                RequestData.Keys(item, "grant,candidate,upstream")
                RepositoryIdentity.CommitSha(J.Text(item, "grant"))
                RepositoryIdentity.CommitSha(J.Text(item, "candidate"))
                RepositoryIdentity.CommitSha(J.Text(item, "upstream"))
            }
            return history
        }

        internal func Keep(fields Dictionary[string, Object?], history JsonElement) {
            if history.GetArrayLength() > 0 {
                fields["synchronizations"] = history
            }
        }

        internal func Append(repo string, history JsonElement, grant string) JsonElement {
            if grant == "" {
                return history
            }
            let value = Load(repo, grant)
            let items = List[Object]()
            for item in J.Items(history) {
                if J.Text(item, "grant") == grant {
                    throw Exception("Synchronization grant already appears in history")
                }
                items.Add(item)
            }
            items.Add(
                map[string, Object?]{
                    "grant": grant,
                    "candidate": J.Text(value, "candidate"),
                    "upstream": J.Text(value, "upstream")
                }
            )
            return History(J.Parse(J.Write(map[string, Object?]{"synchronizations": items})))
        }

        private func Ref(value JsonElement) string -> "tokate/synchronizations/" + J.Number(value, "issue").ToString() +
            "/" +
            J.Text(value, "id")

        private func Numeric(value JsonElement) {
            var id int64
            if !value.TryGetInt64(out id) || id < 1 {
                throw Exception("Synchronization requires a numeric repository identity")
            }
        }

        internal func Load(repo string, grant string) JsonElement {
            RepositoryIdentity.Repo(repo)
            RepositoryIdentity.CommitSha(grant)
            let value = RequestData.Parse(GitHub.FileAt(repo, "synchronization.json", grant), 1024 * 1024)
            RequestData.Keys(
                value,
                "version,id,repo,repository_id,issue,pr,approval_version,approval,base,target,upstream,previous,candidate,expected,fork,branch,receipt"
            )
            var id Guid
            let approvalVersion = J.Number(value, "approval_version")
            let failure = "Invalid owner synchronization grant"
            if J.Number(value, "version") != 1 || !Guid.TryParseExact(J.Text(value, "id"), "D", out id) {
                throw Exception(failure)
            }
            if !RepositoryIdentity.SameRepo(J.Text(value, "repo"), repo) {
                throw Exception(failure)
            }
            if J.Number(value, "issue") < 1 || J.Number(value, "pr") < 1 {
                throw Exception(failure)
            }
            if (approvalVersion != 1 && approvalVersion != 2) || J.Get(value, "receipt")
                .ValueKind != JsonValueKind.Object {
                throw Exception(failure)
            }
            Numeric(J.Get(value, "repository_id"))
            if !Regex.IsMatch(
                J.Text(value, "approval"),
                J.Number(value, "approval_version") == 2 ? "^[0-9a-f]{64}$": "^[0-9a-f]{40}$"
            ) {
                throw Exception("Invalid original synchronization approval identity")
            }
            RepositoryIdentity.CommitSha(J.Text(value, "base"))
            RepositoryIdentity.CommitSha(J.Text(value, "upstream"))
            RepositoryIdentity.CommitSha(J.Text(value, "previous"))
            RepositoryIdentity.CommitSha(J.Text(value, "candidate"))
            RepositoryIdentity.Repo(J.Text(value, "fork"))
            if J.Number(value, "approval_version") == 2 {
                RepositoryIdentity.CommitSha(J.Text(value, "expected"))
            } else if J.Text(value, "expected") != "" {
                throw Exception("Version-1 grant cannot claim coordination authority")
            }
            let info = GitHub.Api("repos/" + repo)
            Numeric(J.Get(info, "id"))
            let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/" + Ref(value))
            let object = J.Get(reference, "object")
            if J.Get(info, "id").ToString() != J.Get(value, "repository_id").ToString() || J.Text(
                object,
                "sha"
            ) != grant ||
                J.Text(object, "type") != "commit" {
                throw Exception("Synchronization revoked, deleted, moved or bound to another repository")
            }
            let commit = GitHub.Api("repos/" + repo + "/git/commits/" + grant)
            let parents = J.Items(J.Get(commit, "parents"))
            if J.Text(commit, "sha") != grant || parents.Count != 1 || J.Text(parents[0], "sha") != J.Text(
                value,
                "upstream"
            ) {
                throw Exception("Invalid synchronization grant commit ancestry")
            }
            return value
        }

        private func Target(repo string, approval JsonElement, target string, upstream string) {
            ApprovalBase.Check(repo, approval, J.Number(approval, "version"))
            if target != J.Text(approval, "base_branch") || GitHub.Branch(repo, target) != upstream {
                throw Exception("Synchronization target moved; a new exact owner grant is required")
            }
            Decree.CheckCurrent(repo, upstream, approval)
        }

        internal func Live(
            repo string,
            pr int32,
            record JsonElement,
            approval string,
            history JsonElement,
            fork string,
            branch string,
            head string,
            sync string = "",
            expected string = "",
            previous string = "",
            ready bool = true,
            contribution JsonElement = default(JsonElement)
        ) {
            let approved = J.Get(record, "approval")
            let issue = J.Number(J.Get(record, "issue"), "number")
            let approvalVersion = J.Number(approved, "version")
            let approvedBase = J.Text(approved, "base")
            let target = J.Text(approved, "base_branch")
            var donor = J.Text(approved, "donor")
            if AccessState.Task(approved) {
                RepositoryIdentity.PositiveId(J.Get(contribution, "actor"))
                donor = RepositoryIdentity.Login(J.Text(contribution, "donor"))
            }
            let failure = "Synchronization differs from original approval, PR or historical receipt"
            let prefix = List[Object]()
            var last JsonElement
            let historyItems = J.Items(history)
            for item in historyItems {
                let grant = J.Text(item, "grant")
                let value = Load(repo, grant)
                let receipt = J.Get(value, "receipt")
                if J.Number(value, "pr") != pr || J.Number(value, "issue") != issue {
                    throw Exception(failure)
                }
                if J.Number(value, "approval_version") != approvalVersion || J.Text(value, "approval") != approval {
                    throw Exception(failure)
                }
                if J.Text(value, "base") != approvedBase || J.Text(value, "target") != target {
                    throw Exception(failure)
                }
                if !RepositoryIdentity.SameRepo(J.Text(value, "fork"), fork) || J.Text(value, "branch") != branch {
                    throw Exception(failure)
                }
                let candidate = J.Text(value, "candidate")
                let upstream = J.Text(value, "upstream")
                if J.Text(item, "candidate") != candidate || J.Text(item, "upstream") != upstream {
                    throw Exception(failure)
                }
                if J.Text(receipt, "head") != J.Text(value, "previous") || J.Text(receipt, "approval") != approval {
                    throw Exception(failure)
                }
                if J.Number(receipt, "version") != approvalVersion {
                    throw Exception(failure)
                }
                if !RepositoryIdentity.SameRepo(J.Text(receipt, "repo"), repo) {
                    throw Exception(failure)
                }
                if J.Number(receipt, "issue") != issue || J.Text(receipt, "donor") != donor {
                    throw Exception(failure)
                }
                if RequestData.Canonical(History(receipt)) != RequestData.Canonical(J.Parse(J.Write(prefix))) {
                    throw Exception(failure)
                }
                if grant == sync {
                    let predecessor = J.Text(value, "previous")
                    let revision = J.Text(value, "expected")
                    if candidate != head || predecessor != previous || revision != expected {
                        throw Exception(
                            "Synchronization candidate, previous head or expected state differs from exact owner grant"
                        )
                    }
                }
                prefix.Add(item)
                last = value
            }
            if sync != "" {
                if last.ValueKind == JsonValueKind.Undefined || J.Text(
                    historyItems[historyItems.Count - 1],
                    "grant"
                ) != sync {
                    throw Exception("Missing exact synchronization grant in amendment history")
                }
            }
            if ready && last.ValueKind != JsonValueKind.Undefined {
                Target(repo, approved, J.Text(last, "target"), J.Text(last, "upstream"))
            }
        }

        internal func Local(
            checkout string,
            repo string,
            policy JsonElement,
            approval JsonElement,
            base string,
            history JsonElement,
            head string
        ) {
            var baselineTree Dictionary[string, string]? = nil
            var predecessor = base
            for item in J.Items(history) {
                let value = Load(repo, J.Text(item, "grant"))
                let previous = J.Text(value, "previous")
                let upstream = J.Text(value, "upstream")
                let candidate = J.Text(value, "candidate")
                Commands.Git(checkout, "merge-base", "--is-ancestor", base, previous)
                Commands.Git(checkout, "merge-base", "--is-ancestor", base, upstream)
                Commands.Git(checkout, "merge-base", "--is-ancestor", predecessor, previous)
                Commands.Git(checkout, "merge-base", "--is-ancestor", previous, candidate)
                Commands.Git(checkout, "merge-base", "--is-ancestor", upstream, candidate)
                if baselineTree == nil {
                    baselineTree = GitHubPathEvidence.Tree(repo, base)
                }
                ProtectedPaths.EqualTrees(policy, approval, baselineTree, ProtectedPaths.LocalTree(checkout, previous))
                let upstreamTree = GitHubPathEvidence.Tree(repo, upstream)
                ProtectedPaths.EqualTrees(policy, approval, upstreamTree, ProtectedPaths.LocalTree(checkout, candidate))
                baselineTree = upstreamTree
                predecessor = candidate
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", predecessor, head)
            if baselineTree != nil && head == predecessor {
                return
            }
            ProtectedPaths.EqualTrees(
                policy,
                approval,
                baselineTree ?? GitHubPathEvidence.Tree(repo, base),
                ProtectedPaths.LocalTree(checkout, head)
            )
        }

        internal func Remote(
            repo string,
            policy JsonElement,
            approval JsonElement,
            base string,
            history JsonElement,
            fork string,
            head string
        ) {
            var baselineTree Dictionary[string, string]? = nil
            var predecessor = base
            for item in J.Items(history) {
                let value = Load(repo, J.Text(item, "grant"))
                let previous = J.Text(value, "previous")
                let upstream = J.Text(value, "upstream")
                let candidate = J.Text(value, "candidate")
                Ancestor(repo, base, fork, previous)
                Ancestor(repo, base, repo, upstream)
                Ancestor(repo, predecessor, fork, previous)
                Ancestor(repo, previous, fork, candidate)
                Ancestor(repo, upstream, fork, candidate)
                if baselineTree == nil {
                    baselineTree = GitHubPathEvidence.Tree(repo, base)
                }
                ProtectedPaths.EqualTrees(policy, approval, baselineTree, GitHubPathEvidence.Tree(fork, previous))
                let upstreamTree = GitHubPathEvidence.Tree(repo, upstream)
                ProtectedPaths.EqualTrees(policy, approval, upstreamTree, GitHubPathEvidence.Tree(fork, candidate))
                baselineTree = upstreamTree
                predecessor = candidate
            }
            Ancestor(repo, predecessor, fork, head)
            if baselineTree != nil && head == predecessor {
                return
            }
            ProtectedPaths.EqualTrees(
                policy,
                approval,
                baselineTree ?? GitHubPathEvidence.Tree(repo, base),
                GitHubPathEvidence.Tree(fork, head)
            )
        }

        private func Open(pull JsonElement) {
            let mergedAt = J.Get(pull, "merged_at").ValueKind
            if J.Text(pull, "state") != "open" || J.Bool(pull, "merged") ||
                (mergedAt != JsonValueKind.Undefined && mergedAt != JsonValueKind.Null) {
                throw Exception("Synchronization requires an already-published open, unmerged PR")
            }
        }

        private func Fresh(repo string, pr int32, value JsonElement, approval JsonElement) {
            ReceiptVerification.Verify(repo, pr, false)
            let pull = GitHub.Api("repos/" + repo + "/pulls/" + pr.ToString())
            Open(pull)
            let head = J.Get(pull, "head")
            if J.Text(head, "sha") != J.Text(value, "previous") || RequestData.Canonical(
                PrBody.Receipt(J.Text(pull, "body"))
            ) !=
            RequestData.Canonical(J.Get(value, "receipt")) {
                throw Exception("Published head or receipt changed during synchronization authorization")
            }
            let reference = GitHub.Api("repos/" + J.Text(value, "fork") + "/git/ref/heads/" + J.Text(value, "branch"))
            let branchFailure = "Canonical published donor branch changed during grant creation"
            let remoteHead = J.Text(J.Get(reference, "object"), "sha")
            if remoteHead != J.Text(value, "previous") || J.Text(head, "ref") != J.Text(value, "branch") {
                throw Exception(branchFailure)
            }
            let headRepo = J.Text(J.Get(head, "repo"), "full_name")
            if !RepositoryIdentity.SameRepo(headRepo, J.Text(value, "fork")) {
                throw Exception(branchFailure)
            }
            Target(repo, approval, J.Text(value, "target"), J.Text(value, "upstream"))
            if J.Number(value, "approval_version") == 2 && CoordinationState.Load(repo, J.Number(value, "issue"))
                .Sha != J.Text(value, "expected") {
                throw Exception("Synchronization expected coordination state changed")
            }
        }

        internal func Authorize(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let info = RepositoryAccess.RequireOwner(repo)
            Numeric(J.Get(info, "id"))
            let pr = args.Number("pr")
            let candidate = RepositoryIdentity.CommitSha(args.Need("commit"))
            let upstream = RepositoryIdentity.CommitSha(args.Need("upstream"))
            ReceiptVerification.Verify(repo, pr, false)
            let pull = GitHub.Api("repos/" + repo + "/pulls/" + pr.ToString())
            Open(pull)
            let receipt = PrBody.Receipt(J.Text(pull, "body"))
            let issue = J.Number(receipt, "issue")
            var record JsonElement
            var expected = ""
            if J.Number(receipt, "version") == 2 {
                let state = CoordinationState.Load(repo, issue)
                let value = state.Value()
                let actor = J.Get(J.Get(value, "contribution"), "actor")
                record = state.Check(repo, issue, J.Text(receipt, "donor"), actor)
                state.Reservation(actor)
                expected = state.Sha
            } else {
                record = OwnerApproval.Approved(repo, issue, J.Text(receipt, "donor"))
            }
            let approval = J.Get(record, "approval")
            let target = J.Text(approval, "base_branch")
            let previous = J.Text(J.Get(pull, "head"), "sha")
            let fork = RepositoryIdentity.Repo(J.Text(J.Get(J.Get(pull, "head"), "repo"), "full_name"))
            Target(repo, approval, target, upstream)
            Ancestor(repo, J.Text(approval, "base"), fork, previous)
            Ancestor(repo, J.Text(approval, "base"), repo, upstream)
            let value = J.Parse(
                J.Write(
                    map[string, Object?]{
                        "version": 1,
                        "id": Guid.NewGuid().ToString("D"),
                        "repo": repo,
                        "repository_id": J.Get(info, "id"),
                        "issue": issue,
                        "pr": pr,
                        "approval_version": J.Number(receipt, "version"),
                        "approval": J.Text(receipt, "approval"),
                        "base": J.Text(approval, "base"),
                        "target": target,
                        "upstream": upstream,
                        "previous": previous,
                        "candidate": candidate,
                        "expected": expected,
                        "fork": fork,
                        "branch": J.Text(J.Get(pull, "head"), "ref"),
                        "receipt": receipt
                    }
                )
            )
            let tree = GitHub.Api(
                "repos/" + repo + "/git/trees",
                map[string, Object?]{
                    "tree": []Object{
                        map[string, Object?]{
                            "path": "synchronization.json",
                            "mode": "100644",
                            "type": "blob",
                            "content": J.Write(value)
                        }
                    }
                }
            )
            let commit = GitHub.Api(
                "repos/" + repo + "/git/commits",
                GitHub.AutomationCommit(
                    "Authorize Tokate synchronization for PR #" + pr.ToString(),
                    J.Text(tree, "sha"),
                    []string{upstream}
                )
            )
            let grant = RepositoryIdentity.CommitSha(J.Text(commit, "sha"))
            Fresh(repo, pr, value, approval)
            RepositoryAccess.RequireOwner(repo)
            GitHub.Api(
                "repos/" + repo + "/git/refs",
                map[string, Object?]{"ref": "refs/heads/" + Ref(value), "sha": grant}
            )
            Load(repo, grant)
            Fresh(repo, pr, value, approval)
            PublicOutput.ResultData = map[string, Object?]{"repo": repo, "pr": pr, "grant": grant}
            Terminal.Message(
                "Synchronization grant: " +
                    grant +
                    "\nOwner ref: " +
                    Ref(value) +
                    "\nThis names exact C and U only; candidate contents, verification, owner review and acceptance remain outstanding."
            )
        }

        internal func Revoke(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            RepositoryAccess.RequireOwner(repo)
            let grant = RepositoryIdentity.CommitSha(args.Need("grant"))
            let value = Load(repo, grant)
            let tree = GitHub.Api(
                "repos/" + repo + "/git/trees",
                map[string, Object?]{
                    "tree": []Object{
                        map[string, Object?]{
                            "path": "revocation.json",
                            "mode": "100644",
                            "type": "blob",
                            "content": J.Write(map[string, Object?]{"grant": grant, "revoked": true})
                        }
                    }
                }
            )
            let commit = GitHub.Api(
                "repos/" + repo + "/git/commits",
                GitHub.AutomationCommit("Revoke Tokate synchronization " + grant, J.Text(tree, "sha"), []string{grant})
            )
            let revoked = RepositoryIdentity.CommitSha(J.Text(commit, "sha"))
            Load(repo, grant)
            RepositoryAccess.RequireOwner(repo)
            GitHub.Api(
                "repos/" + repo + "/git/refs/heads/" + Ref(value),
                map[string, Object?]{"sha": revoked, "force": false},
                "PATCH"
            )
            let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/" + Ref(value))
            let result = GitHub.Api("repos/" + repo + "/git/commits/" + revoked)
            let parents = J.Items(J.Get(result, "parents"))
            if J.Text(J.Get(reference, "object"), "sha") != revoked || parents.Count != 1 || J.Text(
                parents[0],
                "sha"
            ) != grant {
                throw Exception("Revocation ref changed; inspect physical authority without retrying")
            }
            PublicOutput.ResultData = map[string, Object?]{"repo": repo, "grant": grant}
            Terminal.Message("Synchronization revoked; original grant preserved: " + grant)
        }
    }
}
