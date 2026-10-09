package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class Checks {
    shared {
        private let BindingFields string = "version,issue,approval,authority_revision,donor,base,base_branch,commit,expected,reservation,receipt_hash,policy_hash"
        private let Review string = "Review implementation scope, acceptance criteria, semantic compatibility and limitations; decide final acceptance and merge. Machine checks do not accept or complete the issue or remove draft status."
        private let ReportAction string = "Require a current public change and verification report bound to this exact commit; publication may preserve the work as a draft."

        private func Identity(pull JsonElement) string {
            let result = J.Select(pull, "state,draft,merged,merged_at,closed_at")
            result["head"] = J.Select(J.Get(pull, "head"), "sha,ref")
            result["head_repo"] = J.Select(J.Get(J.Get(pull, "head"), "repo"), "id,full_name")
            result["base"] = J.Select(J.Get(pull, "base"), "sha,ref")
            result["base_repo"] = J.Select(J.Get(J.Get(pull, "base"), "repo"), "id,full_name")
            result["author"] = J.Select(J.Get(pull, "user"), "id,login")
            result["body_hash"] = Data.Hash(J.Text(pull, "body"))
            return J.Write(result)
        }

        private func ObserveAfter(pull JsonElement, facts Dictionary[string, Object?]) {
            facts["observed_head_after"] = J.Text(J.Get(pull, "head"), "sha")
            facts["target_branch_after"] = J.Text(J.Get(pull, "base"), "ref")
            facts["pr_observation_after"] = J.Select(pull, "state,draft,merged,merged_at,closed_at")
            if J.Text(pull, "state") == "closed" || J.Bool(pull, "merged") || J.Get(pull, "merged_at")
                .ValueKind == JsonValueKind.String {
                facts["owner_review"] = "historical"
                facts["required_owner_actions"] = []string{}
            } else {
                facts["owner_review"] = "required"
            }
        }

        private func Invalidate(gates Dictionary[string, Object?], facts Dictionary[string, Object?]) {
            for name in[]string{"receipt", "report", "checks", "dependencies", "lifecycle"} {
                let gate = gates[name] as Dictionary[string, Object?] ?? throw Exception("Invalid check gate")
                let status = gate["status"]?.ToString() ?? "unread"
                if status == "passed" || status == "failed" || status == "pending" {
                    gate["observed_status"] = status
                    gate["status"] = "stale"
                }
            }
            facts["checks_observed_status"] = facts["checks_status"]
            if facts["checks_status"]?.ToString() != "unread" {
                facts["checks_status"] = "stale"
            }
        }

        private func Show(
            run Data,
            observed List[Object],
            facts Dictionary[string, Object?],
            directory string,
            ref previous string
        ) {
            PublicOutput.Checks(run, J.Parse(J.Write(observed)), facts["checks_status"]?.ToString() ?? "unread", facts)
            let snapshot = J.Write(
                map[string, Object?]{
                    "head": run.Text("commit"),
                    "status": facts["checks_status"],
                    "checks": observed,
                    "result": PublicOutput.ResultData
                }
            )
            if snapshot == previous {
                return
            }
            if directory != "" {
                let path = Path.Combine(directory, "checks.json")
                if !File.Exists(path) || File.ReadAllText(path) != snapshot {
                    File.WriteAllText(path, snapshot)
                }
            }
            previous = snapshot
            let status = facts["checks_status"]?.ToString() ?? "unread"
            let machine = facts["machine_status"]?.ToString() ?? "pending"
            Terminal.Message(
                "Machine gates " + machine,
                machine == "passed" ? "green": (machine == "failed" ? "red": "yellow")
            )
            Terminal.Message("Checks " + status + ": " + run.Text("pr_url"), status == "passed" ? "green": "yellow")
            if !PublicOutput.Enabled {
                Terminal.Checks(J.Get(J.Parse(J.Write(PublicOutput.ResultData ?? map[string, Object?]{})), "checks"))
                Terminal.Json(J.Parse(J.Write(facts)), "Check gates and required owner actions")
            }
        }

        internal func Run(args Args) int32 {
            ApiTransport.BeginDeadline(args.Number("timeout", "1200"))
            try {
                return ChecksWithinDeadline(args)
            } catch (error ApiDeadlineException) {
                Terminal.Message(error.Message, "yellow")
                return 8
            } finally {
                ApiTransport.EndDeadline()
            }
        }

        private func ChecksWithinDeadline(args Args) int32 {
            let directory = args.Get("run") == "" ? "": Path.GetFullPath(args.Need("run"))
            var run = directory == "" ? Data(): Data.Load(directory)
            if directory == "" {
                run.Fields["repo"] = RepositoryIdentity.Repo(args.Need("repo"))
                run.Fields["pr"] = args.Number("pr")
            }
            if run.Number("pr") == 0 {
                throw Exception("No PR has been published for this run")
            }
            var previous string = ""
            var binding string = ""
            var identity string = ""
            var target string = ""
            while true {
                let gates = map[string, Object?]{}
                for name in[]string{"lifecycle", "receipt", "report", "checks", "dependencies", "freshness"} {
                    gates[name] = map[string, Object?]{"status": "unread"}
                }
                let facts = map[string, Object?]{
                    "gates": gates,
                    "machine_status": "pending",
                    "checks_status": "unread",
                    "owner_review": "unavailable",
                    "required_owner_actions": []string{"Inspect unavailable PR evidence before acceptance."},
                    "local_verification": "donor_reported_not_remotely_attested",
                    "owner_inspection_required": false,
                    "action_required_cause": "unknown"
                }
                let observed = List[Object]()
                var stage = "lifecycle"
                try {
                    ApiTransport.CheckDeadline()
                    let pullPath = "repos/" + run.Text("repo") + "/pulls/" + run.Number("pr").ToString()
                    let pull = GitHub.Api(pullPath)
                    facts["pr_observation"] = J.Select(pull, "state,draft,merged,merged_at,closed_at")
                    facts["observed_head"] = J.Text(J.Get(pull, "head"), "sha")
                    run.Fields["pr_url"] = J.Text(pull, "html_url")
                    let isOpen = J.Text(pull, "state") == "open" && !J.Bool(pull, "merged") &&
                        (
                        J.Get(pull, "merged_at").ValueKind == JsonValueKind.Undefined || J.Get(pull, "merged_at")
                            .ValueKind == JsonValueKind.Null
                    )
                    let historical = J.Text(pull, "state") == "closed" || J.Bool(pull, "merged") || J.Get(
                        pull,
                        "merged_at"
                    )
                        .ValueKind == JsonValueKind.String
                    facts["owner_review"] = isOpen ? "required": (historical ? "historical": "unavailable")
                    facts["required_owner_actions"] = isOpen ? []string{Review}: (
                        historical ? []string{}: []string{
                            "Inspect unavailable PR lifecycle evidence before acceptance."
                        }
                    )
                    gates["lifecycle"] = map[string, Object?]{
                        "status": isOpen ? "passed": (historical ? "failed": "unavailable")
                    }
                    if !isOpen {
                        throw CliFailure(
                            "invalid_state",
                            "PR is not an open, unmerged contribution awaiting owner review"
                        )
                    }
                    if identity != "" && Identity(pull) != identity {
                        stage = "freshness"
                        throw CliFailure(
                            "stale_approval",
                            "PR head, target, receipt or lifecycle changed while reading checks"
                        )
                    }
                    stage = "freshness"
                    let branch = J.Text(J.Get(pull, "base"), "ref")
                    let currentTarget = GitHub.Branch(run.Text("repo"), branch)
                    facts["target_branch"] = branch
                    facts["target_revision"] = currentTarget
                    if target != "" && target != currentTarget {
                        throw CliFailure("stale_approval", "PR target revision changed while reading checks")
                    }
                    stage = "receipt"
                    let verified = ReceiptVerification.Verify(run.Text("repo"), run.Number("pr"), pull)
                    if run.Text("commit") != "" && verified.Text("commit") != run.Text("commit") {
                        throw CliFailure("stale_approval", "Saved commit differs from PR receipt")
                    }
                    run = verified
                    let currentBinding = J.Write(J.Select(run.Element(), BindingFields))
                    facts["binding"] = J.Select(run.Element(), BindingFields)
                    gates["receipt"] = map[string, Object?]{"status": "passed"}
                    stage = "freshness"
                    if binding != "" && binding != currentBinding || J.Text(J.Get(pull, "head"), "sha") != run.Text(
                        "commit"
                    ) {
                        throw CliFailure("stale_approval", "PR authority changed while reading checks")
                    }
                    binding = currentBinding
                    identity = Identity(pull)
                    target = currentTarget
                    stage = "report"
                    var reportFailure string = ""
                    try {
                        PublicSummary.Current(
                            PrBody.ReportText(J.Text(pull, "body")),
                            J.Get(run.Element(), "public_summary"),
                            run.Text("commit"),
                            run.Text("public_report")
                        )
                        gates["report"] = map[string, Object?]{"status": "passed", "evidence": "complete"}
                    } catch (error Exception) {
                        reportFailure = error.Message
                        gates["report"] = map[string, Object?]{
                            "status": "failed",
                            "reason": "missing_or_altered_public_report"
                        }
                    }
                    stage = "checks"
                    let rows = CommitChecks.Read(run.Text("repo"), run.Text("commit"), observed)
                    var failed bool
                    var pending bool
                    var inspection bool
                    for row in J.Items(rows) {
                        let bucket = J.Text(row, "bucket")
                        failed = failed || bucket == "fail" || bucket == "cancel"
                        pending = pending ||
                            (bucket != "pass" && bucket != "skipping" && bucket != "fail" && bucket != "cancel")
                        inspection = inspection || J.Text(row, "state") == "ACTION_REQUIRED"
                    }
                    let required = List[Object]()
                    let names = J.Items(J.Get(J.Get(run.Element(), "policy"), "required_checks"))
                    for name in names {
                        var found bool
                        var passed bool = true
                        var conflicting bool
                        var success bool
                        var nameFailed bool
                        for row in J.Items(rows) {
                            if J.Text(row, "name") == name.GetString() {
                                found = true
                                success = success || J.Text(row, "bucket") == "pass"
                                passed = passed && J.Text(row, "bucket") == "pass"
                                nameFailed = nameFailed || J.Text(row, "bucket") == "fail" || J.Text(
                                    row,
                                    "bucket"
                                ) == "cancel"
                            }
                        }
                        conflicting = success && !passed
                        pending = pending || !found || !passed
                        if required.Count < 64 {
                            required.Add(
                                map[string, Object?]{
                                    "name": name,
                                    "status": !found ? "missing": (
                                        conflicting ? "conflicting": (
                                            passed ? "passed": (nameFailed ? "failed": "pending")
                                        )
                                    )
                                }
                            )
                        } else {
                            PublicOutput.Truncated = true
                        }
                    }
                    let status = failed ? "failed": (pending ? "pending": "passed")
                    facts["checks_status"] = status
                    facts["required_checks"] = required
                    facts["required_check_count"] = names.Count
                    facts["owner_inspection_required"] = inspection
                    if inspection {
                        facts["required_owner_actions"] = []string{
                            "Inspect the PR and linked Actions runs for action_required; the cause is unknown. Approve a fork workflow only after explicit approval evidence and diff inspection.",
                            Review
                        }
                    }
                    gates["checks"] = map[string, Object?]{"status": status, "evidence": "complete"}
                    if !failed && !pending {
                        stage = "dependencies"
                        let dependencies = Dictionary[string, Object?]()
                        facts["dependency_evidence"] = dependencies
                        Overlaps.DependencyEvidence(run.Text("repo"), run.Number("issue"), dependencies)
                        let known = dependencies["dependencies_status"]?.ToString() == "complete"
                        let passed = known && dependencies["dependency_gate"]?.ToString() == "no_open_dependencies"
                        gates["dependencies"] = map[string, Object?]{
                            "status": passed ? "passed": (known ? "failed": "unavailable")
                        }
                        Overlaps.RequireDependencies(run.Text("repo"), run.Number("issue"), dependencies)
                    }
                    stage = "freshness"
                    let livePull = GitHub.Api(pullPath)
                    ObserveAfter(livePull, facts)
                    let live = ReceiptVerification.Verify(run.Text("repo"), run.Number("pr"), livePull)
                    facts["binding_after"] = J.Select(live.Element(), BindingFields)
                    if J.Write(J.Select(live.Element(), BindingFields)) != binding {
                        throw CliFailure("stale_approval", "PR authority changed while reading checks")
                    }
                    let finalPull = GitHub.Api(pullPath)
                    ObserveAfter(finalPull, facts)
                    if Identity(livePull) != identity || Identity(finalPull) != identity {
                        throw CliFailure(
                            "stale_approval",
                            "PR head, target, receipt or lifecycle changed while reading checks"
                        )
                    }
                    let liveTarget = GitHub.Branch(run.Text("repo"), run.Text("base_branch"))
                    facts["target_revision_after"] = liveTarget
                    if liveTarget != target {
                        throw CliFailure("stale_approval", "PR target revision changed while reading checks")
                    }
                    ApiTransport.CheckDeadline()
                    gates["freshness"] = map[string, Object?]{"status": "passed"}
                    if reportFailure != "" && !pending {
                        stage = "report"
                        throw CliFailure("invalid_state", reportFailure)
                    }
                    facts["machine_status"] = status
                    if reportFailure != "" {
                        facts["required_owner_actions"] = []string{ReportAction, Review}
                    }
                    Show(run, observed, facts, directory, ref previous)
                    if failed {
                        return 1
                    }
                    if !pending {
                        return 0
                    }
                    if args.Get("watch") != "true" {
                        return 8
                    }
                } catch (error Exception) {
                    if previous != "" {
                        facts["previous_observation"] = map[string, Object?]{
                            "current": false,
                            "result": J.Get(J.Parse(previous), "result")
                        }
                    }
                    let timedOut = error is ApiDeadlineException deadline
                    let unavailable = timedOut ||
                        error is CliFailure transport &&
                        (transport.Code == "command_failed" || transport.Code == "authentication_required")
                    let stale = error is CliFailure failure &&
                        failure.Code == "stale_approval" ||
                        stage == "freshness" &&
                        !unavailable
                    let gate = gates[stage] as Dictionary[string, Object?] ?? throw Exception("Invalid check gate")
                    if gate["status"]?.ToString() == "unread" || stage == "freshness" {
                        gate["status"] = stale ? "stale": (unavailable || stage == "checks" ? "unavailable": "failed")
                    }
                    gate["reason"] = timedOut ? "deadline": (
                        stale ? "changed_authority_or_identity": "evidence_blocked_or_unavailable"
                    )
                    if stage == "freshness" || stale {
                        Invalidate(gates, facts)
                    }
                    facts["machine_status"] = timedOut ? "pending": "failed"
                    if stage == "checks" {
                        facts["checks_status"] = stale ? "stale": "unavailable"
                        gate["evidence"] = stale ? "stale": (observed.Count > 0 ? "incomplete": "unavailable")
                    }
                    if facts["owner_review"]?.ToString() == "required" {
                        let action = stage == "dependencies" ? "Inspect native dependencies; every dependency must be closed as completed before machine success.": (
                            stage == "checks" ? "Inspect incomplete or unavailable exact-head CI evidence before acceptance.": (
                                stage == "report" ? ReportAction:
                                "Inspect current approval, receipt, protected paths, PR head, target and lifecycle evidence before acceptance."
                            )
                        )
                        facts["required_owner_actions"] = []string{action, Review}
                        for row in observed {
                            if J.Text(J.Parse(J.Write(row)), "state") == "ACTION_REQUIRED" {
                                facts["owner_inspection_required"] = true
                                facts["required_owner_actions"] = []string{
                                    "Inspect the PR and linked Actions runs for action_required; the cause is unknown. Approve a fork workflow only after explicit approval evidence and diff inspection.",
                                    action,
                                    Review
                                }
                                break
                            }
                        }
                    }
                    Show(run, observed, facts, directory, ref previous)
                    throw error
                }
                ApiTransport.PollWait()
            }
        }
    }
}
