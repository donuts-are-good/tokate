package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class Workflow {
    shared {
        internal func Init(args Args) {
            let root = Path.GetFullPath(args.Get("path", "."))
            let directory = Path.Combine(root, ".github")
            Directory.CreateDirectory(directory)
            let policy = Path.Combine(directory, "tokate.json")
            let template = Path.Combine(directory, "tokate-pr.md")
            if File.Exists(policy) || File.Exists(template) {
                throw Exception("Tokate files already exist. Edit them directly.")
            }
            File.WriteAllText(policy, Data.Resource("tokate.json"))
            File.WriteAllText(template, Data.Resource("tokate-pr.md"))
            Terminal.Message(
                "Created .github/tokate.json and .github/tokate-pr.md. Set allowed model/effort pairs and required checks, then commit to the default branch."
            )
        }

        internal func RequireOwner(repo string) JsonElement {
            let info = GitHub.Api("repos/" + repo)
            if !J.Bool(J.Get(info, "permissions"), "push") {
                throw Exception("Repository write permission is required")
            }
            return info
        }

        internal func ApprovalRef(number int32) string -> "tokate/approvals/" + number.ToString()

        internal func Approve(args Args) {
            let repo = Data.Repo(args.Need("repo"))
            let number = args.Number("issue")
            let info = RequireOwner(repo)
            let donorArg = args.Need("donor")
            let donor = Data.Login(donorArg == "@me" ? J.Text(GitHub.Api("user"), "login"): donorArg)
            let issue = GitHub.Issue(repo, number)
            if args.Command == "assign" && !GitHub.HasLabel(issue) {
                throw Exception("Approve the issue first")
            }
            let branch = J.Text(info, "default_branch")
            let revision = J.Text(GitHub.Api("repos/" + repo + "/commits/" + Uri.EscapeDataString(branch)), "sha")
            let policy = Policy.Load(repo, revision)
            let template = GitHub.FileAt(repo, ".github/tokate-pr.md", revision)
            ValidateTemplate(template)
            let issuePath = "repos/" + repo + "/issues/" + number.ToString()
            var assigned = GitHub.Api(issuePath + "/assignees", J.Map("assignees", []string{donor}))
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
                assigned = GitHub.Api(issuePath + "/assignees", J.Map("assignees", others), "DELETE")
            }
            if !GitHub.Assigned(assigned, donor) {
                throw Exception("Issue assignment changed. Approve again with exactly one donor.")
            }
            let label = GitHub.Api("repos/" + repo + "/labels/tokate%3Aapproved", missing: true)
            if label.ValueKind == JsonValueKind.Undefined {
                GitHub.Api(
                    "repos/" + repo + "/labels",
                    J.Map(
                        "name",
                        "tokate:approved",
                        "color",
                        "0e8a16",
                        "description",
                        "Approved and assigned for donated AI usage"
                    )
                )
            }
            let approval = J.Map(
                "version",
                1,
                "repo",
                repo,
                "issue",
                number,
                "donor",
                donor,
                "issue_hash",
                GitHub.Fingerprint(issue),
                "policy_hash",
                policy.Digest,
                "template_hash",
                Data.Hash(template),
                "base",
                revision,
                "base_branch",
                branch,
                "nonce",
                Guid.NewGuid().ToString("N")
            )
            let old = GitHub.Api("repos/" + repo + "/git/ref/heads/" + ApprovalRef(number), missing: true)
            let parents = List[string]{revision}
            if old.ValueKind != JsonValueKind.Undefined {
                parents.Add(J.Text(J.Get(old, "object"), "sha"))
            }
            let commit = GitHub.Api("repos/" + repo + "/git/commits/" + revision)
            let tree = GitHub.Api(
                "repos/" + repo + "/git/trees",
                J.Map(
                    "base_tree",
                    J.Text(J.Get(commit, "tree"), "sha"),
                    "tree",
                    []Object{
                        J.Map(
                            "path",
                            ".github/tokate-approval.json",
                            "mode",
                            "100644",
                            "type",
                            "blob",
                            "content",
                            J.Write(approval)
                        )
                    }
                )
            )
            let record = GitHub.Api(
                "repos/" + repo + "/git/commits",
                J.Map(
                    "message",
                    "Approve Tokate issue #" + number.ToString() + " for " + donor,
                    "tree",
                    J.Text(tree, "sha"),
                    "parents",
                    parents
                )
            )
            if old.ValueKind == JsonValueKind.Undefined {
                GitHub.Api(
                    "repos/" + repo + "/git/refs",
                    J.Map("ref", "refs/heads/" + ApprovalRef(number), "sha", J.Text(record, "sha"))
                )
            } else {
                GitHub.Api(
                    "repos/" + repo + "/git/refs/heads/" + ApprovalRef(number),
                    J.Map("sha", J.Text(record, "sha"), "force", false),
                    "PATCH"
                )
            }
            GitHub.Api(issuePath + "/labels", J.Map("labels", []string{"tokate:approved"}))
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
            let repo = Data.Repo(args.Need("repo"))
            RequireOwner(repo)
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
                throw Exception("Issue needs Tokate approval and exactly one assigned donor matching your account")
            }
            let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/" + ApprovalRef(number))
            let sha = J.Text(J.Get(reference, "object"), "sha")
            let approval = J.Parse(GitHub.FileAt(repo, ".github/tokate-approval.json", sha))
            if J.Text(approval, "repo") != repo || J.Number(approval, "issue") != number || !String.Equals(
                J.Text(approval, "donor"),
                donor,
                StringComparison.OrdinalIgnoreCase
            ) ||
                J.Text(approval, "issue_hash") != GitHub.Fingerprint(issue) {
                throw Exception("Issue or assignment changed. The owner must approve again.")
            }
            let info = GitHub.Api("repos/" + repo)
            let currentBranch = J.Text(info, "default_branch")
            let current = J.Text(GitHub.Api("repos/" + repo + "/commits/" + Uri.EscapeDataString(currentBranch)), "sha")
            let policy = Policy.Load(repo, current)
            let template = GitHub.FileAt(repo, ".github/tokate-pr.md", current)
            if currentBranch != J.Text(approval, "base_branch") || policy.Digest != J.Text(approval, "policy_hash") ||
                Data.Hash(template) != J.Text(approval, "template_hash") {
                throw Exception("Repository policy or template changed. The owner must approve again.")
            }
            return J.Parse(
                J.Write(
                    J.Map(
                        "approval",
                        approval,
                        "sha",
                        sha,
                        "issue",
                        issue,
                        "policy",
                        policy.Value,
                        "template",
                        template
                    )
                )
            )
        }

        internal func Claim(args Args) string {
            let repo = Data.Repo(args.Need("repo"))
            let number = args.Number("issue")
            let viewer = GitHub.Api("user")
            let donor = Data.Login(J.Text(viewer, "login"))
            let record = Approved(repo, number, donor)
            let approval = J.Get(record, "approval")
            let model = args.Need("model")
            let effort = args.Need("effort")
            let seconds = args.Number(
                "seconds",
                Math.Min(3600, J.Number(J.Get(record, "policy"), "max_seconds")).ToString()
            )
            let network = args.Get("allow-network") == "true"
            Policy(J.Write(J.Get(record, "policy"))).Validate(model, effort, seconds, network)
            let head = Data.Repo(args.Get("fork", donor + "/" + repo.Split('/')[1]))
            if !String.Equals(head.Split('/')[0], donor, StringComparison.OrdinalIgnoreCase) {
                throw Exception("Use a fork owned by your signed-in account")
            }
            let headInfo = GitHub.Api("repos/" + head, missing: true)
            if !J.Bool(J.Get(headInfo, "permissions"), "push") ||
                (
                head != repo && !String.Equals(
                    J.Text(J.Get(headInfo, "parent"), "full_name"),
                    repo,
                    StringComparison.OrdinalIgnoreCase
                )
            ) {
                throw Exception(
                    "Create a writable fork of the upstream repository first: gh repo fork " + repo + " --clone=false"
                )
            }
            let run = Data()
            run.Fields["version"] = 1
            run.Fields["id"] = Guid.NewGuid().ToString("N")
            run.Fields["repo"] = repo
            run.Fields["issue"] = number
            run.Fields["donor"] = donor
            run.Fields["donor_id"] = J.Get(viewer, "id")
            run.Fields["head_repo"] = head
            run.Fields["approval"] = J.Text(record, "sha")
            run.Fields["base"] = J.Text(approval, "base")
            run.Fields["base_branch"] = J.Text(approval, "base_branch")
            run.Fields["policy_hash"] = J.Text(approval, "policy_hash")
            run.Fields["model"] = model
            run.Fields["effort"] = effort
            run.Fields["seconds"] = seconds
            run.Fields["network"] = network
            run.Fields["branch"] = "tokate/issue-" + number.ToString() + "-" + J.Text(record, "sha").Substring(0, 12)
            run.Fields["state"] = "preparing"
            let root = Path.GetFullPath(
                args.Get(
                    "runs",
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        ".local",
                        "state",
                        "tokate",
                        "runs"
                    )
                )
            )
            let directory = Path.Combine(root, run.Text("id"))
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            run.Save(directory)
            GitHub.Api(
                "repos/" + head + "/git/refs",
                J.Map("ref", "refs/heads/" + run.Text("branch"), "sha", run.Text("base"))
            )
            run.Fields["state"] = "claimed"
            run.Save(directory)
            Terminal.Message("Claimed issue #" + number.ToString() + ". Run: " + directory)
            return directory
        }

        internal func Recheck(run Data) JsonElement {
            let viewer = GitHub.Api("user")
            if !String.Equals(J.Text(viewer, "login"), run.Text("donor"), StringComparison.OrdinalIgnoreCase) {
                throw Exception("Use the GitHub account that claimed this run")
            }
            let record = Approved(Data.Repo(run.Text("repo")), run.Number("issue"), Data.Login(run.Text("donor")))
            if J.Text(record, "sha") != run.Text("approval") {
                throw Exception("Approval was replaced. This run cannot be published.")
            }
            let approval = J.Get(record, "approval")
            if run.Text("base") != J.Text(approval, "base") || run.Text("base_branch") != J.Text(
                approval,
                "base_branch"
            ) ||
                run.Text("policy_hash") != J.Text(approval, "policy_hash") {
                throw Exception("Saved run differs from owner approval")
            }
            if run.Text("branch") != "tokate/issue-" + run.Number("issue").ToString() + "-" + run.Text("approval")
                .Substring(0, 12) {
                throw Exception("Invalid saved claim branch")
            }
            let head = Data.Repo(run.Text("head_repo"))
            if !String.Equals(head.Split('/')[0], run.Text("donor"), StringComparison.OrdinalIgnoreCase) {
                throw Exception("Invalid donor fork")
            }
            Policy(J.Write(J.Get(record, "policy"))).Validate(
                run.Text("model"),
                run.Text("effort"),
                run.Number("seconds"),
                run.Flag("network")
            )
            return record
        }
    }
}
