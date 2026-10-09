package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class ContributionPreparation {
    shared {
        internal func Prepare(args Args) string {
            if args.Get("run") != "" {
                return ResumePending(Path.GetFullPath(args.Need("run")), args)
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
            Overlaps.RequireDependencies(repo, issue)
            let run = Plan(args, repo, issue, viewer, state, record, args.Need("source"))
            Bind(run, state)
            let directory = args.Get("continue-from") != "" ? AttemptContinuation.RunDirectory(
                args,
                run.Text("attempt")
            ): WorkspacePreparation.RunDirectory(args, run.Text("attempt"))
            PublicOutput.RunDirectory = directory
            if Directory.Exists(directory) {
                throw Exception("Saved contribution already exists; inspect it instead of overwriting")
            }
            WorkspacePreparation.Select(run, args.Get("fork"))
            if args.Get("continue-from") != "" {
                if run.Text("source") != "tokate" || run.Text("attempt") == "" {
                    throw Exception("Continuation requires a managed v2 fresh active attempt")
                }
                let sourceDirectory = LocalPaths.DirectoryPath(args.Need("continue-from"))
                using let sourceLease = ContinuationImport.SourceLease(sourceDirectory)
                let source = AttemptContinuation.Source(sourceDirectory, run, record)
                run.Fields["continuation_source"] = sourceDirectory
                run.Fields["continuation"] = AttemptContinuation.Provenance(source)
                run.Fields["continuation_source_metadata_sha256"] = Data.Hash(
                    ContinuationImport.Metadata(sourceDirectory)
                )
                AttemptContinuation.Confirm(args, J.Get(run.Element(), "selection"))
            }
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            if run.Text("source") == "tokate" {
                Terminal.Step(RuntimeBudget.Description(run))
            }
            using let lease = RunStorage.Lease(directory)
            Terminal.Step("Preparing contribution. Run: " + directory)
            WorkspacePreparation.Initialize(directory, run, args.Get("fork"))
            WorkspacePreparation.Complete(directory, run)
            Terminal.Message("Prepared contribution. Run: " + directory)
            return directory
        }

        private func Plan(
            args Args,
            repo string,
            issue int32,
            viewer JsonElement,
            state CoordinationState,
            record JsonElement,
            source string
        ) Data {
            let donor = RepositoryIdentity.Login(J.Text(viewer, "login"))
            let policy = Policy(J.Write(J.Get(record, "policy")))
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
                                map[string, Object?]{
                                    "harness": J.Text(selection, "harness"),
                                    "provider": J.Text(selection, "provider"),
                                    "model": J.Text(selection, "model"),
                                    "effort": J.Text(selection, "effort")
                                }
                            }
                        )
                    )
                }
            }
            if J.Get(state.Value(), "contribution").ValueKind == JsonValueKind.Object && args.Get("from-pr") == "" {
                throw Exception(
                    "Published work is preserved; saved-checkout continuation remains unsupported until #14"
                )
            }
            let run = Data(
                map[string, Object?]{
                    "version": 2,
                    "repo": repo,
                    "issue": issue,
                    "donor": donor,
                    "donor_id": J.Get(viewer, "id"),
                    "head_repo": RepositoryIdentity.Repo(args.Get("fork", donor + "/" + repo.Split('/')[1])),
                    "approval": J.Text(state.Value(), "approval_id"),
                    "base": J.Text(approval, "base"),
                    "base_branch": J.Text(approval, "base_branch"),
                    "policy_hash": J.Text(approval, "policy_hash"),
                    "source": source,
                    "tools": tools
                }
            )
            if args.Get("from-pr") != "" {
                if source != "external" {
                    throw Exception("Published handoff uses explicit external tools and their own coding budget")
                }
                run.Fields["handoff"] = ContributionHandoff.Read(
                    state,
                    J.Get(viewer, "id"),
                    record,
                    args.Number("from-pr")
                )
            }
            if (args.Command == "work" || args.Command == "claim") && args.Get("unlimited") != "true" {
                args.Need("seconds")
            }
            run.Fields["seconds"] = RuntimeBudget.ReadSeconds(
                args,
                Math.Min(3600, J.Number(J.Get(record, "policy"), "max_seconds")).ToString()
            )
            if args.Get("unlimited") == "true" {
                run.Fields["unlimited"] = true
            }
            if args.Get("verification-reserve") != "" {
                run.Fields["verification_reserve"] = RuntimeBudget.Reserve(args, run.Number("seconds"))
            }
            run.Fields["network"] = args.Get("allow-network") == "true"
            policy.ValidateBudget(run.Number("seconds"), run.Flag("network"), run.Flag("unlimited"))
            if source == "tokate" {
                let declared = J.Items(tools)[0]
                run.Fields["model"] = J.Text(declared, "model")
                run.Fields["effort"] = J.Text(declared, "effort")
                run.Fields["harness"] = J.Text(selection, "harness")
                run.Fields["provider"] = J.Text(selection, "provider")
                run.Fields["selection"] = selection
                if args.Get("harness-path") != "" {
                    run.Fields["harness_path"] = LocalPaths.RuntimePath(args.Need("harness-path"))
                }
                if J.Text(selection, "harness") == "pi" {
                    run.Fields["pi_endpoint"] = PiBoundary.Endpoint(args.Need("endpoint"))
                    run.Fields["pi_root"] = args.Need("pi-root")
                    run.Fields["pi_node"] = args.Need("node")
                }
            }
            RuntimeBudget.Validate(run)
            return run
        }

        private func Bind(run Data, state CoordinationState) {
            let reservation = J.Get(state.Value(), "reservation")
            run.Fields["id"] = J.Text(reservation, "reservation")
            run.Fields["state_sha"] = state.Sha
            run.Fields["attempt"] = J.Text(reservation, "attempt")
            run.Fields["branch"] = "tokate/v2-" + run.Text("id")
        }

        internal func Acquire(args Args) string {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let info = GitHub.Api("repos/" + repo)
            let branch = J.Text(info, "default_branch")
            let revision = GitHub.Branch(repo, branch)
            let policy = Policy.Load(repo, revision)
            if args.Get("continue-from") != "" {
                throw Exception(
                    "For stopped v2 work, explicitly acquire a fresh attempt then use prepare --continue-from with its current --state; no claim was posted"
                )
            }
            let issue = args.Number("issue")
            let viewer = GitHub.Api("user")
            let donor = RepositoryIdentity.Login(J.Text(viewer, "login"))
            let state = CoordinationState.Load(repo, issue)
            let record = state.Check(repo, issue, donor, J.Get(viewer, "id"))
            let reservation = J.Get(state.Value(), "reservation")
            if reservation.ValueKind == JsonValueKind.Object && J.Text(reservation, "status") != "released" &&
                CoordinationState.Unix(reservation, "expires") > DateTimeOffset.UtcNow.ToUnixTimeSeconds() {
                throw CliFailure("invalid_state", "An unexpired reservation already owns this contribution")
            }
            if reservation.ValueKind == JsonValueKind.Object && !LeaseLifecycle.Supported(state.Value()) {
                throw CliFailure("stale_approval", "Legacy lease reacquisition requires fresh owner approval")
            }
            Overlaps.RequireDependencies(repo, issue)
            let run = Plan(args, repo, issue, viewer, state, record, args.Get("source", "tokate"))
            if args.Command == "work" || args.Guided {
                DonorSelection.Confirm(args, J.Get(run.Element(), "selection"))
            }
            let request = J.Parse(
                J.Write(
                    map[string, Object?]{
                        "uuid": Guid.NewGuid().ToString("D"),
                        "expected": state.Sha,
                        "approval": run.Text("approval"),
                        "action": "claim",
                        "metadata": map[string, Object?]{}
                    }
                )
            )
            RequestData.Request(request)
            run.Fields["claim_request"] = request
            run.Fields["requested_fork"] = args.Get("fork")
            run.Fields["state"] = "claim_pending"
            let directory = WorkspacePreparation.RunDirectory(args, J.Text(request, "uuid"))
            PublicOutput.RunDirectory = directory
            if Directory.Exists(directory) || File.Exists(directory) || FileInfo(directory).LinkTarget != nil {
                throw CliFailure("invalid_state", "Saved claim already exists; inspect its original run")
            }
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            using let lease = RunStorage.Lease(directory)
            WorkspacePreparation.Pending(directory, run)
            return Pending(directory, run, args)
        }

        internal func ResumePending(directory string, args Args) string {
            PublicOutput.RunDirectory = directory
            using let lease = RunStorage.Lease(directory)
            let run = Data.Load(directory)
            if run.Text("state") != "claim_pending" {
                if args.Command == "prepare" {
                    WorkspacePreparation.Complete(directory, run)
                    Terminal.Message("Prepared contribution. Run: " + directory)
                }
                return directory
            }
            return Pending(directory, run, args)
        }

        private func CheckPending(run Data, viewer JsonElement, state CoordinationState) {
            let request = J.Get(run.Element(), "claim_request")
            RequestData.Request(request)
            if run.Number("version") != 2 || run.Text("state") != "claim_pending" ||
                (run.Text("source") != "tokate" && run.Text("source") != "external") ||
                J.Text(request, "action") != "claim" || !RepositoryIdentity.SameDonor(viewer, run) ||
                run
                .Fields
                .ContainsKey("id") || run.Fields.ContainsKey("attempt") || run.Fields.ContainsKey(
                "preparation_identity"
            ) {
                throw CliFailure("invalid_state", "Invalid saved pending claim; no authority was acquired")
            }
            if J.Text(request, "approval") != run.Text("approval") || J.Text(state.Value(), "approval_id") != run.Text(
                "approval"
            ) {
                throw CliFailure("stale_approval", "Pending claim approval changed; original work is preserved")
            }
            let record = state.Check(run.Text("repo"), run.Number("issue"), run.Text("donor"), J.Get(viewer, "id"))
            let approval = J.Get(record, "approval")
            if run.Text("base") != J.Text(approval, "base") || run.Text("base_branch") != J.Text(
                approval,
                "base_branch"
            ) ||
                run.Text("policy_hash") != J.Text(approval, "policy_hash") {
                throw CliFailure("stale_approval", "Pending claim differs from current owner approval")
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            policy.Digest = run.Text("policy_hash")
            let tools = J.Get(run.Element(), "tools")
            RequestData.Tools(tools)
            policy.ValidateTools(tools, run.Text("source"))
            if run.Text("source") == "tokate" &&
                (
                J.Get(run.Element(), "selection").ValueKind != JsonValueKind.Object || run.Text("harness") != J.Text(
                    J.Items(tools)[0],
                    "harness"
                ) ||
                    run.Text("provider") != J.Text(J.Items(tools)[0], "provider") || run.Text("model") != J.Text(
                    J.Items(tools)[0],
                    "model"
                ) ||
                    run.Text("effort") != J.Text(J.Items(tools)[0], "effort")
            ) {
                throw CliFailure("invalid_state", "Pending claim selection differs from its declared tool")
            }
            policy.ValidateBudget(run.Number("seconds"), run.Flag("network"), run.Flag("unlimited"))
            RuntimeBudget.Validate(run)
            if run.Text("source") == "tokate" {
                DonorSelection.Revalidate(run, policy)
            }
            Overlaps.RequireDependencies(run.Text("repo"), run.Number("issue"))
        }

        private func Accepted(run Data, viewer JsonElement, state CoordinationState, outcome JsonElement) {
            let request = J.Get(run.Element(), "claim_request")
            let uuid = J.Text(request, "uuid")
            let value = state.Value()
            let reservation = J.Get(value, "reservation")
            if !LeaseLifecycle.Supported(value) || J.Text(outcome, "lease") != uuid || J.Text(
                outcome,
                "attempt"
            ) != uuid ||
                RepositoryIdentity.PositiveId(J.Get(outcome, "actor")) != RepositoryIdentity.PositiveId(
                J.Get(viewer, "id")
            ) ||
                J.Text(outcome, "reservation") != J.Text(reservation, "reservation") || J.Text(
                reservation,
                "lease"
            ) != uuid ||
                J.Text(reservation, "attempt") != uuid {
                throw CliFailure("stale_approval", "Exact claim outcome no longer owns the active lease or attempt")
            }
            state.Reservation(J.Get(viewer, "id"))
            LeaseLifecycle.Fence(state, uuid)
            CheckPending(run, viewer, state)
            ContributionHandoff.Authority(state, J.Get(run.Element(), "handoff"))
            if J.Get(value, "contribution").ValueKind == JsonValueKind.Object {
                throw CliFailure("invalid_state", "Published work is preserved; this claim cannot prepare new coding")
            }
        }

        private func Pending(directory string, run Data, args Args) string {
            let viewer = GitHub.Api("user")
            let repo = RepositoryIdentity.Repo(run.Text("repo"))
            let issue = run.Number("issue")
            let request = J.Get(run.Element(), "claim_request")
            if !RepositoryIdentity.SameDonor(viewer, run) {
                throw CliFailure(
                    "authentication_required",
                    "Active GitHub account differs from the saved pending donor; no request posted"
                )
            }
            if args.Get("run") != "" {
                CheckPending(run, viewer, CoordinationState.Load(repo, issue))
            }
            if args.Command == "work" && args.Get("run") != "" {
                DonorSelection.Confirm(args, J.Get(run.Element(), "selection"))
            }
            Submission.Request(
                repo,
                issue,
                request,
                Path.Combine(directory, "claim.posting.json"),
                J.Get(run.Element(), "donor_id")
            )
            ApiTransport.BeginDeadline(30)
            var accepted CoordinationState? = nil
            try {
                while true {
                    ApiTransport.CheckDeadline()
                    let state = CoordinationState.Load(repo, issue)
                    if J.Text(state.Value(), "approval_id") != run.Text("approval") {
                        throw CliFailure(
                            "stale_approval",
                            "Pending claim approval changed; original request is preserved"
                        )
                    }
                    let outcome = RequestData.Recorded(state.Value(), J.Get(viewer, "id"), request)
                    if outcome.ValueKind != JsonValueKind.Undefined {
                        accepted = state
                        break
                    }
                    if state.Sha != J.Text(request, "expected") {
                        throw CliFailure(
                            "invalid_state",
                            "Coordination changed without this exact claim outcome; authority is unknown. Inspect the saved run and current coordination. No new request was posted."
                        )
                    }
                    ApiTransport.PollWait()
                }
            } catch (error ApiDeadlineException) {
                Terminal.Message(
                    "Claim pending. Run: " +
                        directory +
                        "; resume explicitly with " +
                        (run.Text("source") == "tokate" ? "work --run DIR or ": "") +
                        "prepare --run DIR"
                )
            } finally {
                ApiTransport.EndDeadline()
            }
            if let state = accepted {
                let outcome = RequestData.Recorded(state.Value(), J.Get(viewer, "id"), request)
                Accepted(run, viewer, state, outcome)
                Bind(run, state)
                WorkspacePreparation.Select(run, run.Text("requested_fork"))
                WorkspacePreparation.Promote(directory, run)
                if run.Text("source") == "tokate" {
                    Terminal.Step(RuntimeBudget.Description(run))
                }
                Terminal.Step("Preparing contribution. Run: " + directory)
                WorkspacePreparation.Complete(directory, run)
                Terminal.Message("Prepared contribution. Run: " + directory)
            } else {
                PublicOutput.ResultData = PublicOutput.RunSummary(directory)
                if run.Text("source") == "tokate" {
                    PublicOutput.Actions.Add([]string{"tokate", "work", "--run", directory, "--json"})
                }
                PublicOutput.Actions.Add([]string{"tokate", "prepare", "--run", directory, "--json"})
            }
            return directory
        }
    }
}
