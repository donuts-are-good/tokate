package Tokate

import System
import System.Text.Json

internal class ApprovalBase {
    shared {
        internal func Select(args Args, fallback string) string {
            if args.Get("base-branch") != "" {
                return RepositoryIdentity.Branch(args.Get("base-branch"))
            }
            if !PublicOutput.Enabled && !Console.IsInputRedirected && !Console.IsOutputRedirected {
                Console.Write("Target branch [" + Terminal.Clean(fallback) + "]: ")
                let answer = Console.ReadLine() ?? throw Exception("Target branch selection cancelled")
                if answer != "" {
                    return RepositoryIdentity.Branch(answer)
                }
            }
            return RepositoryIdentity.Branch(fallback)
        }

        internal func Check(repo string, approval JsonElement, version int32) JsonElement {
            let branch = J.Text(GitHub.Api("repos/" + repo), "default_branch")
            let selected = J.Get(approval, "authority_branch").ValueKind != JsonValueKind.Undefined
            let authority = selected ? J.Text(approval, "authority_branch"): J.Text(approval, "base_branch")
            if branch != authority {
                throw CliFailure("stale_approval", "Repository authority branch changed. The owner must approve again.")
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
                throw CliFailure(
                    "stale_approval",
                    "Repository policy or template changed. The owner must approve again."
                )
            }
            var target = current
            if selected {
                let baseBranch = RepositoryIdentity.Branch(J.Text(approval, "base_branch"))
                let approved = RepositoryIdentity.CommitSha(J.Text(approval, "base"))
                target = baseBranch == branch ? current: GitHub.Branch(repo, baseBranch)
                if target != approved {
                    Terminal.Message(
                        "Target " + baseBranch + " is now " + target + "; approved base remains " + approved,
                        "cyan",
                        true
                    )
                }
            }
            Decree.CheckCurrent(repo, target, approval)
            return J.Parse(J.Write(J.Map("policy", policy.Value, "template", template)))
        }
    }
}
