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

        internal func Check(repo string, approval JsonElement, quiet bool = false) ValueTuple[Policy, string] {
            let branch = J.Text(GitHub.Api("repos/" + repo), "default_branch")
            let authority = RepositoryIdentity.Branch(J.Text(approval, "authority_branch"))
            if branch != authority {
                throw CliFailure("stale_approval", "Repository authority branch changed. The owner must approve again.")
            }
            let current = GitHub.Branch(repo, branch)
            let policy = Policy.Load(repo, current)
            let template = PrBody.Template(repo, current, policy)
            if policy.Digest != J.Text(approval, "policy_hash") || Data.Hash(template) != J.Text(
                approval,
                "template_hash"
            ) {
                throw CliFailure(
                    "stale_approval",
                    "Repository policy or template changed. The owner must approve again."
                )
            }
            let baseBranch = RepositoryIdentity.Branch(J.Text(approval, "base_branch"))
            let approved = RepositoryIdentity.CommitSha(J.Text(approval, "base"))
            let target = baseBranch == branch ? current: GitHub.Branch(repo, baseBranch)
            if target != approved && !quiet {
                Terminal.Message(
                    "Target " + baseBranch + " is now " + target + "; approved base remains " + approved,
                    "cyan",
                    true
                )
            }
            Decree.CheckCurrent(repo, target, approval)
            return ValueTuple[Policy, string](policy, template)
        }
    }
}
