package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class ContributionClaim {
    shared {
        internal func Claim(args Args, snapshot ValueTuple[string, string, Policy]? = nil) string {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let number = args.Number("issue")
            let viewer = GitHub.Api("user")
            let donor = RepositoryIdentity.Login(J.Text(viewer, "login"))
            let record = OwnerApproval.Approved(repo, number, donor, snapshot: snapshot)
            let approval = J.Get(record, "approval")
            if J.Text(approval, "predecessor_approval") != "" && args.Get("continue-from") == "" {
                throw Exception(
                    "This continuation grant requires explicit --continue-from; request ordinary fresh approval to start from the base without importing"
                )
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            policy.Digest = J.Text(approval, "policy_hash")
            let selection = DonorSelection.Resolve(args, policy)
            let model = J.Text(selection, "model")
            let effort = J.Text(selection, "effort")
            if args.Get("unlimited") == "true" {
                throw Exception("Unlimited coding requires managed version-2 work")
            }
            let seconds = args.Number(
                "seconds",
                Math.Min(3600, J.Number(J.Get(record, "policy"), "max_seconds")).ToString()
            )
            let reserve = RuntimeBudget.Reserve(args, seconds)
            let network = args.Get("allow-network") == "true"
            policy.Validate(model, effort, seconds, network)
            Terminal.Step(
                "Selected " + J.Text(selection, "harness") + "/" + J.Text(selection, "provider") +
                    ": " +
                    model +
                    " / " +
                    effort +
                    " from " +
                    J.Text(selection, "source") +
                    "; current policy permits it and native Codex advertises the controls. Availability: " +
                    J.Text(selection, "availability") + "."
            )
            if args.Command == "work" || args.Guided {
                if args.Get("continue-from") != "" {
                    V1Continuation.Confirm(args, selection)
                } else {
                    DonorSelection.Confirm(args, selection)
                }
            }
            let run = Data(
                map[string, Object?]{
                    "version": 1,
                    "id": Guid.NewGuid().ToString("N"),
                    "repo": repo,
                    "issue": number,
                    "donor": donor,
                    "donor_id": J.Get(viewer, "id"),
                    "head_repo": RepositoryIdentity.Repo(args.Get("fork", donor + "/" + repo.Split('/')[1])),
                    "approval": J.Text(record, "sha"),
                    "base": J.Text(approval, "base"),
                    "base_branch": J.Text(approval, "base_branch"),
                    "policy_hash": J.Text(approval, "policy_hash"),
                    "model": model,
                    "effort": effort,
                    "harness": J.Text(selection, "harness"),
                    "provider": J.Text(selection, "provider"),
                    "selection": selection,
                    "seconds": seconds
                }
            )
            if args.Get("verification-reserve") != "" {
                run.Fields["verification_reserve"] = reserve
            }
            run.Fields["network"] = network
            run.Fields["branch"] = "tokate/issue-" + number.ToString() + "-" + J.Text(record, "sha").Substring(0, 12)
            run.Fields["state"] = "preparing"
            if args.Get("continue-from") != "" {
                let sourceDirectory = LocalPaths.DirectoryPath(args.Need("continue-from"))
                run.Fields["continuation_source"] = sourceDirectory
                {
                    using let sourceLease = V1Continuation.SourceLease(sourceDirectory)
                    let source = V1Continuation.Source(sourceDirectory, run, record)
                    run.Fields["continuation"] = V1Continuation.Provenance(source)
                    run.Fields["continuation_source_metadata_sha256"] = Data.Hash(
                        V1Continuation.Metadata(sourceDirectory)
                    )
                    run.Fields["id"] = Data.Hash(run.Text("approval") + ":" + source.Text("id")).Substring(0, 32)
                }
            }
            let directory = Preparation.RunDirectory(args, run.Text("id"))
            PublicOutput.RunDirectory = directory
            if V1Continuation.Has(run) &&
                (Directory.Exists(directory) || File.Exists(directory) || FileInfo(directory).LinkTarget != nil) {
                throw CliFailure(
                    "invalid_state",
                    "Existing continuation preparation: " +
                        directory +
                        ". Inspect status --run DIR, then use prepare --run DIR before work --run DIR. No new reservation was created."
                )
            }
            Preparation.Select(run, args.Get("fork"))
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            Terminal.Step(RuntimeBudget.Description(run))
            using let lease = RunStorage.Lease(directory)
            Terminal.Step("Preparing contribution. Run: " + directory)
            Preparation.Initialize(directory, run, args.Get("fork"))
            if V1Continuation.Has(run) {
                V1Continuation.Capture(directory, run, record)
            }
            Preparation.Complete(directory, run)
            Terminal.Message("Claimed issue #" + number.ToString() + ". Run: " + directory)
            return directory
        }

        internal func Recheck(run Data) JsonElement {
            if run.Number("version") == 2 {
                return ContributionClaim.RecheckV2(run)
            }
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, run) {
                throw CliFailure(
                    "authentication_required",
                    "Use the GitHub account that claimed this run",
                    []string{"gh", "auth", "switch", "--user", run.Text("donor")}
                )
            }
            let record = OwnerApproval.Approved(
                RepositoryIdentity.Repo(run.Text("repo")),
                run.Number("issue"),
                RepositoryIdentity.Login(run.Text("donor"))
            )
            if J.Text(record, "sha") != run.Text("approval") {
                throw CliFailure("stale_approval", "Approval was replaced. This run cannot be published.")
            }
            let approval = J.Get(record, "approval")
            if J.Text(approval, "predecessor_approval") != "" && !V1Continuation.Has(run) {
                throw Exception("Continuation grant lost its explicit predecessor/import state")
            }
            if V1Continuation.Has(run) {
                RuntimeBudget.Validate(run)
                if run.Number("verification_reserve") < 1 {
                    throw Exception("Continuation requires its separately selected positive verification reserve")
                }
                V1Continuation.Grant(
                    record,
                    J.Text(J.Get(run.Element(), "continuation"), "approval"),
                    J.Get(run.Element(), "donor_id")
                )
            }
            if run.Text("base") != J.Text(approval, "base") || run.Text("base_branch") != J.Text(
                approval,
                "base_branch"
            ) ||
                run.Text("policy_hash") != J.Text(approval, "policy_hash") {
                throw CliFailure("stale_approval", "Saved run differs from owner approval")
            }
            if run.Text("branch") != "tokate/issue-" + run.Number("issue").ToString() + "-" + run.Text("approval")
                .Substring(0, 12) {
                throw Exception("Invalid saved claim branch")
            }
            RepositoryIdentity.Repo(run.Text("head_repo"))
            if run.Number("preparation_version") == 0 || run.Text("state") != "preparing" {
                RepositoryAccess.ValidateRun(run)
            }
            Policy(J.Write(J.Get(record, "policy"))).Validate(
                run.Text("model"),
                run.Text("effort"),
                run.Number("seconds"),
                run.Flag("network")
            )
            return record
        }

        internal func RecheckV2(run Data) JsonElement {
            Preparation.CheckIdentity(run)
            let viewer = GitHub.Api("user")
            let repo = RepositoryIdentity.Repo(run.Text("repo"))
            let state = CoordinationState.Load(repo, run.Number("issue"))
            let value = state.Value()
            let saved = run.Element()
            let reservation = J.Get(value, "reservation")
            if !RepositoryIdentity.SameDonor(viewer, run) ||
                (!LeaseLifecycle.Supported(value) && state.Sha != run.Text("state_sha")) ||
                J.Text(value, "approval_id") != run.Text("approval") || J.Text(reservation, "reservation") != run.Text(
                "id"
            ) {
                throw CliFailure("stale_approval", "Saved run has stale coordination authority")
            }
            if AccessState.Task(J.Get(value, "approval")) {
                RepositoryIdentity.PositiveId(J.Get(saved, "donor_id"))
            }
            state.Reservation(J.Get(viewer, "id"))
            if LeaseLifecycle.Supported(value) &&
                (
                run.Text("attempt") == "" || run.Text("attempt") != J.Text(reservation, "attempt") ||
                    RepositoryIdentity.PositiveId(J.Get(saved, "donor_id")) != RepositoryIdentity.PositiveId(
                    J.Get(J.Get(value, "identity"), "actor")
                )
            ) {
                throw CliFailure("stale_approval", "Saved execution attempt fence changed; old work is preserved")
            }
            let record = state.Check(repo, run.Number("issue"), run.Text("donor"), J.Get(viewer, "id"))
            let approval = J.Get(record, "approval")
            if run.Text("base") != J.Text(approval, "base") || run.Text("policy_hash") != J.Text(
                approval,
                "policy_hash"
            ) ||
                run.Text("branch") != "tokate/v2-" + run.Text("id") || run.Text("base_branch") != J.Text(
                approval,
                "base_branch"
            ) {
                throw CliFailure("stale_approval", "Saved run differs from reservation and approval")
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            let declaredTools = J.Get(saved, "tools")
            RequestData.Tools(declaredTools)
            policy.ValidateTools(declaredTools, run.Text("source"))
            let tools = J.Items(declaredTools)
            if run.Text("source") == "tokate" &&
                (run.Text("model") != J.Text(tools[0], "model") || run.Text("effort") != J.Text(tools[0], "effort")) {
                throw Exception("Saved execution differs from the declared tool; no model substitution is allowed")
            }
            RepositoryIdentity.Repo(run.Text("head_repo"))
            if run.Number("preparation_version") == 0 || run.Text("state") != "preparing" {
                RepositoryAccess.ValidateRun(run)
            }
            RuntimeBudget.Validate(run)
            policy.ValidateBudget(run.Number("seconds"), run.Flag("network"), run.Flag("unlimited"))
            V2Continuation.Recheck(run, state)
            return record
        }
    }
}
