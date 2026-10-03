package Tokate

import System
import System.Text.Json

// Owner authority stays on the default branch. Legacy approvals deliberately
// retain their original branch and freshness rules; no records are migrated.
internal class ApprovalBase {
    shared {
        internal func Select(args Args, fallback string) string {
            if args.Get("base-branch") != "" {
                return Data.Branch(args.Get("base-branch"))
            }
            if !Console.IsInputRedirected && !Console.IsOutputRedirected {
                Console.Write("Target branch [" + Terminal.Clean(fallback) + "]: ")
                let answer = Console.ReadLine() ?? throw Exception("Target branch selection cancelled")
                if answer != "" {
                    return Data.Branch(answer)
                }
            }
            return Data.Branch(fallback)
        }

        internal func Check(repo string, approval JsonElement, version int32) JsonElement {
            let branch = J.Text(GitHub.Api("repos/" + repo), "default_branch")
            let selected = J.Get(approval, "authority_branch").ValueKind != JsonValueKind.Undefined
            let authority = selected ? J.Text(approval, "authority_branch"): J.Text(approval, "base_branch")
            if branch != authority {
                throw Exception("Repository authority branch changed. The owner must approve again.")
            }
            let current = selected ? GitHub.Branch(repo, branch): J.Text(
                GitHub.Api("repos/" + repo + "/commits/" + Uri.EscapeDataString(branch)),
                "sha"
            )
            let policy = Policy.Load(repo, current)
            let template = GitHub.FileAt(repo, ".github/tokate-pr.md", current)
            if (version == 2 && J.Number(policy.Value, "version") != 2) || policy.Digest != J.Text(
                approval,
                "policy_hash"
            ) ||
                Data.Hash(template) != J.Text(approval, "template_hash") {
                throw Exception("Repository policy or template changed. The owner must approve again.")
            }
            var decree string? = nil
            if selected {
                let baseBranch = Data.Branch(J.Text(approval, "base_branch"))
                let approved = Data.CommitSha(J.Text(approval, "base"))
                let target = baseBranch == branch ? current: GitHub.Branch(repo, baseBranch)
                decree = GitHub.OptionalFileAt(repo, "DECREE.md", target)
                if Data.Hash(J.Write(decree)) != J.Text(approval, "decree_hash") {
                    throw Exception("Target DECREE.md changed. The owner must approve again.")
                }
                if target != approved {
                    decree = GitHub.OptionalFileAt(repo, "DECREE.md", approved)
                    if Data.Hash(J.Write(decree)) != J.Text(approval, "decree_hash") {
                        throw Exception("Approved DECREE.md differs from its pinned hash")
                    }
                    Terminal.Message(
                        "Target " + baseBranch + " is now " + target + "; approved base remains " + approved,
                        "cyan",
                        true
                    )
                }
            }
            return J.Parse(J.Write(J.Map("policy", policy.Value, "template", template, "decree", decree)))
        }
    }
}
