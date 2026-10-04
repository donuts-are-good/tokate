package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

// Donor-side operations: credentials remain with gh/the harness. Verification
// executes only inside the existing unprivileged independent verifier.
internal class V2Preparation {
    shared {
        internal func Prepare(args Args) {
            if args.Get("run") != "" {
                Preparation.Resume(args.Need("run"))
                return
            }
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let issue = args.Number("issue")
            let viewer = GitHub.Api("user")
            let donor = RepositoryIdentity.Login(J.Text(viewer, "login"))
            let state = CoordinationState.Load(repo, issue)
            if state.Sha != RepositoryIdentity.CommitSha(args.Need("state")) {
                throw CliFailure("stale_approval", "Stale coordination revision")
            }
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(repo, issue, donor, J.Get(viewer, "id"))
            let policy = Policy(J.Write(J.Get(record, "policy")))
            let source = args.Need("source")
            if source != "external" && source != "tokate" {
                throw Exception("source must be external or tokate")
            }
            var tools = args.Get("tools") == "" ? JsonElement{}: RequestData.FileData(args.Need("tools"), 8192)
            var selection = JsonElement{}
            if tools.ValueKind != JsonValueKind.Undefined {
                RequestData.Tools(tools)
                policy.ValidateTools(tools, source)
            }
            let approval = J.Get(record, "approval")
            if source == "tokate" {
                if tools.ValueKind != JsonValueKind.Undefined {
                    let declared = J.Items(tools)[0]
                    for key in[]string{"harness", "provider", "model", "effort"} {
                        if args.Get(key) != "" && args.Get(key) != J.Text(declared, key) {
                            throw Exception(
                                "Explicit selection conflicts with declared tool; no model substitution is allowed"
                            )
                        }
                        args.Values["--" + key] = J.Text(declared, key)
                    }
                }
                policy.Digest = J.Text(approval, "policy_hash")
                selection = DonorSelection.Resolve(args, policy)
                if tools.ValueKind == JsonValueKind.Undefined {
                    tools = J.Parse(
                        J.Write(
                            []Object{
                                J.Map(
                                    "harness",
                                    J.Text(selection, "harness"),
                                    "provider",
                                    J.Text(selection, "provider"),
                                    "model",
                                    J.Text(selection, "model"),
                                    "effort",
                                    J.Text(selection, "effort")
                                )
                            }
                        )
                    )
                }
            }
            let run = Data()
            run.Fields["version"] = 2
            run.Fields["id"] = J.Text(J.Get(state.Value(), "reservation"), "reservation")
            run.Fields["repo"] = repo
            run.Fields["issue"] = issue
            run.Fields["donor"] = donor
            run.Fields["donor_id"] = J.Get(viewer, "id")
            run.Fields["head_repo"] = RepositoryIdentity.Repo(args.Get("fork", donor + "/" + repo.Split('/')[1]))
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
            if args.Get("verification-reserve") != "" {
                run.Fields["verification_reserve"] = RuntimeBudget.Reserve(args, run.Number("seconds"))
            }
            run.Fields["network"] = args.Get("allow-network") == "true"
            policy.ValidateBudget(run.Number("seconds"), run.Flag("network"))
            run.Fields["state"] = "claimed"
            if source == "tokate" {
                run.Fields["model"] = J.Text(J.Items(tools)[0], "model")
                run.Fields["effort"] = J.Text(J.Items(tools)[0], "effort")
                run.Fields["harness"] = J.Text(selection, "harness")
                run.Fields["provider"] = J.Text(selection, "provider")
                run.Fields["selection"] = selection
            }
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
            PublicOutput.RunDirectory = directory
            if Directory.Exists(directory) {
                throw Exception("Saved contribution already exists; inspect it instead of overwriting")
            }
            Preparation.Select(run, args.Get("fork"))
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            if source == "tokate" {
                Terminal.Step(RuntimeBudget.Description(run))
            }
            using let lease = Preparation.Lease(directory)
            Terminal.Step("Preparing contribution. Run: " + directory)
            Preparation.Initialize(directory, run, args.Get("fork"))
            Preparation.Complete(directory, run)
            Terminal.Message("Prepared contribution. Run: " + directory)
        }
    }
}
