package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class Amendment {
    shared {
        internal func Tools(policy Policy, tools JsonElement) {
            if tools.ValueKind != JsonValueKind.Array {
                throw Exception("Amendment tools must be an array; [] declares manual editing")
            }
            if J.Items(tools).Count == 0 {
                return
            }
            RequestData.Tools(tools)
            if J.Number(policy.Value, "version") == 2 {
                policy.ValidateTools(tools)
                return
            }
            for tool in J.Items(tools) {
                if J.Text(tool, "harness") != "codex" || J.Text(tool, "provider") != "openai" {
                    throw Exception("Version-1 amendments permit only declared codex/openai tools")
                }
                policy.Validate(J.Text(tool, "model"), J.Text(tool, "effort"), 1, false)
            }
        }

        internal func ValidateReceipt(value JsonElement, policy Policy) {
            RequestData.Keys(value, "id,previous,seconds,tools")
            var id Guid
            if !Guid.TryParseExact(J.Text(value, "id"), "D", out id) || J.Number(value, "seconds") < 1 || J.Number(
                value,
                "seconds"
            ) > J.Number(policy.Value, "max_seconds") {
                throw Exception("Invalid amendment receipt or verification budget")
            }
            Data.CommitSha(J.Text(value, "previous"))
            Tools(policy, J.Get(value, "tools"))
        }

        internal func Current(state JsonElement) JsonElement {
            let amendments = J.Items(J.Get(state, "amendments"))
            return amendments.Count == 0 ? J.Get(state, "contribution"): amendments[amendments.Count - 1]
        }

        internal func Head(state JsonElement) string -> J.Text(J.Get(Current(state), "outcome"), "head")

        internal func StateReceipt(state JsonElement) JsonElement {
            let current = Current(state)
            let original = J.Get(state, "contribution")
            let fields = J.Map(
                "version",
                2,
                "repo",
                J.Text(state, "repo"),
                "issue",
                J.Number(state, "issue"),
                "approval",
                J.Text(state, "approval_id"),
                "expected",
                J.Text(current, "expected"),
                "reservation",
                J.Text(J.Get(state, "reservation"), "reservation"),
                "donor",
                J.Text(original, "donor"),
                "head",
                Head(state)
            )
            let correction = J.Get(J.Get(original, "metadata"), "correction")
            if correction.ValueKind != JsonValueKind.Undefined {
                fields["correction"] = correction
            }
            if J.Items(J.Get(state, "amendments")).Count > 0 {
                fields["amendment"] = J.Map(
                    "id",
                    J.Text(current, "request"),
                    "previous",
                    J.Text(current, "previous"),
                    "seconds",
                    J.Number(current, "seconds"),
                    "tools",
                    J.Get(current, "tools")
                )
            }
            return J.Parse(J.Write(fields))
        }

        internal func Receipt(body string) JsonElement {
            let prefix = "<!-- tokate-receipt:"
            let start = Unique(body, prefix)
            let end = body.IndexOf(" -->", start, StringComparison.Ordinal)
            if end < 0 {
                throw Exception("Malformed Tokate receipt")
            }
            return RequestData.Parse(body.Substring(start + prefix.Length, end - start - prefix.Length))
        }

        private func Unique(body string, value string) int32 {
            let start = body.IndexOf(value, StringComparison.Ordinal)
            if start < 0 || body.IndexOf(value, start + value.Length, StringComparison.Ordinal) >= 0 {
                throw Exception("Missing or ambiguous Tokate-owned report/receipt region")
            }
            return start
        }

        internal func Report(text string) string -> "<!-- tokate-report:start -->\n" +
            text +
            "\n<!-- tokate-report:end -->"

        internal func ReportText(body string, legacy string) string {
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            if !body.Contains(prefix) {
                Unique(body, legacy)
                return legacy
            }
            let start = Unique(body, prefix) + prefix.Length
            let end = Unique(body, suffix)
            if end < start {
                throw Exception("Malformed Tokate report region")
            }
            return body.Substring(start, end - start).Trim()
        }

        private func Owned(body string, legacy string) string -> ReportText(body, legacy) +
            "\n" +
            RequestData.Canonical(Receipt(body))

        internal func ReplaceBody(body string, oldReport string, report string, receipt JsonElement) string {
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            var start int32
            var length int32
            if body.Contains(prefix) {
                start = Unique(body, prefix)
                let end = Unique(body, suffix)
                if end <= start {
                    throw Exception("Malformed Tokate report region")
                }
                length = end + suffix.Length - start
            } else {
                start = Unique(body, oldReport)
                length = oldReport.Length
            }
            let updated = body.Remove(start, length).Insert(start, Report(report))
            start = Unique(updated, "<!-- tokate-receipt:")
            let end = updated.IndexOf(" -->", start, StringComparison.Ordinal)
            if end < 0 {
                throw Exception("Malformed Tokate receipt")
            }
            return updated.Remove(start, end + 4 - start).Insert(
                start,
                "<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            )
        }

        internal func Summary(previous string, head string, seconds int32, tools JsonElement) string ->
        "Review amendment: " +
            previous +
            " → " +
            head +
            ". Donor reports all original owner commands passed locally with a separate " +
            seconds.ToString() +
            " second verification budget; no inference was launched by amend.\n\n" +
            "Original execution/model/effort/runtime/usage observations cover original work only. Amendment editing: " +
            (
            J.Items(tools).Count == 0 ? "manual; coding time and usage unknown":
            "donor-reported tools " + RequestData.Canonical(tools) +
                "; identity, coding time and usage not independently attested"
        ) +
            ". Owner CI and review must validate this exact amended commit."

        internal func Pull(run Data, number int32, previous string, candidate string) JsonElement {
            let pull = GitHub.Api("repos/" + run.Text("repo") + "/pulls/" + number.ToString())
            let head = J.Get(pull, "head")
            let marker = run.Number("version") == 2 ? "<!-- tokate-v2:" + run.Text("id") + " -->":
            "<!-- tokate-run:" + run.Text("id") + " -->"
            if J.Number(pull, "number") != number || J.Text(pull, "state") != "open" || J.Bool(pull, "merged") || J.Get(
                pull,
                "merged_at"
            )
                .ValueKind != JsonValueKind.Undefined &&
                J
                .Get(pull, "merged_at").ValueKind != JsonValueKind.Null || !J.Text(pull, "body").Contains(marker) ||
                J.Text(head, "ref") != run.Text("branch") || J.Text(J.Get(head, "repo"), "full_name") != run.Text(
                "head_repo"
            ) ||
                J.Text(J.Get(pull, "base"), "ref") != run.Text("base_branch") ||
                (
                J.Text(J.Get(J.Get(pull, "base"), "repo"), "full_name") != "" && J.Text(
                    J.Get(J.Get(pull, "base"), "repo"),
                    "full_name"
                ) != run.Text("repo")
            ) ||
                (J.Text(head, "sha") != previous && J.Text(head, "sha") != candidate) {
                throw Exception("Existing PR changed, closed or merged; saved amendment retained")
            }
            return pull
        }

        private func Authority(run Data, amendment Data?) JsonElement {
            let viewer = GitHub.Api("user")
            if !String.Equals(J.Text(viewer, "login"), run.Text("donor"), StringComparison.OrdinalIgnoreCase) || J.Get(
                viewer,
                "id"
            )
                .ToString() != J.Get(run.Element(), "donor_id").ToString() {
                throw CliFailure("authentication_required", "Use the same donor account and numeric identity")
            }
            if run.Number("version") == 1 {
                let record = Workflow.Recheck(run)
                let info = GitHub.Api("repos/" + Data.Repo(run.Text("head_repo")))
                if !J.Bool(J.Get(info, "permissions"), "push") ||
                    (
                    run.Text("head_repo") != run.Text("repo") && !String.Equals(
                        J.Text(J.Get(info, "parent"), "full_name"),
                        run.Text("repo"),
                        StringComparison.OrdinalIgnoreCase
                    )
                ) ||
                    !String
                    .Equals(
                    J.Text(J.Get(info, "owner"), "login"),
                    run.Text("donor"),
                    StringComparison.OrdinalIgnoreCase
                ) {
                    throw Exception("Donor fork ownership or upstream changed")
                }
                return record
            }
            if run.Number("version") != 2 {
                throw Exception("Amend requires a native version-1 or version-2 run")
            }
            let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(run.Text("repo"), run.Number("issue"), run.Text("donor"))
            let value = state.Value()
            let original = J.Get(value, "contribution")
            let metadata = J.Get(original, "metadata")
            let approval = J.Get(record, "approval")
            if J.Text(value, "approval_id") != run.Text("approval") || J.Text(
                J.Get(value, "reservation"),
                "reservation"
            ) != run.Text("id") || J.Get(original, "actor").ToString() != J.Get(viewer, "id").ToString() || J.Text(
                metadata,
                "fork"
            ) != run.Text("head_repo") || J.Text(metadata, "branch") != run.Text("branch") || run.Text(
                "branch"
            ) != "tokate/v2-" +
                run.Text("id") || run.Text("base") != J.Text(approval, "base") || run.Text("base_branch") != J.Text(
                approval,
                "base_branch"
            ) ||
                run.Text("policy_hash") != J.Text(approval, "policy_hash") {
                throw CliFailure("stale_approval", "Published contribution authority changed")
            }
            if amendment != nil && state.Sha != amendment.Text("expected") {
                let current = Current(value)
                if J.Text(current, "request") != amendment.Text("id") || J.Text(current, "expected") != amendment.Text(
                    "expected"
                ) ||
                    Head(value) != amendment.Text("commit") || J.Number(
                    J.Get(current, "outcome"),
                    "pr"
                ) != amendment.Number("pr") || J.Get(current, "actor").ToString() != J.Get(viewer, "id").ToString() ||
                    J.Text(current, "previous") != amendment.Text("previous") || J.Number(
                    current,
                    "seconds"
                ) != amendment.Number("seconds") || RequestData.Canonical(J.Get(current, "tools")) != RequestData
                    .Canonical(J.Get(amendment.Element(), "tools")) {
                    throw CliFailure("stale_approval", "Amendment has stale coordination revision")
                }
                let commit = GitHub.Api("repos/" + run.Text("repo") + "/git/commits/" + state.Sha)
                let parents = J.Items(J.Get(commit, "parents"))
                if parents.Count != 1 || J.Text(parents[0], "sha") != amendment.Text("expected") {
                    throw Exception("Amendment state is not the exact saved coordination transition")
                }
            } else if Head(value) != (amendment?.Text("previous") ?? run.Text("commit")) {
                throw Exception("Current published head differs from saved contribution")
            }
            let remoteHead = Remote(
                run,
                amendment?.Text("previous") ?? run.Text("commit"),
                amendment?.Text("commit") ?? ""
            )
            Coordinator.ValidateFork(
                run.Text("repo"),
                run.Text("donor"),
                J.Parse(
                    J.Write(J.Map("fork", run.Text("head_repo"), "branch", run.Text("branch"), "head", remoteHead))
                ),
                J.Get(viewer, "id")
            )
            return J.Parse(J.Write(J.Map("record", record, "state", value, "sha", state.Sha)))
        }

        private func Snapshot(checkout string, run Data, commit string, previous string, record JsonElement) string {
            Verification.Candidate(checkout)
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit || Commands.Git(
                checkout,
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignore-submodules=none"
            ) != "" {
                throw Exception("Amend requires a clean checkout at the declared exact commit")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), commit)
            Commands.Git(checkout, "merge-base", "--is-ancestor", previous, commit)
            Commands.Git(checkout, "diff", "--no-ext-diff", "--no-textconv", "--check", run.Text("base"), commit)
            ProtectedPaths.Local(checkout, J.Get(record, "policy"), J.Get(record, "approval"), run.Text("base"), commit)
            ProtectedPaths.Local(checkout, J.Get(record, "policy"), J.Get(record, "approval"), previous, commit)
            return Commands.Git(checkout, "rev-parse", "HEAD^{tree}") + "\n" + Commands.Git(
                checkout,
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                run.Text("base"),
                commit
            )
        }

        private func Archive(directory string) {
            let archive = Path.Combine(directory, "original-evidence")
            if Directory.Exists(archive) {
                return
            }
            let staging = Path.Combine(directory, "archive-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(staging)
            for file in Directory.EnumerateFiles(directory) {
                if Path.GetFileName(file) != ".lock" {
                    File.Copy(file, Path.Combine(staging, Path.GetFileName(file)))
                }
            }
            Directory.Move(staging, archive)
        }

        internal func Run(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let commit = Data.CommitSha(args.Need("commit"))
            let seconds = args.Number("seconds")
            let tools = args.Get("tools") == "" ? J.Parse("[]"): RequestData.FileData(args.Need("tools"), 8192)
            let location = Path.Combine(directory, "amendments", commit)
            var amendment Data
            if Directory.Exists(location) {
                amendment = Data.Load(location)
                if amendment.Number("seconds") != seconds || RequestData.Canonical(
                    J.Get(amendment.Element(), "tools")
                ) != RequestData.Canonical(tools) {
                    throw Exception("Saved amendment budget or editing provenance changed")
                }
            } else {
                let authority = Authority(run, nil)
                let record = run.Number("version") == 2 ? J.Get(authority, "record"): authority
                let policy = Policy(J.Write(J.Get(record, "policy")))
                Tools(policy, tools)
                if seconds > J.Number(policy.Value, "max_seconds") {
                    throw Exception("Amendment verification budget exceeds owner policy")
                }
                let number = run.Number("version") == 2 ? J.Number(
                    J.Get(Current(J.Get(authority, "state")), "outcome"),
                    "pr"
                ): run.Number("pr")
                let pull = Pull(run, number, run.Text("commit"), "")
                Publication.Verify(run.Text("repo"), number)
                Remote(run, run.Text("commit"), "")
                let checkout = Verification.Validate(Path.Combine(directory, "checkout"))
                let snapshot = Snapshot(checkout, run, commit, run.Text("commit"), record)
                Archive(directory)
                Directory.CreateDirectory(location)
                amendment = Data()
                amendment.Fields["id"] = Guid.NewGuid().ToString("D")
                amendment.Fields["previous"] = run.Text("commit")
                amendment.Fields["commit"] = commit
                amendment.Fields["seconds"] = seconds
                amendment.Fields["tools"] = tools
                amendment.Fields["pr"] = number
                amendment.Fields["expected"] = run.Number("version") == 2 ? J.Text(authority, "sha"): ""
                amendment.Fields["state"] = "verifying"
                amendment.Fields["previous_body"] = J.Text(pull, "body")
                amendment.Fields["snapshot"] = Data.Hash(snapshot)
                amendment.Fields[
                    "provenance"
                ] = "Editing tools, coding time and usage are manual/unknown or donor-reported; original observations cover original execution only"
                amendment.Save(location)
                File.WriteAllText(Path.Combine(location, "candidate.patch"), snapshot)
                let timer = Stopwatch.StartNew()
                let results = List[Object]()
                try {
                    Terminal.Step("Verifying review amendment independently. No inference will run.")
                    for command in J.Items(J.Get(policy.Value, "verification")) {
                        let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                        if remaining < 1 {
                            throw CliFailure("verification_failed", "Amendment verification budget exhausted")
                        }
                        let words = List[string]()
                        for word in J.Items(command) {
                            words.Add(word.GetString() ?? "")
                        }
                        let result = Verification.Run(
                            checkout,
                            words.ToArray(),
                            run.Flag("network") && J.Bool(policy.Value, "allow_network"),
                            remaining
                        )
                        results.Add(
                            J.Map(
                                "command",
                                command,
                                "exit_code",
                                result.Code,
                                "output",
                                result.Output,
                                "error",
                                result.Error
                            )
                        )
                        File.WriteAllText(Path.Combine(location, "verification.json"), J.Write(results))
                        if result.Code != 0 {
                            throw CliFailure(
                                "verification_failed",
                                "Amendment owner verification failed; saved progress retained"
                            )
                        }
                    }
                    if Snapshot(checkout, run, commit, amendment.Text("previous"), record) != snapshot {
                        throw Exception("Verification changed the exact amendment candidate")
                    }
                    amendment.Fields["verification"] = results
                    amendment.Fields["elapsed_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
                    amendment.Fields["state"] = "verified"
                    amendment.Save(location)
                } catch (error Exception) {
                    amendment.Fields["state"] = "failed"
                    amendment.Fields["error"] = error.Message
                    amendment.Fields["failure_reason"] = error is CliFailure failure ? failure.Code: "invalid_state"
                    amendment.Save(location)
                    throw error
                }
            }
            if amendment.Text("state") == "failed" || amendment.Text("state") == "verifying" {
                throw CliFailure(
                    "verification_failed",
                    "Amendment verification failed or interrupted; inspect saved progress and declare a corrected commit"
                )
            }
            try {
                Publish(directory, location, run, amendment)
            } catch (error Exception) {
                amendment.Fields["error"] = error.Message
                amendment.Fields[
                    "failure_reason"
                ] = error is CliFailure failure ? failure.Code: "publication_interrupted"
                amendment.Save(location)
                if error is CliFailure {
                    throw error
                }
                PublicOutput.FailureCode = "command_failed"
                throw Exception(
                    error.Message +
                        "\nSaved amendment: " +
                        location +
                        ". Remote/PR/state updates are not atomic; a physical PR may have an invalid receipt. Use verify-pr to inspect authority. Re-run the same amend command to resume only saved publication intent without inference or repeating passed checks.",
                    error
                )
            }
        }

        private func Remote(run Data, previous string, candidate string) string {
            let reference = GitHub.Api("repos/" + run.Text("head_repo") + "/git/ref/heads/" + run.Text("branch"))
            let head = J.Text(J.Get(reference, "object"), "sha")
            if head != previous && head != candidate {
                throw Exception("Remote PR branch changed; saved amendment retained")
            }
            return head
        }

        private func Publish(directory string, location string, run Data, amendment Data) {
            let authority = Authority(run, amendment)
            let record = run.Number("version") == 2 ? J.Get(authority, "record"): authority
            let policy = Policy(J.Write(J.Get(record, "policy")))
            Tools(policy, J.Get(amendment.Element(), "tools"))
            if amendment.Number("seconds") < 1 || amendment.Number("seconds") > J.Number(policy.Value, "max_seconds") ||
                (run.Flag("network") && !J.Bool(policy.Value, "allow_network")) {
                throw Exception("Amendment budget or network exceeds current owner policy")
            }
            Publication.VerificationReport(amendment, record)
            let checkout = Verification.Validate(Path.Combine(directory, "checkout"))
            let snapshot = Snapshot(checkout, run, amendment.Text("commit"), amendment.Text("previous"), record)
            if Data.Hash(snapshot) != amendment.Text("snapshot") || snapshot != File.ReadAllText(
                Path.Combine(location, "candidate.patch")
            ) {
                throw Exception("Verified amendment candidate changed")
            }
            let pull = Pull(run, amendment.Number("pr"), amendment.Text("previous"), amendment.Text("commit"))
            let remote = Remote(run, amendment.Text("previous"), amendment.Text("commit"))
            if J.Text(J.Get(pull, "head"), "sha") != remote {
                throw Exception("Remote branch and PR head disagree")
            }
            let receipt = Receipt(J.Text(pull, "body"))
            if amendment.Text("state") == "verified" {
                if remote != amendment.Text("previous") || J.Text(receipt, "head") != amendment.Text("previous") {
                    throw Exception("Remote changed before amendment publication intent")
                }
                if RequestData.Canonical(receipt) != RequestData.Canonical(Receipt(amendment.Text("previous_body"))) {
                    throw Exception("Previous receipt changed after amendment acceptance")
                }
                let intent = J.Map(
                    "previous",
                    amendment.Text("previous"),
                    "head",
                    amendment.Text("commit"),
                    "pr",
                    amendment.Number("pr"),
                    "uuid",
                    amendment.Text("id")
                )
                amendment.Fields["publication"] = intent
                if run.Number("version") == 1 {
                    let updated = Dictionary[string, Object?]()
                    for field in receipt.EnumerateObject() {
                        updated[field.Name] = field.Value
                    }
                    updated["head"] = amendment.Text("commit")
                    if !updated.ContainsKey("original_head") {
                        updated["original_head"] = amendment.Text("previous")
                    }
                    updated["amendment"] = PublicRecord(amendment)
                    let report = Summary(
                        amendment.Text("previous"),
                        amendment.Text("commit"),
                        amendment.Number("seconds"),
                        J.Get(amendment.Element(), "tools")
                    )
                    amendment.Fields["body"] = ReplaceBody(
                        J.Text(pull, "body"),
                        Publication.VerificationReport(run, record),
                        report,
                        J.Parse(J.Write(updated))
                    )
                    amendment.Fields["previous_body"] = J.Text(pull, "body")
                } else {
                    let updated = Dictionary[string, Object?]()
                    for field in receipt.EnumerateObject() {
                        updated[field.Name] = field.Value
                    }
                    updated["head"] = amendment.Text("commit")
                    updated["expected"] = amendment.Text("expected")
                    updated["amendment"] = PublicRecord(amendment)
                    let original = J.Get(J.Get(authority, "state"), "contribution")
                    amendment.Fields["body"] = ReplaceBody(
                        J.Text(pull, "body"),
                        Coordinator.OriginalReport(J.Get(original, "metadata")),
                        Summary(
                            amendment.Text("previous"),
                            amendment.Text("commit"),
                            amendment.Number("seconds"),
                            J.Get(amendment.Element(), "tools")
                        ),
                        J.Parse(J.Write(updated))
                    )
                    amendment.Fields["request"] = J.Map(
                        "uuid",
                        amendment.Text("id"),
                        "expected",
                        amendment.Text("expected"),
                        "approval",
                        run.Text("approval"),
                        "action",
                        "amend",
                        "metadata",
                        J.Map(
                            "fork",
                            run.Text("head_repo"),
                            "branch",
                            run.Text("branch"),
                            "previous",
                            amendment.Text("previous"),
                            "head",
                            amendment.Text("commit"),
                            "pr",
                            amendment.Number("pr"),
                            "seconds",
                            amendment.Number("seconds"),
                            "tools",
                            J.Get(amendment.Element(), "tools"),
                            "verification",
                            "donor-reported-pass"
                        )
                    )
                }
                amendment.Fields["state"] = "publishing"
                amendment.Save(location)
                File.WriteAllText(Path.Combine(location, "publication.json"), J.Write(amendment.Element()) + "\n")
            }
            let previousReceipt = Receipt(amendment.Text("previous_body"))
            let legacyReport = run.Number("version") == 1 ? Publication.VerificationReport(run, record):
            Coordinator.OriginalReport(J.Get(J.Get(J.Get(authority, "state"), "contribution"), "metadata"))
            let previousOwned = Owned(amendment.Text("previous_body"), legacyReport)
            let owned = Owned(J.Text(pull, "body"), legacyReport)
            if owned != previousOwned && owned != Owned(amendment.Text("body"), legacyReport) {
                throw Exception("PR owned regions differ from saved previous or candidate state")
            }
            if remote == amendment.Text("previous") {
                if RequestData.Canonical(receipt) != RequestData.Canonical(previousReceipt) || owned != previousOwned {
                    throw Exception("Invalid physical state: candidate receipt on the previous remote head")
                }
                Authority(run, amendment)
                Pull(run, amendment.Number("pr"), amendment.Text("previous"), "")
                Remote(run, amendment.Text("previous"), "")
                if Snapshot(checkout, run, amendment.Text("commit"), amendment.Text("previous"), record) != snapshot {
                    throw Exception("Amendment checkout changed before push")
                }
                Commands.Git(
                    checkout,
                    "-c",
                    "credential.helper=",
                    "-c",
                    "credential.helper=!gh auth git-credential",
                    "push",
                    "https://github.com/" + run.Text("head_repo") + ".git",
                    amendment.Text("commit") + ":refs/heads/" + run.Text("branch")
                )
            }
            Authority(run, amendment)
            Remote(run, amendment.Text("commit"), "")
            let latest = Pull(run, amendment.Number("pr"), amendment.Text("commit"), "")
            if run.Number("version") == 1 {
                let body = J.Text(latest, "body")
                let candidateOwned = Owned(amendment.Text("body"), legacyReport)
                if Owned(body, legacyReport) != candidateOwned {
                    if Owned(body, legacyReport) != previousOwned {
                        throw Exception(
                            "PR owned regions changed during interrupted publication; physical state retained for inspection"
                        )
                    }
                    let updated = ReplaceBody(
                        body,
                        legacyReport,
                        ReportText(amendment.Text("body"), legacyReport),
                        Receipt(amendment.Text("body"))
                    )
                    amendment.Fields["body"] = updated
                    amendment.Save(location)
                    File.WriteAllText(Path.Combine(location, "publication.json"), J.Write(amendment.Element()) + "\n")
                    Authority(run, amendment)
                    Remote(run, amendment.Text("commit"), "")
                    let beforeWrite = Pull(run, amendment.Number("pr"), amendment.Text("commit"), "")
                    if J.Text(beforeWrite, "body") != body ||
                        Snapshot(
                        checkout,
                        run,
                        amendment.Text("commit"),
                        amendment.Text("previous"),
                        record
                    ) != snapshot {
                        throw Exception("PR body or amendment checkout changed before body write")
                    }
                    GitHub.Api(
                        "repos/" + run.Text("repo") + "/pulls/" + amendment.Number("pr").ToString(),
                        J.Map("body", updated),
                        "PATCH"
                    )
                }
                Authority(run, amendment)
                Remote(run, amendment.Text("commit"), "")
                let finalPull = Pull(run, amendment.Number("pr"), amendment.Text("commit"), "")
                if Owned(J.Text(finalPull, "body"), legacyReport) != candidateOwned {
                    throw Exception("Published owned report/receipt changed")
                }
                Publication.Verify(run.Text("repo"), amendment.Number("pr"))
                Complete(directory, location, run, amendment, latest)
            } else {
                if J.Text(authority, "sha") != amendment.Text("expected") {
                    Publication.Verify(run.Text("repo"), amendment.Number("pr"))
                    Complete(directory, location, run, amendment, latest)
                    return
                }
                let request = J.Get(amendment.Element(), "request")
                let path = Path.Combine(location, "request.json")
                File.WriteAllText(path, J.Write(request) + "\n")
                if amendment.Text("state") != "requested" {
                    var found bool
                    var page int32 = 1
                    while !found {
                        let comments = J.Items(
                            GitHub.Api(
                                "repos/" + run.Text("repo") + "/issues/" + run.Number("issue").ToString() +
                                    "/comments?per_page=100&page=" +
                                    page.ToString()
                            )
                        )
                        for comment in comments {
                            if J.Get(J.Get(comment, "user"), "id").ToString() != J.Get(run.Element(), "donor_id")
                                .ToString() || !J.Text(comment, "body").StartsWith(
                                "/tokate ",
                                StringComparison.Ordinal
                            ) {
                                continue
                            }
                            var posted JsonElement
                            try {
                                posted = RequestData.Parse(J.Text(comment, "body").Substring(8))
                            } catch {
                                continue
                            }
                            if J.Text(posted, "uuid") == amendment.Text("id") {
                                if RequestData.Canonical(posted) != RequestData.Canonical(request) {
                                    throw Exception("Saved amendment UUID has a changed request comment")
                                }
                                found = true
                            }
                        }
                        if comments.Count < 100 {
                            break
                        }
                        page++
                    }
                    if !found {
                        V2Contribution.Request(
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
                    amendment.Fields["state"] = "requested"
                    amendment.Save(location)
                }
                Terminal.Message(
                    "Amendment request saved: " +
                        path +
                        ". Await coordinator outcome, then re-run the same amend command to record publication. PR " +
                        amendment
                        .Number("pr").ToString() +
                        " may temporarily have an invalid receipt until body and coordination state agree."
                )
            }
        }

        internal func PublicRecord(amendment Data) Object -> J.Map(
            "id",
            amendment.Text("id"),
            "previous",
            amendment.Text("previous"),
            "seconds",
            amendment.Number("seconds"),
            "tools",
            J.Get(amendment.Element(), "tools")
        )

        private func Complete(directory string, location string, run Data, amendment Data, pull JsonElement) {
            amendment.Fields["state"] = "published"
            amendment.Fields.Remove("error")
            amendment.Fields.Remove("failure_reason")
            amendment.Save(location)
            let history = List[Object]()
            var found bool
            for old in J.Items(J.Get(run.Element(), "amendments")) {
                history.Add(old)
                if J.Text(old, "id") == amendment.Text("id") {
                    found = true
                }
            }
            if !found {
                history.Add(
                    J.Map(
                        "id",
                        amendment.Text("id"),
                        "previous",
                        amendment.Text("previous"),
                        "head",
                        amendment.Text("commit")
                    )
                )
            }
            run.Fields["amendments"] = history
            run.Fields["commit"] = amendment.Text("commit")
            Publication.SavePr(directory, run, pull)
            Terminal.Message(
                "Verified amendment published; original evidence: " + Path.Combine(directory, "original-evidence")
            )
        }
    }
}
