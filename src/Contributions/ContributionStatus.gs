package Tokate

import System
import System.Collections.Generic
import System.Globalization
import System.Text.Json

internal class ContributionStatus {
    internal var Failure Exception? = nil
    internal var Truncated bool
    private var Viewer JsonElement
    private var Info JsonElement
    private var Access AccessState? = nil
    internal let Result Dictionary[string, Object?] = map[string, Object?]{}
    private let Work List[Object] = List[Object]()
    private let Requests List[JsonElement] = List[JsonElement]()

    private suspend func Observe(target Dictionary[string, Object?], part string, read async () -> void) bool {
        try {
            await read()
            return true
        } catch (error Exception) {
            return Unavailable(target, part, error)
        }
    }

    private func Unavailable(target Dictionary[string, Object?], part string, error Exception) bool {
        target[part + "_status"] = "unavailable"
        target[
            part + "_reason"
        ] = error is CliFailure failure ? failure.Summary: "Required remote data is unavailable or malformed."
        Failure = Failure ?? error
        return false
    }

    private func Next(role string, action string, command[]string = nil) Dictionary[string, Object?] -> map[
        string,
        Object?
    ]{"role": role, "action": action, "command": command ?? []string{}}

    private func AccessReview(repo string, issue string) Dictionary[string, Object?] {
        if Access?.Sha == "" {
            let command = J.Bool(J.Get(Info, "permissions"), "push") &&
                Text(Result, "viewer_status") == "observed" ? []string{
                "tokate",
                "access",
                "--repo",
                repo,
                "--operation",
                "init"
            }: []string{}
            return Next(
                "owner",
                "Initialize the absent access authority before reviewing requests; requests grant no eligibility.",
                command
            )
        }
        return Next(
            "owner",
            "Review donor access and grant eligibility if appropriate.",
            []string{"tokate", "access", "--repo", repo, "--operation", "list", "--issue", issue}
        )
    }

    private func View(repo string, number int32)[]string -> []string{
        "gh",
        "pr",
        "view",
        number.ToString(),
        "--repo",
        repo
    }

    private func Issue(repo string, task JsonElement) Dictionary[string, Object?] {
        let issue = J.Number(task, "number")
        if issue < 1 || J.Text(task, "state") != "open" || J.Get(task, "pull_request")
            .ValueKind != JsonValueKind.Undefined {
            throw Exception("Expected an open issue in the approved-work index")
        }
        let row = map[string, Object?]{
            "issue": issue,
            "title": PublicOutput.Prose(J.Text(task, "title"), ref Truncated),
            "url": "https://github.com/" + repo + "/issues/" + issue.ToString(),
            "approval_status": "unknown",
            "eligibility_status": "unknown",
            "coordination_status": "unknown",
            "drafts_status": "unknown",
            "state": "unknown",
            "next": Next("owner", "Inspect unavailable contribution state.")
        }
        Work.Add(row)
        var state = CoordinationState()
        var approval JsonElement
        var policy JsonElement
        var approvalSha string = ""
        let loaded = Observe(
            row,
            "coordination",
            async () -> {
                state = CoordinationState.Load(repo, issue, missing: true)
                row["coordination_status"] = state.Sha == "" ? "absent": "observed"
                row["state_sha"] = state.Sha
                if state.Sha != "" {
                    let value = state.Value()
                    approval = J.Get(value, "approval")
                    row["approval_id"] = J.Text(value, "approval_id")
                    row["revoked"] = J.Bool(value, "revoked")
                    Reservation(row, state)
                } else {
                    let reference = GitHub.Api(
                        "repos/" + repo + "/git/ref/heads/" + OwnerApproval.ApprovalRef(issue),
                        missing: true
                    )
                    if reference.ValueKind != JsonValueKind.Undefined {
                        approvalSha = RepositoryIdentity.CommitSha(J.Text(J.Get(reference, "object"), "sha"))
                        approval = RequestData.Parse(
                            GitHub.FileAt(repo, ".github/tokate-approval.json", approvalSha),
                            1024 * 1024
                        )
                        row["approval_sha"] = approvalSha
                    }
                }
                return
            }
        )
        if !loaded {
            row["state"] = "unavailable"
            return row
        }
        if approval.ValueKind == JsonValueKind.Undefined {
            row["approval_status"] = "absent"
            row["drafts_status"] = "absent"
            row["state"] = "approval_waiting"
            row["next"] = Next(
                "owner",
                "Approve the issue under the current policy; assignment and target selections may be required."
            )
            return row
        }
        row["approval"] = PublicOutput.Select(
            approval,
            "version,approval_scope,eligibility,donor,base,base_branch,authority_branch"
        )
        let valid = Observe(
            row,
            "approval",
            async () -> {
                try {
                    if !RepositoryIdentity.SameRepo(J.Text(approval, "repo"), repo) || J.Number(
                        approval,
                        "issue"
                    ) != issue ||
                        J.Number(approval, "version") != (state.Sha == "" ? 1: 2) {
                        throw Exception("Malformed approval identity")
                    }
                    let record = state.Sha == "" ? OwnerApproval.Approved(
                        repo,
                        issue,
                        J.Text(approval, "donor"),
                        quiet: true
                    ): state.CheckApproval(repo, issue, quiet: true)
                    policy = J.Get(record, "policy")
                    row["approval_status"] = "current"
                } catch (error CliFailure) {
                    if error.Code != "stale_approval" {
                        throw error
                    }
                    row["approval_status"] = "stale"
                    row["approval_reason"] = error.Summary
                }
            }
        )
        if Viewer.ValueKind == JsonValueKind.Undefined {
            row["eligibility_status"] = "unavailable"
        }
        if valid && Text(row, "approval_status") == "current" && Viewer.ValueKind != JsonValueKind.Undefined {
            try {
                let scoped = AccessState.Task(approval)
                if scoped && RepositoryIdentity.PositiveId(J.Get(approval, "repo_id")) != RepositoryIdentity.PositiveId(
                    J.Get(Info, "id")
                ) {
                    throw Exception("Task repository numeric identity changed")
                }
                if scoped && (Access == nil || Access?.Sha == "") {
                    throw Exception("Task-scoped donor access is unavailable")
                }
                let actor = RepositoryIdentity.PositiveId(J.Get(Viewer, "id"))
                let donor = RepositoryIdentity.Login(J.Text(Viewer, "login"))
                let mode = scoped ? J.Text(approval, "eligibility"): "assignment"
                let eligible = scoped ? Access?.Allows(actor, mode, issue) == true: String.Equals(
                    donor,
                    J.Text(approval, "donor"),
                    StringComparison.OrdinalIgnoreCase
                )
                row["eligibility_status"] = eligible ? "eligible": "access_waiting"
                row["eligibility_scope"] = "viewer"
                row["eligibility"] = map[string, Object?]{
                    "donor": donor,
                    "actor": actor,
                    "mode": mode,
                    "eligible": eligible
                }
                if Access != nil {
                    for member in Access?.Members ?? List[JsonElement]() {
                        if RepositoryIdentity.PositiveId(J.Get(member, "actor")) == actor {
                            row["viewer_denied"] = J.Bool(member, "denied")
                        }
                    }
                }
                let reservation = J.Get(state.Value(), "reservation")
                if reservation.ValueKind == JsonValueKind.Object {
                    let holder = RepositoryIdentity.PositiveId(J.Get(reservation, "actor"))
                    row["holder_eligible"] = scoped ? Access?.Allows(holder, mode, issue) == true: String.Equals(
                        J.Text(reservation, "donor"),
                        J.Text(approval, "donor"),
                        StringComparison.OrdinalIgnoreCase
                    )
                }
            } catch (error Exception) {
                Unavailable(row, "eligibility", error)
            }
        }
        let drafts = List[Object]()
        row["drafts"] = drafts
        Observe(
            row,
            "drafts",
            async () -> {
                let value = state.Value()
                let current = CoordinationState.Current(value)
                let recorded = J.Number(J.Get(current, "outcome"), "pr")
                if recorded > 0 {
                    Draft(
                        repo,
                        issue,
                        GitHub.Api("repos/" + repo + "/pulls/" + recorded.ToString()),
                        state,
                        approval,
                        policy,
                        drafts,
                        approvalSha
                    )
                } else {
                    let reservation = J.Get(value, "reservation")
                    let donor = state.Sha == "" ? J.Text(approval, "donor"): J.Text(reservation, "donor")
                    let branch = state.Sha == "" ? "tokate/issue-" + issue.ToString() + "-" + approvalSha.Substring(
                        0,
                        12
                    ): "tokate/v2-" +
                        J.Text(reservation, "reservation")
                    if donor != "" {
                        RepositoryIdentity.Login(donor)
                        RepositoryIdentity.Branch(branch)
                        let pulls = GitHub.Api(
                            "repos/" + repo + "/pulls?state=open&head=" + Uri.EscapeDataString(donor + ":" + branch) +
                                "&base=" +
                                Uri.EscapeDataString(J.Text(approval, "base_branch")) + "&per_page=5&page=1"
                        )
                        if pulls.ValueKind != JsonValueKind.Array || pulls.GetArrayLength() > 5 {
                            throw Exception("Cannot read bounded draft PRs")
                        }
                        if pulls.GetArrayLength() == 5 {
                            row["drafts_truncated"] = true
                            Truncated = true
                        }
                        for pull in J.Items(pulls) {
                            Draft(repo, issue, pull, state, approval, policy, drafts, approvalSha)
                        }
                    }
                }
                row["drafts_status"] = drafts.Count == 0 ? "absent": "observed"
            }
        )
        Observe(
            row,
            "remote",
            async () -> {
                let latest = state.Sha == "" ? GitHub.Api(
                    "repos/" + repo + "/git/ref/heads/" + OwnerApproval.ApprovalRef(issue),
                    missing: true
                ): GitHub.Api("repos/" + repo + "/git/ref/heads/" + CoordinationState.Ref(issue), missing: true)
                if J.Text(J.Get(latest, "object"), "sha") != (state.Sha == "" ? approvalSha: state.Sha) {
                    row["remote_status"] = "stale"
                } else if Text(row, "approval_status") == "current" {
                    try {
                        if state.Sha == "" {
                            OwnerApproval.Approved(repo, issue, J.Text(approval, "donor"), quiet: true)
                        } else {
                            state.CheckApproval(repo, issue, quiet: true)
                        }
                        row["remote_status"] = "observed"
                    } catch (error CliFailure) {
                        if error.Code != "stale_approval" {
                            throw error
                        }
                        row["approval_status"] = "stale"
                        row["approval_reason"] = error.Summary
                    }
                }
            }
        )
        ActionFor(repo, row, drafts, state)
        return row
    }

    private func Reservation(row Dictionary[string, Object?], state CoordinationState) {
        let value = state.Value()
        let reservation = J.Get(value, "reservation")
        if reservation.ValueKind != JsonValueKind.Object {
            row["reservation"] = nil
            return
        }
        let displayed = PublicOutput.Select(reservation, "reservation,lease,donor,actor,created,expires,status,attempt")
        row["reservation"] = displayed
        let expires = CoordinationState.Unix(reservation, "expires")
        displayed["expired"] = expires <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        displayed["expires_at"] = DateTimeOffset.FromUnixTimeSeconds(expires).ToString(
            "u",
            CultureInfo.InvariantCulture
        )
        displayed["local_process"] = "unknown; a remote lease does not prove a local process is running"
        try {
            LeaseLifecycle.Owner(state, J.Get(reservation, "actor"))
        } catch (error CliFailure) {
            if error.Code != "stale_approval" {
                throw error
            }
        }
    }

    private func Draft(
        repo string,
        issue int32,
        pull JsonElement,
        state CoordinationState,
        approval JsonElement,
        policy JsonElement,
        drafts List[Object],
        approvalSha string
    ) {
        let number = J.Number(pull, "number")
        let head = J.Get(pull, "head")
        let base = J.Get(pull, "base")
        if number < 1 || !RepositoryIdentity.SameRepo(J.Text(J.Get(base, "repo"), "full_name"), repo) ||
            RepositoryIdentity.PositiveId(J.Get(J.Get(base, "repo"), "id")) != RepositoryIdentity.PositiveId(
            J.Get(Info, "id")
        ) {
            throw Exception("Canonical PR upstream identity differs")
        }
        let sha = RepositoryIdentity.CommitSha(J.Text(head, "sha"))
        let draft = map[string, Object?]{
            "pr": number,
            "url": J.Text(pull, "html_url"),
            "head": sha,
            "state": J.Text(pull, "state"),
            "draft": J.Bool(pull, "draft"),
            "binding": "unknown",
            "receipt": "incomplete",
            "checks_status": "unknown",
            "review_status": "unknown",
            "next": Next("owner", "Inspect the PR and its current binding.", View(repo, number))
        }
        drafts.Add(draft)
        var bound bool
        if state.Sha != "" {
            bound = Admission.DonorBinding(repo, pull, state, requireLease: false).ValueKind == JsonValueKind.Object
        } else {
            let owner = J.Get(J.Get(head, "repo"), "owner")
            let donor = RepositoryIdentity.Login(J.Text(approval, "donor"))
            bound = J.Text(base, "ref") == J.Text(approval, "base_branch") && J.Text(head, "ref") == "tokate/issue-" +
                issue.ToString() + "-" + approvalSha.Substring(0, 12) && String.Equals(
                J.Text(owner, "login"),
                donor,
                StringComparison.OrdinalIgnoreCase
            )
            if bound {
                let actor = J.Get(GitHub.Api("users/" + donor), "id")
                let fork = RepositoryIdentity.Repo(J.Text(J.Get(head, "repo"), "full_name"))
                let live = GitHub.Api("repos/" + fork)
                RepositoryAccess.ValidateRepository(repo, fork, actor, live, push: false, upstream: Info)
                bound = RepositoryIdentity.PositiveId(J.Get(owner, "id")) == RepositoryIdentity.PositiveId(actor) &&
                    RepositoryIdentity.PositiveId(J.Get(live, "id")) == RepositoryIdentity.PositiveId(
                    J.Get(J.Get(head, "repo"), "id")
                ) &&
                    GitHub.Branch(fork, J.Text(head, "ref")) == J.Text(head, "sha")
            }
        }
        draft["binding"] = bound ? "canonical": "mismatch"
        if !bound {
            return
        }
        try {
            let receipt = PrBody.Receipt(J.Text(pull, "body"))
            let version = state.Sha == "" ? 1: 2
            var complete = J.Number(receipt, "version") == version && RepositoryIdentity.SameRepo(
                J.Text(receipt, "repo"),
                repo
            ) &&
                J.Number(receipt, "issue") == issue && J.Text(receipt, "head") == sha
            for key in(
                version == 2 ? []string{"approval", "expected", "reservation", "donor"}: []string{
                    "approval",
                    "donor",
                    "model",
                    "effort",
                    "policy"
                }
            ) {
                complete = complete && J.Text(receipt, key) != ""
            }
            if complete && (version == 1 || J.Get(state.Value(), "contribution").ValueKind == JsonValueKind.Object) {
                draft["receipt"] = "unverified; completed-work readiness requires receipt verification and owner review"
            }
        } catch { }
        if policy.ValueKind == JsonValueKind.Object {
            Observe(draft, "checks", async () -> CheckHead(repo, sha, policy, draft))
        } else {
            draft[
                "checks_reason"
            ] = "Current required-check policy is unknown because approval is stale or unavailable."
        }
        Observe(draft, "review", async () -> Reviews(repo, number, sha, draft))
        Observe(
            draft,
            "remote",
            async () -> {
                let latest = GitHub.Api("repos/" + repo + "/pulls/" + number.ToString())
                if J.Text(J.Get(latest, "head"), "sha") != sha || J.Text(J.Get(latest, "base"), "ref") != J.Text(
                    base,
                    "ref"
                ) ||
                    J.Text(latest, "state") != J.Text(pull, "state") || J.Bool(latest, "draft") != J.Bool(
                    pull,
                    "draft"
                ) {
                    draft["remote_status"] = "stale"
                } else {
                    draft["remote_status"] = "observed"
                }
            }
        )
    }

    private func CheckHead(repo string, head string, policy JsonElement, draft Dictionary[string, Object?]) {
        let observed = List[Object]()
        draft["checks"] = observed
        draft["checks_head"] = head
        let checks = CommitChecks.Read(repo, head, observed)
        let required = List[Object]()
        var failed bool
        var pending bool
        for check in J.Items(checks) {
            if J.Text(check, "state") == "ACTION_REQUIRED" {
                draft["owner_inspection_required"] = true
            }
            let bucket = J.Text(check, "state") == "ACTION_REQUIRED" ? "blocked": J.Text(check, "bucket")
            failed = failed || bucket == "fail" || bucket == "cancel"
            pending = pending || (bucket != "pass" && bucket != "skipping" && bucket != "fail" && bucket != "cancel")
        }
        for name in J.Items(J.Get(policy, "required_checks")) {
            var status = "missing"
            for check in J.Items(checks) {
                if J.Text(check, "name") != name.GetString() {
                    continue
                }
                let bucket = J.Text(check, "state") == "ACTION_REQUIRED" ? "blocked": J.Text(check, "bucket")
                if bucket == "fail" || bucket == "cancel" {
                    status = "failed"
                    break
                }
                if bucket == "blocked" {
                    status = "blocked"
                } else if status != "blocked" {
                    status = bucket == "pass" ? "passed": "pending"
                }
            }
            failed = failed || status == "failed"
            pending = pending || status == "pending" || status == "missing"
            required.Add(
                map[string, Object?]{
                    "name": PublicOutput.Prose(name.GetString() ?? "", ref Truncated),
                    "status": status
                }
            )
        }
        draft["checks_status"] = failed ? "failed": (
            Text(draft, "owner_inspection_required") == "True" ? "blocked": (pending ? "pending": "passed")
        )
        draft["required_checks"] = required
        let displayed = List[Object]()
        for check in J.Items(checks) {
            if displayed.Count == 16 {
                draft["checks_truncated"] = true
                Truncated = true
                break
            }
            displayed.Add(
                map[string, Object?]{
                    "name": PublicOutput.Prose(J.Text(check, "name"), ref Truncated),
                    "state": J.Text(check, "state"),
                    "bucket": J.Text(check, "state") == "ACTION_REQUIRED" ? "blocked": J.Text(check, "bucket"),
                    "link": J.Text(check, "link")
                }
            )
        }
        draft["checks"] = displayed
        draft["checks_head"] = head
        draft["workflow_wait_reason"] = "unknown; check status alone does not identify fork-workflow approval waiting"
    }

    private func Reviews(repo string, pr int32, head string, draft Dictionary[string, Object?]) {
        let reviews = GitHub.Api("repos/" + repo + "/pulls/" + pr.ToString() + "/reviews?per_page=30&page=1")
        if reviews.ValueKind != JsonValueKind.Array || reviews.GetArrayLength() > 30 {
            throw Exception("Cannot read bounded PR reviews")
        }
        let current = Dictionary[string, string]()
        for review in J.Items(reviews) {
            if J.Text(review, "commit_id") == head {
                let reviewer = J.Text(J.Get(review, "user"), "login")
                let reviewState = J.Text(review, "state")
                if (reviewState == "COMMENTED" || reviewState == "PENDING") && current.ContainsKey(reviewer) {
                    continue
                }
                current[reviewer] = reviewState
            }
        }
        let rows = List[Object]()
        var approved bool
        var changes bool
        for reviewer in current.Keys {
            rows.Add(map[string, Object?]{"reviewer": reviewer, "state": current[reviewer]})
            approved = approved || current[reviewer] == "APPROVED"
            changes = changes || current[reviewer] == "CHANGES_REQUESTED"
        }
        draft["reviews"] = rows
        draft["review_status"] = reviews.GetArrayLength() == 30 ? "unknown": (
            changes ? "changes_requested": (approved ? "approval_recorded": "owner_review_required")
        )
        draft["review_evidence"] = "GitHub reviews on the observed head; owner acceptance is not verified"
        if reviews.GetArrayLength() == 30 {
            draft["reviews_truncated"] = true
            Truncated = true
        }
    }

    private func ActionFor(repo string, row Dictionary[string, Object?], drafts List[Object], state CoordinationState) {
        var stage = "approval_waiting"
        var next = Next(
            "owner",
            "Approve again under the current policy; required donor and target selections must be supplied."
        )
        if Text(row, "approval_status") == "current" {
            if state.Sha == "" {
                stage = "donor_work"
                next = Next(
                    "donor",
                    "The assigned donor must select tools and a budget for a claim, or inspect their own saved work; no local run is known."
                )
            } else if Text(row, "eligibility_status") == "eligible" ||
                (Text(row, "eligibility_status") == "access_waiting" && J.Bool(J.Get(Info, "permissions"), "push")) {
                stage = "reservation_needed"
                next = Next(
                    "donor",
                    Text(row, "eligibility_status") == "eligible" ?
                    "Create a claim request file using the observed coordination state; a request file and work selections are still required.":
                    "An eligible donor must select the task and prepare a claim request. Inspect access grants if no donor is eligible."
                )
            } else {
                stage = "access_waiting"
                next = Next(
                    "owner",
                    "Review donor access and grant eligibility if appropriate.",
                    []string{"tokate", "access", "--repo", repo, "--operation", "list", "--issue", Text(row, "issue")}
                )
            }
            let approval = J.Get(state.Value(), "approval")
            if state.Sha != "" && !AccessState.Task(approval) && Text(row, "eligibility_status") != "eligible" {
                stage = "assigned_donor"
                next = Next(
                    "donor",
                    "The assigned donor must claim or inspect their saved work; the viewing account is not assigned."
                )
            } else if stage == "access_waiting" && Text(row, "viewer_denied") != "True" && !J.Bool(
                J.Get(Info, "permissions"),
                "push"
            ) {
                var requested bool
                for request in Requests {
                    requested = requested ||
                        (
                        J.Number(request, "issue") == Int32.Parse(Text(row, "issue")) && RepositoryIdentity.PositiveId(
                            J.Get(request, "actor")
                        ) == RepositoryIdentity.PositiveId(J.Get(Viewer, "id"))
                    )
                }
                if !requested {
                    next = Next(
                        "donor",
                        "Request owner review for the required donor access.",
                        []string{
                            "tokate",
                            "access",
                            "--repo",
                            repo,
                            "--operation",
                            "request",
                            "--issue",
                            Text(row, "issue"),
                            "--scope",
                            J.Text(approval, "eligibility") == "trusted" ? "trust": "issue"
                        }
                    )
                }
            }
            let reservation = J.Get(state.Value(), "reservation")
            if reservation.ValueKind == JsonValueKind.Object && J.Text(reservation, "status") != "released" &&
                CoordinationState.Unix(reservation, "expires") > DateTimeOffset.UtcNow.ToUnixTimeSeconds() {
                stage = J.Text(reservation, "status") == "paused" ? "paused": (
                    J.Text(reservation, "attempt") == "" ? "reservation_held": "attempt_recorded"
                )
                next = Next(
                    "donor",
                    "The recorded donor must inspect their own saved work; the local run directory and process state are unknown."
                )
            } else if reservation.ValueKind == JsonValueKind.Object {
                stage = "lease_expired_or_released"
                next = Next(
                    "donor",
                    "Create a fresh claim request if eligible; a request file is required and saved-work continuation is a separate operation."
                )
            }
            if Text(row, "holder_eligible") == "False" {
                stage = "access_waiting"
                next = Next(
                    "owner",
                    "Restore eligibility for the recorded donor before further work or publication.",
                    []string{"tokate", "access", "--repo", repo, "--operation", "list", "--issue", Text(row, "issue")}
                )
            }
            for item in drafts {
                let draft = item as Dictionary[string, Object?] ?? throw Exception("Invalid status draft")
                var draftNext = Next(
                    "owner",
                    "Inspect the PR and Actions links.",
                    View(repo, Int32.Parse(Text(draft, "pr")))
                )
                if Text(draft, "binding") != "canonical" {
                    stage = "binding_mismatch"
                } else if Text(draft, "remote_status") == "stale" {
                    stage = "stale_remote_data"
                } else if Text(draft, "checks_status") == "blocked" {
                    stage = "ci_blocked"
                    draftNext = Next(
                        "owner",
                        "GitHub reports action_required without an approval reason; inspect the linked PR or Actions run.",
                        View(repo, Int32.Parse(Text(draft, "pr")))
                    )
                } else if Text(draft, "checks_status") == "failed" {
                    stage = "ci_failed"
                    draftNext = Next(
                        "donor",
                        "Inspect failed checks and repair the contribution using the donor's own saved work.",
                        View(repo, Int32.Parse(Text(draft, "pr")))
                    )
                    if Text(draft, "owner_inspection_required") == "True" {
                        draftNext = Next(
                            "owner",
                            "GitHub reports action_required without an approval reason; inspect the linked PR or Actions run.",
                            View(repo, Int32.Parse(Text(draft, "pr")))
                        )
                    }
                } else if Text(draft, "checks_status") == "pending" {
                    stage = "ci_pending"
                    draftNext = Next(
                        "owner",
                        "CI is pending or required checks are missing; inspect the PR or linked Actions run for the reason.",
                        View(repo, Int32.Parse(Text(draft, "pr")))
                    )
                } else if Text(draft, "review_status") == "changes_requested" {
                    stage = "review_changes_requested"
                    draftNext = Next(
                        "donor",
                        "Address the recorded review changes using the donor's own saved work.",
                        View(repo, Int32.Parse(Text(draft, "pr")))
                    )
                } else if Text(draft, "receipt") == "incomplete" {
                    stage = "incomplete_draft"
                    draftNext = Next(
                        "donor",
                        "Complete the contribution and receipt using the donor's own saved work; its run directory is unknown."
                    )
                } else {
                    stage = "owner_review"
                    draftNext = Next(
                        "owner",
                        "Verify the recorded receipt before reviewing acceptance; status does not establish readiness.",
                        []string{"tokate", "verify-pr", "--repo", repo, "--pr", Text(draft, "pr")}
                    )
                }
                if Text(draft, "checks_status") == "unavailable" ||
                    Text(draft, "review_status") == "unavailable" ||
                    Text(draft, "remote_status") == "unavailable" {
                    stage = "unavailable"
                    draftNext = Next(
                        "owner",
                        "Inspect unavailable PR or Actions data before proceeding.",
                        View(repo, Int32.Parse(Text(draft, "pr")))
                    )
                }
                draft["next"] = draftNext
                next = draftNext
            }
        }
        if Text(row, "approval_status") == "unavailable" ||
            Text(row, "coordination_status") == "unavailable" ||
            Text(row, "eligibility_status") == "unavailable" ||
            Text(row, "drafts_status") == "unavailable" ||
            Text(row, "remote_status") == "unavailable" {
            stage = "unavailable"
            next = Next("owner", "Inspect unavailable remote records before proceeding.")
        } else if Text(row, "remote_status") == "stale" {
            stage = "stale_remote_data"
            next = Next(
                "owner",
                "Refresh contribution status; the authority changed during this read.",
                []string{"tokate", "status", "--repo", repo, "--issue", Text(row, "issue")}
            )
        }
        row["state"] = stage
        row["next"] = next
    }

    private func Read(args Args) {
        let repo = RepositoryIdentity.Repo(args.Need("repo"))
        let issue = args.Get("issue") == "" ? 0: args.Number("issue")
        Result["repo"] = repo
        Result["remote_status"] = "unknown"
        Result["work"] = Work
        Result["discovery_limit"] = 20
        Result["next"] = Next("owner", "Inspect unavailable remote records.")
        if !Observe(
            Result,
            "repository",
            async () -> {
                Info = GitHub.Api("repos/" + repo)
                RepositoryIdentity.PositiveId(J.Get(Info, "id"))
                if !RepositoryIdentity.SameRepo(J.Text(Info, "full_name"), repo) {
                    throw Exception("Repository identity changed")
                }
                Result["repository_status"] = "observed"
            }
        ) {
            return
        }
        Observe(
            Result,
            "viewer",
            async () -> {
                Viewer = GitHub.Api("user")
                Result["viewer"] = map[string, Object?]{
                    "donor": RepositoryIdentity.Login(J.Text(Viewer, "login")),
                    "actor": RepositoryIdentity.PositiveId(J.Get(Viewer, "id")),
                    "role": J.Bool(J.Get(Info, "permissions"), "push") ? "owner": "donor"
                }
                Result["viewer_status"] = "observed"
            }
        )
        Observe(
            Result,
            "access",
            async () -> {
                Access = AccessState.Load(repo, RepositoryIdentity.PositiveId(J.Get(Info, "id")), missing: true)
                Result["access_status"] = Access?.Sha == "" ? "absent": "observed"
                Result["access_sha"] = Access?.Sha
            }
        )
        let pending = Requests
        if Access != nil {
            Observe(
                Result,
                "requests",
                async () -> {
                    Result["requests_truncated"] = AccessState.Pending(
                        repo,
                        Access ?? throw Exception("Missing access"),
                        pending,
                        issue,
                        bounded: true
                    )
                    Result["requests_status"] = "observed"
                }
            )
        } else {
            Result["requests_status"] = "unknown"
        }
        let displayed = List[Object]()
        for request in pending {
            if displayed.Count == 20 {
                Result["requests_truncated"] = true
                break
            }
            let row = PublicOutput.Select(request, "comment,actor,donor,issue,scope")
            row["next"] = AccessReview(repo, J.Number(request, "issue").ToString())
            displayed.Add(row)
        }
        Result["pending_requests"] = displayed
        Result["pending_requests_observed"] = pending.Count
        if Text(Result, "requests_truncated") == "True" {
            Truncated = true
        }
        Observe(
            Result,
            "discovery",
            async () -> {
                if issue != 0 {
                    Issue(repo, GitHub.Issue(repo, issue))
                } else {
                    let issues = GitHub.Api(
                        "repos/" +
                            repo +
                            "/issues?state=open&labels=tokate%3Aapproved&sort=updated&direction=desc&per_page=20&page=1"
                    )
                    if issues.ValueKind != JsonValueKind.Array || issues.GetArrayLength() > 20 {
                        throw Exception("Cannot read bounded approved-work issues")
                    }
                    Result["discovery_truncated"] = issues.GetArrayLength() == 20
                    Truncated = Truncated || issues.GetArrayLength() == 20
                    for task in J.Items(issues) {
                        if J.Get(task, "pull_request").ValueKind != JsonValueKind.Undefined || J.Text(
                            task,
                            "state"
                        ) != "open" ||
                            !GitHub.HasLabel(task) {
                            continue
                        }
                        let row = Issue(repo, task)
                        if Text(row, "approval_status") == "absent" {
                            Work.Remove(row)
                        }
                    }
                }
                Result["discovery_status"] = "observed"
            }
        )
        if Access != nil {
            Observe(
                Result,
                "access",
                async () -> {
                    let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/tokate/access", missing: true)
                    if J.Text(J.Get(reference, "object"), "sha") != Access?.Sha {
                        Result["access_status"] = "stale"
                        Result["requests_status"] = "stale"
                        for item in Work {
                            let row = item as Dictionary[string, Object?] ?? throw Exception("Invalid status work")
                            row["eligibility_status"] = "stale"
                            row["state"] = "stale_remote_data"
                            row["next"] = Next(
                                "owner",
                                "Refresh status; donor access changed during this read.",
                                []string{"tokate", "status", "--repo", repo, "--issue", Text(row, "issue")}
                            )
                        }
                    }
                }
            )
        }
        var stale = Text(Result, "access_status") == "stale"
        for item in Work {
            let row = item as Dictionary[string, Object?] ?? throw Exception("Invalid status work")
            stale = stale || Text(row, "remote_status") == "stale" || Text(row, "state") == "stale_remote_data"
        }
        Result["remote_status"] = Failure != nil ? "unavailable": (stale ? "stale": "observed")
        Result["truncated"] = Truncated
        Result["next"] = displayed.Count > 0 ? (displayed[0] as Dictionary[string, Object?])?["next"]: (
            Work.Count > 0 ? (Work[0] as Dictionary[string, Object?])?["next"]: Next(
                "owner",
                "No approved work was observed within the bounded index."
            )
        )
    }

    private func BoundOutput() {
        Result["work_observed"] = Work.Count
        for item in Work {
            let row = item as Dictionary[string, Object?] ?? throw Exception("Invalid status row")
            if row.ContainsKey("drafts") && row["drafts"] is List[Object]drafts {
                for item in drafts {
                    let draft = item as Dictionary[string, Object?] ?? throw Exception("Invalid status draft")
                    if draft.ContainsKey("checks") && draft["checks"] is List[Object]checks && checks.Count > 16 {
                        draft["checks_observed"] = checks.Count
                        checks.RemoveRange(16, checks.Count - 16)
                        draft["checks_truncated"] = true
                        Truncated = true
                    }
                }
            }
        }
        while System.Text.Encoding.UTF8.GetByteCount(J.Write(Result)) > 56000 && Work.Count > 0 {
            Work.RemoveAt(Work.Count - 1)
            Result["presentation_truncated"] = true
            Truncated = true
        }
    }

    private func Text(value Dictionary[string, Object?], key string) string -> value.ContainsKey(key) ? value[
        key
    ]?.ToString() ?? "": ""

    shared {
        internal func Snapshot(args Args) ContributionStatus {
            let status = ContributionStatus()
            try {
                status.Read(args)
            } catch (error Exception) {
                status.Failure = status.Failure ?? error
            }
            if status.Failure != nil {
                status.Result["remote_status"] = "unavailable"
                status.Result["next"] = status.Next(
                    "owner",
                    "Inspect unavailable required remote records before proceeding."
                )
            }
            status.BoundOutput()
            status.Result["truncated"] = status.Truncated
            return status
        }

        internal func Run(args Args) {
            let status = Snapshot(args)
            PublicOutput.ResultData = status.Result
            PublicOutput.Truncated = status.Truncated
            PublicOutput.Actions.Clear()
            if status.Result.ContainsKey("next") &&
                status.Result["next"] is Dictionary[string, Object?]next &&
                next["command"] is []string command &&
                command.Length > 0 {
                PublicOutput.Actions.Add(command)
            }
            if !PublicOutput.Enabled {
                Terminal.ContributionStatus(J.Parse(J.Write(status.Result)))
            }
            if let failure = status.Failure {
                throw failure
            }
        }
    }
}
