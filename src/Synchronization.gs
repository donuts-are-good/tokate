package Tokate

import System
import System.Collections.Generic
import System.Text.Json
import System.Text.RegularExpressions

internal class Synchronization {
    shared {
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
                Data.CommitSha(J.Text(item, "grant"))
                Data.CommitSha(J.Text(item, "candidate"))
                Data.CommitSha(J.Text(item, "upstream"))
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
                J.Map("grant", grant, "candidate", J.Text(value, "candidate"), "upstream", J.Text(value, "upstream"))
            )
            return History(J.Parse(J.Write(J.Map("synchronizations", items))))
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
            Data.Repo(repo)
            Data.CommitSha(grant)
            let value = RequestData.Parse(GitHub.FileAt(repo, "synchronization.json", grant), 1024 * 1024)
            RequestData.Keys(
                value,
                "version,id,repo,repository_id,issue,pr,approval_version,approval,base,target,upstream,previous,candidate,expected,fork,branch,receipt"
            )
            var id Guid
            if J.Number(value, "version") != 1 || !Guid.TryParseExact(J.Text(value, "id"), "D", out id) || J.Text(
                value,
                "repo"
            ) != repo ||
                J.Number(value, "issue") < 1 || J.Number(value, "pr") < 1 ||
                (J.Number(value, "approval_version") != 1 && J.Number(value, "approval_version") != 2) ||
                J
                .Get(value, "receipt").ValueKind != JsonValueKind.Object {
                throw Exception("Invalid owner synchronization grant")
            }
            Numeric(J.Get(value, "repository_id"))
            if !Regex.IsMatch(
                J.Text(value, "approval"),
                J.Number(value, "approval_version") == 2 ? "^[0-9a-f]{64}$": "^[0-9a-f]{40}$"
            ) {
                throw Exception("Invalid original synchronization approval identity")
            }
            Data.CommitSha(J.Text(value, "base"))
            Data.CommitSha(J.Text(value, "upstream"))
            Data.CommitSha(J.Text(value, "previous"))
            Data.CommitSha(J.Text(value, "candidate"))
            Data.Repo(J.Text(value, "fork"))
            if J.Number(value, "approval_version") == 2 {
                Data.CommitSha(J.Text(value, "expected"))
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
            ready bool = true
        ) {
            let approved = J.Get(record, "approval")
            let prefix = List[Object]()
            var last JsonElement
            for item in J.Items(history) {
                let grant = J.Text(item, "grant")
                let value = Load(repo, grant)
                let receipt = J.Get(value, "receipt")
                if J.Number(value, "pr") != pr || J.Number(value, "issue") != J.Number(
                    J.Get(record, "issue"),
                    "number"
                ) ||
                    J.Number(value, "approval_version") != J.Number(approved, "version") || J.Text(
                    value,
                    "approval"
                ) != approval ||
                    J.Text(value, "base") != J.Text(approved, "base") || J.Text(value, "target") != J.Text(
                    approved,
                    "base_branch"
                ) ||
                    J.Text(value, "fork") != fork || J.Text(value, "branch") != branch || J.Text(
                    item,
                    "candidate"
                ) != J.Text(value, "candidate") || J.Text(item, "upstream") != J.Text(value, "upstream") || J.Text(
                    receipt,
                    "head"
                ) != J.Text(value, "previous") || J.Text(receipt, "approval") != approval || J.Number(
                    receipt,
                    "version"
                ) != J.Number(value, "approval_version") || J.Text(receipt, "repo") != repo || J.Number(
                    receipt,
                    "issue"
                ) != J.Number(value, "issue") || J.Text(receipt, "donor") != J.Text(approved, "donor") ||
                    RequestData.Canonical(History(receipt)) != RequestData.Canonical(J.Parse(J.Write(prefix))) {
                    throw Exception("Synchronization differs from original approval, PR or historical receipt")
                }
                if grant == sync &&
                    (
                    J.Text(value, "candidate") != head || J.Text(value, "previous") != previous || J.Text(
                        value,
                        "expected"
                    ) != expected
                ) {
                    throw Exception(
                        "Synchronization candidate, previous head or expected state differs from exact owner grant"
                    )
                }
                prefix.Add(item)
                last = value
            }
            if sync != "" &&
                (
                last.ValueKind == JsonValueKind.Undefined || J.Text(
                    J.Items(history)[history.GetArrayLength() - 1],
                    "grant"
                ) != sync
            ) {
                throw Exception("Missing exact synchronization grant in amendment history")
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
            var baseline = base
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
                ProtectedPaths.EqualTrees(
                    policy,
                    approval,
                    ProtectedPaths.RemoteTree(repo, baseline),
                    ProtectedPaths.LocalTree(checkout, previous)
                )
                ProtectedPaths.EqualTrees(
                    policy,
                    approval,
                    ProtectedPaths.RemoteTree(repo, upstream),
                    ProtectedPaths.LocalTree(checkout, candidate)
                )
                baseline = upstream
                predecessor = candidate
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", predecessor, head)
            ProtectedPaths.EqualTrees(
                policy,
                approval,
                ProtectedPaths.RemoteTree(repo, baseline),
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
            var baseline = base
            var predecessor = base
            for item in J.Items(history) {
                let value = Load(repo, J.Text(item, "grant"))
                let previous = J.Text(value, "previous")
                let upstream = J.Text(value, "upstream")
                let candidate = J.Text(value, "candidate")
                ProtectedPaths.Ancestor(repo, base, fork, previous)
                ProtectedPaths.Ancestor(repo, base, repo, upstream)
                ProtectedPaths.Ancestor(repo, predecessor, fork, previous)
                ProtectedPaths.Ancestor(repo, previous, fork, candidate)
                ProtectedPaths.Ancestor(repo, upstream, fork, candidate)
                ProtectedPaths.EqualTrees(
                    policy,
                    approval,
                    ProtectedPaths.RemoteTree(repo, baseline),
                    ProtectedPaths.RemoteTree(fork, previous)
                )
                ProtectedPaths.EqualTrees(
                    policy,
                    approval,
                    ProtectedPaths.RemoteTree(repo, upstream),
                    ProtectedPaths.RemoteTree(fork, candidate)
                )
                baseline = upstream
                predecessor = candidate
            }
            ProtectedPaths.Ancestor(repo, predecessor, fork, head)
            ProtectedPaths.EqualTrees(
                policy,
                approval,
                ProtectedPaths.RemoteTree(repo, baseline),
                ProtectedPaths.RemoteTree(fork, head)
            )
        }

        private func Open(pull JsonElement) {
            if J.Text(pull, "state") != "open" || J.Bool(pull, "merged") ||
                (
                J.Get(pull, "merged_at").ValueKind != JsonValueKind.Undefined && J.Get(pull, "merged_at")
                    .ValueKind != JsonValueKind.Null
            ) {
                throw Exception("Synchronization requires an already-published open, unmerged PR")
            }
        }

        private func Fresh(repo string, pr int32, value JsonElement, approval JsonElement) {
            Publication.Verify(repo, pr, false)
            let pull = GitHub.Api("repos/" + repo + "/pulls/" + pr.ToString())
            Open(pull)
            if J.Text(J.Get(pull, "head"), "sha") != J.Text(value, "previous") || RequestData.Canonical(
                Amendment.Receipt(J.Text(pull, "body"))
            ) != RequestData
                .Canonical(J.Get(value, "receipt")) {
                throw Exception("Published head or receipt changed during synchronization authorization")
            }
            let reference = GitHub.Api("repos/" + J.Text(value, "fork") + "/git/ref/heads/" + J.Text(value, "branch"))
            if J.Text(J.Get(reference, "object"), "sha") != J.Text(value, "previous") || J.Text(
                J.Get(pull, "head"),
                "ref"
            ) != J.Text(value, "branch") || J.Text(J.Get(J.Get(pull, "head"), "repo"), "full_name") != J.Text(
                value,
                "fork"
            ) {
                throw Exception("Canonical published donor branch changed during grant creation")
            }
            Target(repo, approval, J.Text(value, "target"), J.Text(value, "upstream"))
            if J.Number(value, "approval_version") == 2 && CoordinationState.Load(repo, J.Number(value, "issue"))
                .Sha != J.Text(value, "expected") {
                throw Exception("Synchronization expected coordination state changed")
            }
        }

        internal func Authorize(args Args) {
            let repo = Data.Repo(args.Need("repo"))
            let info = Workflow.RequireOwner(repo)
            Numeric(J.Get(info, "id"))
            let pr = args.Number("pr")
            let candidate = Data.CommitSha(args.Need("commit"))
            let upstream = Data.CommitSha(args.Need("upstream"))
            Publication.Verify(repo, pr, false)
            let pull = GitHub.Api("repos/" + repo + "/pulls/" + pr.ToString())
            Open(pull)
            let receipt = Amendment.Receipt(J.Text(pull, "body"))
            let issue = J.Number(receipt, "issue")
            var record JsonElement
            var expected = ""
            if J.Number(receipt, "version") == 2 {
                let state = CoordinationState.Load(repo, issue)
                record = state.Check(
                    repo,
                    issue,
                    J.Text(receipt, "donor"),
                    J.Get(J.Get(state.Value(), "contribution"), "actor")
                )
                state.Reservation(J.Get(J.Get(state.Value(), "contribution"), "actor"))
                expected = state.Sha
            } else {
                record = Workflow.Approved(repo, issue, J.Text(receipt, "donor"))
            }
            let approval = J.Get(record, "approval")
            let target = J.Text(approval, "base_branch")
            let previous = J.Text(J.Get(pull, "head"), "sha")
            let fork = Data.Repo(J.Text(J.Get(J.Get(pull, "head"), "repo"), "full_name"))
            Target(repo, approval, target, upstream)
            ProtectedPaths.Ancestor(repo, J.Text(approval, "base"), fork, previous)
            ProtectedPaths.Ancestor(repo, J.Text(approval, "base"), repo, upstream)
            let value = J.Parse(
                J.Write(
                    J.Map(
                        "version",
                        1,
                        "id",
                        Guid.NewGuid().ToString("D"),
                        "repo",
                        repo,
                        "repository_id",
                        J.Get(info, "id"),
                        "issue",
                        issue,
                        "pr",
                        pr,
                        "approval_version",
                        J.Number(receipt, "version"),
                        "approval",
                        J.Text(receipt, "approval"),
                        "base",
                        J.Text(approval, "base"),
                        "target",
                        target,
                        "upstream",
                        upstream,
                        "previous",
                        previous,
                        "candidate",
                        candidate,
                        "expected",
                        expected,
                        "fork",
                        fork,
                        "branch",
                        J.Text(J.Get(pull, "head"), "ref"),
                        "receipt",
                        receipt
                    )
                )
            )
            let tree = GitHub.Api(
                "repos/" + repo + "/git/trees",
                J.Map(
                    "tree",
                    []Object{
                        J.Map(
                            "path",
                            "synchronization.json",
                            "mode",
                            "100644",
                            "type",
                            "blob",
                            "content",
                            J.Write(value)
                        )
                    }
                )
            )
            let commit = GitHub.Api(
                "repos/" + repo + "/git/commits",
                GitHub.AutomationCommit(
                    "Authorize Tokate synchronization for PR #" + pr.ToString(),
                    J.Text(tree, "sha"),
                    []string{upstream}
                )
            )
            let grant = Data.CommitSha(J.Text(commit, "sha"))
            Fresh(repo, pr, value, approval)
            Workflow.RequireOwner(repo)
            GitHub.Api("repos/" + repo + "/git/refs", J.Map("ref", "refs/heads/" + Ref(value), "sha", grant))
            Load(repo, grant)
            Fresh(repo, pr, value, approval)
            PublicOutput.ResultData = J.Map("repo", repo, "pr", pr, "grant", grant)
            Terminal.Message(
                "Synchronization grant: " +
                    grant +
                    "\nOwner ref: " +
                    Ref(value) +
                    "\nThis names exact C and U only; candidate contents, verification, owner review and acceptance remain outstanding."
            )
        }

        internal func Revoke(args Args) {
            let repo = Data.Repo(args.Need("repo"))
            Workflow.RequireOwner(repo)
            let grant = Data.CommitSha(args.Need("grant"))
            let value = Load(repo, grant)
            let tree = GitHub.Api(
                "repos/" + repo + "/git/trees",
                J.Map(
                    "tree",
                    []Object{
                        J.Map(
                            "path",
                            "revocation.json",
                            "mode",
                            "100644",
                            "type",
                            "blob",
                            "content",
                            J.Write(J.Map("grant", grant, "revoked", true))
                        )
                    }
                )
            )
            let commit = GitHub.Api(
                "repos/" + repo + "/git/commits",
                GitHub.AutomationCommit("Revoke Tokate synchronization " + grant, J.Text(tree, "sha"), []string{grant})
            )
            let revoked = Data.CommitSha(J.Text(commit, "sha"))
            Load(repo, grant)
            Workflow.RequireOwner(repo)
            GitHub.Api(
                "repos/" + repo + "/git/refs/heads/" + Ref(value),
                J.Map("sha", revoked, "force", false),
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
            PublicOutput.ResultData = J.Map("repo", repo, "grant", grant)
            Terminal.Message("Synchronization revoked; original grant preserved: " + grant)
        }
    }
}
