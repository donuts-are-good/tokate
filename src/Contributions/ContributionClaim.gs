package Tokate

import System
import System.Text.Json

internal class ContributionClaim {
    shared {
        internal func Recheck(run Data) JsonElement {
            if run.Number("version") != 2 {
                throw CliFailure("invalid_state", "Unsupported run protocol; start a current contribution")
            }
            WorkspacePreparation.CheckIdentity(run)
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
            RepositoryIdentity.PositiveId(J.Get(saved, "donor_id"))
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
            AttemptContinuation.Recheck(run, state)
            return record
        }
    }
}
