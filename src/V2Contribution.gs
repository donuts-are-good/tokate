package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

// Donor-side operations: credentials remain with gh/the harness. Verification
// executes only inside the existing unprivileged independent verifier.
internal class V2Contribution {
    shared {
        internal func Recheck(run Data) JsonElement {
            let viewer = GitHub.Api("user")
            let repo = Data.Repo(run.Text("repo"))
            let state = CoordinationState.Load(repo, run.Number("issue"))
            if J.Get(viewer, "id").ToString() != J.Get(run.Element(), "donor_id").ToString() || state.Sha != run.Text(
                "state_sha"
            ) ||
                J.Text(state.Value(), "approval_id") != run.Text("approval") || J.Text(
                J.Get(state.Value(), "reservation"),
                "reservation"
            ) != run.Text("id") {
                throw Exception("Saved run has stale coordination authority")
            }
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(repo, run.Number("issue"), run.Text("donor"))
            let approval = J.Get(record, "approval")
            if run.Text("base") != J.Text(approval, "base") || run.Text("policy_hash") != J.Text(
                approval,
                "policy_hash"
            ) ||
                run.Text("branch") != "tokate/v2-" + run.Text("id") || run.Text("base_branch") != J.Text(
                approval,
                "base_branch"
            ) {
                throw Exception("Saved run differs from reservation and approval")
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            RequestData.Tools(J.Get(run.Element(), "tools"))
            policy.ValidateTools(J.Get(run.Element(), "tools"))
            let tools = J.Items(J.Get(run.Element(), "tools"))
            if run.Text("source") == "tokate" {
                if tools.Count != 1 || J.Text(tools[0], "harness") != "codex" || J.Text(
                    tools[0],
                    "provider"
                ) != "openai" ||
                    run.Text("model") != J.Text(tools[0], "model") || run.Text("effort") != J.Text(
                    tools[0],
                    "effort"
                ) ||
                    run.Text("model") == "unknown" || run.Text("effort") == "unknown" {
                    throw Exception("Saved execution differs from the declared tool; no model substitution is allowed")
                }
            } else if run.Text("source") != "external" {
                throw Exception("Invalid contribution source")
            }
            let fork = Data.Repo(run.Text("head_repo"))
            if !String.Equals(fork.Split('/')[0], run.Text("donor"), StringComparison.OrdinalIgnoreCase) ||
                fork == repo {
                throw Exception("Use a donor-owned upstream fork")
            }
            if run.Number("seconds") < 1 || run.Number("seconds") > J.Number(policy.Value, "max_seconds") ||
                (run.Flag("network") && !J.Bool(policy.Value, "allow_network")) {
                throw Exception("Verification budget or network access exceeds owner policy")
            }
            return record
        }

        internal func Prepare(args Args) {
            let repo = Data.Repo(args.Need("repo"))
            let issue = args.Number("issue")
            let viewer = GitHub.Api("user")
            let donor = Data.Login(J.Text(viewer, "login"))
            let state = CoordinationState.Load(repo, issue)
            if state.Sha != Data.CommitSha(args.Need("state")) {
                throw Exception("Stale coordination revision")
            }
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(repo, issue, donor)
            let tools = RequestData.FileData(args.Need("tools"), 8192)
            RequestData.Tools(tools)
            Policy(J.Write(J.Get(record, "policy"))).ValidateTools(tools)
            let source = args.Need("source")
            if source != "external" && source != "tokate" {
                throw Exception("source must be external or tokate")
            }
            if source == "tokate" &&
                (
                J.Items(tools).Count != 1 || J.Text(J.Items(tools)[0], "harness") != "codex" || J.Text(
                    J.Items(tools)[0],
                    "provider"
                ) != "openai"
            ) {
                throw Exception(
                    "Tokate-launched execution currently supports one codex/openai declaration; other harnesses use external"
                )
            }
            let approval = J.Get(record, "approval")
            let run = Data()
            run.Fields["version"] = 2
            run.Fields["id"] = J.Text(J.Get(state.Value(), "reservation"), "reservation")
            run.Fields["repo"] = repo
            run.Fields["issue"] = issue
            run.Fields["donor"] = donor
            run.Fields["donor_id"] = J.Get(viewer, "id")
            run.Fields["head_repo"] = Data.Repo(args.Get("fork", donor + "/" + repo.Split('/')[1]))
            run.Fields["approval"] = J.Text(state.Value(), "approval_id")
            run.Fields["state_sha"] = state.Sha
            run.Fields["base"] = J.Text(approval, "base")
            run.Fields["base_branch"] = J.Text(approval, "base_branch")
            run.Fields["policy_hash"] = J.Text(approval, "policy_hash")
            run.Fields["branch"] = "tokate/v2-" + run.Text("id")
            run.Fields["source"] = source
            run.Fields["tools"] = tools
            run.Fields["seconds"] = args.Number(
                "seconds",
                Math.Min(3600, J.Number(J.Get(record, "policy"), "max_seconds")).ToString()
            )
            run.Fields["network"] = args.Get("allow-network") == "true"
            run.Fields["state"] = "claimed"
            if source == "tokate" {
                run.Fields["model"] = J.Text(J.Items(tools)[0], "model")
                run.Fields["effort"] = J.Text(J.Items(tools)[0], "effort")
            }
            Recheck(run)
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
            if Directory.Exists(directory) {
                throw Exception("Saved contribution already exists; inspect it instead of overwriting")
            }
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            run.Save(directory)
            Terminal.Message("Prepared contribution. Run: " + directory)
        }

        internal func External(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            if run.Number("version") != 2 || run.Text("source") != "external" || run.Text("state") != "claimed" {
                throw Exception("Expected an unexecuted external version-2 contribution")
            }
            let record = Recheck(run)
            let commit = Data.CommitSha(args.Need("commit"))
            let metadata = J.Parse(
                J.Write(J.Map("fork", run.Text("head_repo"), "branch", run.Text("branch"), "head", commit))
            )
            Coordinator.ValidateFork(run.Text("repo"), run.Text("donor"), metadata, J.Get(run.Element(), "donor_id"))
            let checkout = Path.Combine(directory, "checkout")
            if Directory.Exists(checkout) {
                throw Exception("External checkout already exists; interrupted verification requires inspection")
            }
            Directory.CreateDirectory(checkout)
            Commands.Git(checkout, "init", "--quiet", "--template=")
            Commands.Git(
                checkout,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                "https://github.com/" + run.Text("head_repo") + ".git",
                commit
            )
            Commands.Git(
                checkout,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                "https://github.com/" + run.Text("repo") + ".git",
                run.Text("base")
            )
            Commands.Git(checkout, "checkout", "--quiet", "--detach", commit)
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit {
                throw Exception("Fetched commit differs from exact declaration")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), commit)
            ProtectedDiff(checkout, run.Text("base"), commit)
            let timer = Stopwatch.StartNew()
            run.Fields["state"] = "verifying"
            run.Fields["commit"] = commit
            run.Save(directory)
            let results = List[Object]()
            for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                let remaining = run.Number("seconds") - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                if remaining < 1 {
                    throw Exception("Verification budget exhausted")
                }
                let words = List[string]()
                for word in J.Items(command) {
                    words.Add(word.GetString() ?? "")
                }
                let result = Verification.Run(checkout, words.ToArray(), run.Flag("network"), remaining)
                results.Add(
                    J.Map("command", command, "exit_code", result.Code, "output", result.Output, "error", result.Error)
                )
                File.WriteAllText(Path.Combine(directory, "verification.json"), J.Write(results))
                if result.Code != 0 {
                    throw Exception("Independent external verification failed; no publication authority granted")
                }
            }
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit || Commands.Git(
                checkout,
                "status",
                "--porcelain"
            ) != "" {
                throw Exception("Independent verification changed the declared commit or checkout")
            }
            Recheck(run)
            run.Fields["verification"] = results
            run.Fields["verification_provenance"] = "tokate-observed locally, exact commit " + commit
            run.Fields["tool_provenance"] = "donor-reported; identity, usage and coding time not independently attested"
            run.Fields["state"] = "generated"
            run.Save(directory)
            Terminal.Message("Exact external commit passed independent verification. Use submit --run " + directory)
        }

        private func ProtectedDiff(checkout string, base string, commit string) {
            let files = Commands.Git(checkout, "diff", "--name-only", base, commit)
            if files == "" {
                throw Exception("Contribution must change the approved base")
            }
            for file in files.Split('\n') {
                if file.StartsWith(".github/workflows/") || file.StartsWith(".github/tokate") {
                    throw Exception("Contribution changes protected owner policy or workflows")
                }
            }
        }

        internal func Commit(directory string) {
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let record = Recheck(run)
            if run.Text("source") != "tokate" || run.Text("state") != "generated" {
                throw Exception("Expected successfully verified Tokate execution")
            }
            let checkout = Path.Combine(directory, "checkout")
            let patch = Commands.Git(checkout, "diff", "--cached", "--binary", run.Text("base"))
            if patch + "\n" != File.ReadAllText(Path.Combine(directory, "changes.patch")) {
                throw Exception("Verified patch changed")
            }
            Commands.Git(
                checkout,
                "-c",
                "user.name=" + run.Text("donor"),
                "-c",
                "user.email=tokate@users.noreply.github.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                J.Text(J.Get(record, "issue"), "title")
            )
            run.Fields["commit"] = Commands.Git(checkout, "rev-parse", "HEAD")
            run.Fields["verification_provenance"] = "tokate-observed locally"
            run.Fields[
                "tool_provenance"
            ] = "Tokate-observed harness invocation and requested model/effort; tool-reported usage, not identity attestation"
            run.Save(directory)
            Terminal.Message("Verified commit saved. Use submit --run " + directory)
        }

        internal func Request(args Args) {
            let value = RequestData.FileData(args.Need("file"), 8192)
            RequestData.Request(value)
            GitHub.Api(
                "repos/" + Data.Repo(args.Need("repo")) + "/issues/" + args.Number("issue").ToString() + "/comments",
                J.Map("body", "/tokate " + RequestData.Canonical(value))
            )
            Terminal.Message("Request posted; coordinator outcome is recorded in the issue state ref")
        }

        internal func Submit(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let record = Recheck(run)
            if run.Text("state") != "generated" || run.Text("commit") == "" {
                throw Exception("Only an independently verified exact commit can be submitted")
            }
            Publication.VerificationReport(run, record)
            let checkout = Path.Combine(directory, "checkout")
            if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("commit") || Commands.Git(
                checkout,
                "status",
                "--porcelain"
            ) != "" {
                throw Exception("Verified checkout changed")
            }
            if run.Text("source") == "tokate" {
                File.WriteAllText(Path.Combine(directory, "publication.json"), "{}\n")
                Commands.Git(
                    checkout,
                    "-c",
                    "credential.helper=",
                    "-c",
                    "credential.helper=!gh auth git-credential",
                    "push",
                    "https://github.com/" + run.Text("head_repo") + ".git",
                    "HEAD:refs/heads/" + run.Text("branch")
                )
                Recheck(run)
            }
            if run.Text("publication_uuid") == "" {
                run.Fields["publication_uuid"] = Guid.NewGuid().ToString("D")
                run.Save(directory)
            }
            let request = J.Map(
                "uuid",
                run.Text("publication_uuid"),
                "expected",
                run.Text("state_sha"),
                "approval",
                run.Text("approval"),
                "action",
                "publish",
                "metadata",
                J.Map(
                    "fork",
                    run.Text("head_repo"),
                    "branch",
                    run.Text("branch"),
                    "head",
                    run.Text("commit"),
                    "source",
                    run.Text("source"),
                    "tools",
                    J.Get(run.Element(), "tools"),
                    "verification",
                    "donor-reported-pass"
                )
            )
            let path = Path.Combine(directory, "request.json")
            File.WriteAllText(path, J.Write(request) + "\n")
            Request(
                Args(
                    []string{
                        "request",
                        "--repo",
                        run.Text("repo"),
                        "--issue",
                        run.Number("issue").ToString(),
                        "--file",
                        path
                    }
                )
            )
        }

        internal func VerifyReceipt(repo string, number int32, pull JsonElement, receipt JsonElement) Data {
            RequestData.Keys(receipt, "version,repo,issue,approval,expected,reservation,donor,head")
            let state = CoordinationState.Load(repo, J.Number(receipt, "issue"))
            let contribution = J.Get(state.Value(), "contribution")
            let metadata = J.Get(contribution, "metadata")
            let donor = Data.Login(J.Text(receipt, "donor"))
            let record = state.Check(repo, J.Number(receipt, "issue"), donor)
            state.Reservation(J.Get(contribution, "actor"))
            let stateCommit = GitHub.Api("repos/" + repo + "/git/commits/" + state.Sha)
            let parents = J.Items(J.Get(stateCommit, "parents"))
            if parents.Count != 1 || J.Text(parents[0], "sha") != J.Text(receipt, "expected") || J.Text(
                contribution,
                "expected"
            ) != J.Text(receipt, "expected") {
                throw Exception("Receipt does not match the authoritative contribution revision")
            }
            if J.Text(receipt, "repo") != repo || J.Text(receipt, "approval") != J.Text(state.Value(), "approval_id") ||
                J.Text(receipt, "reservation") != J.Text(J.Get(state.Value(), "reservation"), "reservation") ||
                J.Number(J.Get(contribution, "outcome"), "pr") != number || J.Text(receipt, "head") != J.Text(
                metadata,
                "head"
            ) ||
                J.Text(J.Get(pull, "head"), "sha") != J.Text(metadata, "head") || J.Text(
                J.Get(pull, "head"),
                "ref"
            ) != J.Text(metadata, "branch") || J.Text(J.Get(J.Get(pull, "head"), "repo"), "full_name") != J.Text(
                metadata,
                "fork"
            ) ||
                J.Text(J.Get(pull, "base"), "ref") != J.Text(J.Get(record, "approval"), "base_branch") {
                throw Exception("PR receipt lacks current exact-commit coordination authority")
            }
            Policy(J.Write(J.Get(record, "policy"))).ValidateTools(J.Get(metadata, "tools"))
            let run = Data()
            run.Fields["version"] = 2
            run.Fields["repo"] = repo
            run.Fields["pr"] = number
            run.Fields["commit"] = J.Text(metadata, "head")
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            return run
        }
    }
}
