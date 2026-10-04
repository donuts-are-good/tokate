package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class CorrectionPublication {
    shared {
        internal func Pulls(run Data) List[JsonElement] {
            let pulls = List[JsonElement]()
            for page in 1 ... 21 {
                let rows = J.Items(
                    GitHub.Api(
                        "repos/" + Data.Repo(run.Text("repo")) + "/pulls?state=all&head=" + Uri.EscapeDataString(
                            run.Text("donor") + ":" + run.Text("branch")
                        ) +
                            "&per_page=100&page=" +
                            page.ToString()
                    )
                )
                pulls.AddRange(rows)
                if rows.Count < 100 {
                    return pulls
                }
            }
            throw Exception("interrupted_publication: matching PR history is incomplete; refusing publication")
        }

        internal func Remote(run Data, correction Data?, initial bool = false) string {
            let reference = GitHub.Api(
                "repos/" + Data.Repo(run.Text("head_repo")) + "/git/ref/heads/" + run.Text("branch"),
                missing: true
            )
            if reference.ValueKind == JsonValueKind.Undefined {
                if run.Number("version") == 2 && initial {
                    return ""
                }
                throw Exception("interrupted_publication: contribution branch is missing; intent preserved")
            }
            let head = J.Text(J.Get(reference, "object"), "sha")
            if head != run.Text("base") && head != (correction?.Text("commit") ?? "") {
                throw Exception("interrupted_publication: remote branch changed; refusing to overwrite it")
            }
            return head
        }

        internal func Receipt(run Data, correction Data) Dictionary[string, Object?] {
            let receipt = run.Number("version") == 2 ? J.Map(
                "version",
                2,
                "repo",
                run.Text("repo"),
                "issue",
                run.Number("issue"),
                "approval",
                run.Text("approval"),
                "expected",
                run.Text("state_sha"),
                "reservation",
                run.Text("id"),
                "donor",
                run.Text("donor"),
                "head",
                correction.Text("commit")
            ): J
                .Map(
                "version",
                run.Number("version"),
                "repo",
                run.Text("repo"),
                "issue",
                run.Number("issue"),
                "donor",
                run.Text("donor"),
                "approval",
                run.Text("approval"),
                "head",
                correction.Text("commit")
            )
            if run.Number("version") == 1 {
                receipt["model"] = run.Text("model")
                receipt["effort"] = run.Text("effort")
                receipt["seconds"] = run.Number("seconds")
                receipt["network"] = run.Flag("network")
                receipt["policy"] = run.Text("policy_hash")
            }
            receipt["correction"] = Correction.Provenance(correction)
            return receipt
        }

        internal func Match(run Data, correction Data, pull JsonElement) {
            let marker = run.Number("version") == 1 ? "<!-- tokate-run:" + run.Text("id") + " -->":
            "<!-- tokate-v2:" + run.Text("id") + " -->"
            let body = J.Text(pull, "body")
            let prefix = "<!-- tokate-receipt:"
            let start = body.IndexOf(prefix, StringComparison.Ordinal)
            let end = start < 0 ? -1: body.IndexOf(" -->", start, StringComparison.Ordinal)
            if start < 0 || end < 0 || start != body.LastIndexOf(prefix, StringComparison.Ordinal) || !Correction.Same(
                RequestData.Parse(body.Substring(start + prefix.Length, end - start - prefix.Length)),
                J.Parse(J.Write(Receipt(run, correction)))
            ) {
                throw Exception("interrupted_publication: physical PR receipt differs from the saved correction")
            }
            let head = J.Get(pull, "head")
            if !body.Contains(marker) || body.IndexOf(marker, StringComparison.Ordinal) != body.LastIndexOf(
                marker,
                StringComparison.Ordinal
            ) ||
                body.IndexOf("<!-- tokate-receipt:", StringComparison.Ordinal) != body.LastIndexOf(
                "<!-- tokate-receipt:",
                StringComparison.Ordinal
            ) ||
                J.Text(head, "sha") != correction.Text("commit") || J.Text(head, "ref") != run.Text("branch") || J.Text(
                J.Get(head, "repo"),
                "full_name"
            ) != run.Text("head_repo") || !String.Equals(
                J.Text(J.Get(pull, "user"), "login"),
                run.Text("donor"),
                StringComparison.OrdinalIgnoreCase
            ) &&
                run.Number("version") == 1 || J.Text(J.Get(pull, "base"), "ref") != run.Text("base_branch") || J.Text(
                pull,
                "state"
            ) != "open" ||
                !J.Bool(pull, "draft") {
                throw Exception("interrupted_publication: physical PR differs from exact saved run/head/receipt")
            }
        }

        private func Existing(run Data, correction Data) JsonElement {
            let pulls = Pulls(run)
            if pulls.Count > 1 {
                throw Exception("interrupted_publication: ambiguous physical PRs; intent preserved")
            }
            if pulls.Count == 0 {
                return JsonElement{}
            }
            Match(run, correction, pulls[0])
            return pulls[0]
        }

        private func CheckSaved(directory string, run Data, correction Data) JsonElement {
            let original = Correction.OriginalRun(directory, run)
            Correction.Completed(Path.Combine(directory, "original-evidence"), original)
            if correction.Text("state") != "verified" || run.Text("commit") != correction.Text("commit") ||
                !Correction
                .Same(J.Get(run.Element(), "correction"), Correction.Provenance(correction)) {
                throw Exception("Only the saved verified exact correction can be published")
            }
            let record = J.Parse(File.ReadAllText(Path.Combine(directory, "original-evidence", "approval.json")))
            Correction.Exact(directory, run, correction, record)
            Publication.VerificationReport(run, record)
            if !Correction.Same(J.Get(run.Element(), "verification"), J.Get(correction.Element(), "verification")) {
                throw Exception("Correction verification results changed")
            }
            return record
        }

        private func Push(directory string, run Data, correction Data) {
            Commands.Git(
                Path.Combine(directory, "checkout"),
                "-c",
                "credential.helper=",
                "-c",
                "credential.helper=!gh auth git-credential",
                "push",
                "https://github.com/" + run.Text("head_repo") + ".git",
                correction.Text("commit") + ":refs/heads/" + run.Text("branch")
            )
        }

        private func Failure(directory string, correction Data, error Exception) {
            correction.Fields["failure_stage"] = "interrupted_publication"
            correction.Fields["failure_reason"] = "publication_interrupted"
            correction.Fields["publication_error"] = error.Message
            Correction.Save(directory, correction)
        }

        private func Preview(path string, expected string, json bool = true) {
            if FileInfo(path).LinkTarget != nil {
                throw Exception("Publication preview must not be a link")
            }
            if File.Exists(path) {
                let value = File.ReadAllText(path)
                if json ? !Correction.Same(J.Parse(value), J.Parse(expected)): value != expected {
                    throw Exception("Saved publication preview differs from exact intent")
                }
            } else {
                File.WriteAllText(path, expected)
            }
        }

        private func NativeBody(run Data, correction Data, record JsonElement) string {
            let tools = J.Get(correction.Element(), "tools")
            let editing = J.Items(tools).Count == 0 ? "manual/unknown editing (no tools declared)":
            "donor-reported correction tools: " + J.Write(tools)
            let values = Dictionary[string, string]()
            values["issue"] = run.Number("issue").ToString()
            values["report"] = "Explicit donor correction " + correction.Text("uuid") +
                ": " +
                editing +
                ". Original model, effort, execution runtime and reported usage cover only the original completed turn; correction edits are not attributed to that model. " +
                "Tokate observed independent verification locally on exact corrected commit " +
                correction.Text("commit") + ", tree " + correction.Text("tree") +
                ". Separate verification budget: " +
                correction
                .Number("seconds").ToString() + " seconds.\n\n" + Publication.VerificationReport(run, record)
            values["donor"] = run.Text("donor")
            values["model"] = run.Text("model")
            values["effort"] = run.Text("effort")
            values["seconds"] = run.Flag("recovered") ? "unknown (original runtime not recorded)":
            (
                run.Fields.ContainsKey("execution_seconds") ? run.Number("execution_seconds").ToString() +
                    " (original execution only)":
                (
                    run.Fields.ContainsKey("elapsed_seconds") ? run.Number("elapsed_seconds").ToString() +
                        " (original work including checks)": "unknown (original runtime not recorded)"
                )
            )
            values["base"] = run.Text("base")
            values["policy"] = run.Text("policy_hash")
            values["usage"] = Publication.Usage(run)
            values["receipt"] = "<!-- tokate-run:" + run.Text("id") + " -->\n<!-- tokate-receipt:" + J.Write(
                Receipt(run, correction)
            ) +
                " -->"
            return Regex.Replace(
                J.Text(record, "template"),
                "\\{\\{([a-z_]+)\\}\\}",
                (match Match) -> values[match.Groups[1].Value]
            )
        }

        internal func Publish(directory string) {
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            if run.Number("version") != 1 {
                throw Exception("Version-2 runs use submit and the owner-installed coordinator")
            }
            let correction = Correction.Load(Path.Combine(directory, "correction.json"))
            PublishLocked(directory, run, correction, Correction.Authority(directory, run))
        }

        internal func PublishLocked(directory string, run Data, correction Data, record JsonElement) {
            try {
                CheckSaved(directory, run, correction)
                var intent = J.Get(correction.Element(), "publication")
                if intent.ValueKind == JsonValueKind.Undefined {
                    let body = NativeBody(run, correction, record)
                    let request = J.Map(
                        "title",
                        J.Text(J.Get(record, "issue"), "title"),
                        "body",
                        body,
                        "head",
                        run.Text("donor") + ":" + run.Text("branch"),
                        "base",
                        run.Text("base_branch"),
                        "draft",
                        true,
                        "maintainer_can_modify",
                        true
                    )
                    correction.Fields["publication"] = J.Map(
                        "stage",
                        "prepared",
                        "request",
                        request,
                        "receipt",
                        Receipt(run, correction)
                    )
                    Correction.Save(directory, correction)
                    intent = J.Get(correction.Element(), "publication")
                    File.WriteAllText(Path.Combine(directory, "pr-body.md"), body)
                    File.WriteAllText(Path.Combine(directory, "publication.json"), J.Write(request) + "\n")
                } else if !Correction.Same(J.Get(intent, "receipt"), J.Parse(J.Write(Receipt(run, correction)))) {
                    throw Exception("Saved publication intent changed; no silent regeneration is allowed")
                }
                Preview(Path.Combine(directory, "publication.json"), J.Write(J.Get(intent, "request")) + "\n")
                Preview(Path.Combine(directory, "pr-body.md"), J.Text(J.Get(intent, "request"), "body"), false)
                var remote = Remote(run, correction)
                let existing = Existing(run, correction)
                if existing.ValueKind != JsonValueKind.Undefined {
                    if remote != correction.Text("commit") {
                        throw Exception("Physical PR and contribution branch disagree")
                    }
                    Correction.Authority(directory, run)
                    Complete(directory, run, correction, existing)
                    return
                }
                if J.Text(intent, "stage") == "create_pending" || J.Text(intent, "stage") == "published" {
                    throw Exception(
                        "interrupted_publication: no exact physical PR found after an uncertain create; refusing a blind write retry"
                    )
                }
                if remote != correction.Text("commit") {
                    SetStage(directory, correction, "push_pending")
                    Push(directory, run, correction)
                    remote = Remote(run, correction)
                    if remote != correction.Text("commit") {
                        throw Exception("Push did not produce the exact corrected branch")
                    }
                }
                Correction.Authority(directory, run)
                Correction.Exact(directory, run, correction, record)
                let raced = Existing(run, correction)
                if raced.ValueKind != JsonValueKind.Undefined {
                    Complete(directory, run, correction, raced)
                    return
                }
                SetStage(directory, correction, "create_pending")
                try {
                    GitHub.Api("repos/" + run.Text("repo") + "/pulls", J.Get(intent, "request"))
                } catch (error Exception) {
                    let found = Existing(run, correction)
                    if found.ValueKind == JsonValueKind.Undefined {
                        throw error
                    }
                }
                let created = Existing(run, correction)
                if created.ValueKind == JsonValueKind.Undefined || Remote(run, correction) != correction.Text(
                    "commit"
                ) {
                    throw Exception("interrupted_publication: missing exact physical publication after create")
                }
                Correction.Authority(directory, run)
                Complete(directory, run, correction, created)
            } catch (error Exception) {
                Failure(directory, correction, error)
                throw Exception("publication_interrupted (interrupted_publication): " + error.Message)
            }
        }

        private func SetStage(directory string, correction Data, stage string) {
            let fields = J.Map()
            for field in J.Get(correction.Element(), "publication").EnumerateObject() {
                fields[field.Name] = field.Value.Clone()
            }
            fields["stage"] = stage
            correction.Fields["publication"] = fields
            Correction.Save(directory, correction)
        }

        private func Complete(directory string, run Data, correction Data, pull JsonElement) {
            SetStage(directory, correction, "published")
            correction.Fields.Remove("failure_stage")
            correction.Fields.Remove("failure_reason")
            correction.Fields.Remove("publication_error")
            Correction.Save(directory, correction)
            Publication.SavePr(directory, run, pull)
        }

        private func Request(run Data, correction Data) JsonElement -> J.Parse(
            J.Write(
                J.Map(
                    "uuid",
                    correction.Text("publication_uuid"),
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
                        correction.Text("commit"),
                        "source",
                        run.Text("source"),
                        "tools",
                        J.Get(run.Element(), "tools"),
                        "verification",
                        "donor-reported-pass",
                        "correction",
                        Correction.Provenance(correction)
                    )
                )
            )
        )

        private func V2Authority(directory string, run Data, correction Data) CoordinationState {
            let viewer = GitHub.Api("user")
            if !String.Equals(J.Text(viewer, "login"), run.Text("donor"), StringComparison.OrdinalIgnoreCase) || J.Get(
                viewer,
                "id"
            )
                .ToString() != J.Get(run.Element(), "donor_id").ToString() {
                throw CliFailure(
                    "authentication_required",
                    "Use the original authenticated donor account and numeric identity"
                )
            }
            let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(run.Text("repo"), run.Number("issue"), run.Text("donor"), J.Get(viewer, "id"))
            let pinned = J.Parse(File.ReadAllText(Path.Combine(directory, "original-evidence", "approval.json")))
            for key in[]string{"approval", "policy", "template"} {
                if !Correction.Same(J.Get(record, key), J.Get(pinned, key)) {
                    throw CliFailure("stale_approval", "Original pinned approval, policy or template changed")
                }
            }
            if J.Text(state.Value(), "approval_id") != run.Text("approval") || J.Text(
                J.Get(state.Value(), "reservation"),
                "reservation"
            ) != run.Text("id") {
                throw CliFailure("stale_approval", "Original reservation or approval changed")
            }
            Correction.Fork(run)
            if state.Sha == run.Text("state_sha") {
                Correction.Authority(directory, run)
                return state
            }
            let intent = J.Get(correction.Element(), "publication")
            let request = J.Get(intent, "request")
            let contribution = J.Get(state.Value(), "contribution")
            let commit = GitHub.Api("repos/" + run.Text("repo") + "/git/commits/" + state.Sha)
            let parents = J.Items(J.Get(commit, "parents"))
            let binding = Data.Hash(
                RequestData.Canonical(
                    J.Parse(
                        J.Write(
                            J.Map(
                                "actor",
                                J.Get(viewer, "id"),
                                "expected",
                                run.Text("state_sha"),
                                "approval",
                                run.Text("approval"),
                                "request",
                                request
                            )
                        )
                    )
                )
            )
            var outcome bool
            for old in J.Items(J.Get(state.Value(), "outcomes")) {
                if J.Text(old, "uuid") == correction.Text("publication_uuid") && J.Text(old, "binding") == binding &&
                    Correction.Same(J.Get(old, "outcome"), J.Get(contribution, "outcome")) {
                    outcome = true
                }
            }
            if parents.Count != 1 || J.Text(parents[0], "sha") != run.Text("state_sha") || !Correction.Same(
                request,
                Request(run, correction)
            ) ||
                J.Text(contribution, "request") != correction.Text("publication_uuid") || J.Text(
                contribution,
                "expected"
            ) != run.Text("state_sha") || J.Get(contribution, "actor").ToString() != J.Get(viewer, "id").ToString() ||
                !Correction.Same(J.Get(contribution, "metadata"), J.Get(request, "metadata")) || !outcome {
                throw CliFailure(
                    "stale_approval",
                    "Stale coordination revision; only the exact saved publication transition can resume"
                )
            }
            return state
        }

        private func Posted(run Data, request JsonElement) bool -> V2Contribution.Posted(
            Data.Repo(run.Text("repo")),
            run.Number("issue"),
            J.Get(run.Element(), "donor_id"),
            request
        )

        internal func Submit(directory string) {
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let correction = Correction.Load(Path.Combine(directory, "correction.json"))
            if run.Number("version") != 2 || run.Text("source") != "tokate" {
                throw Exception("Correction submit requires a managed version-2 contribution")
            }
            try {
                let record = CheckSaved(directory, run, correction)
                var intent = J.Get(correction.Element(), "publication")
                if intent.ValueKind == JsonValueKind.Undefined {
                    Correction.Authority(directory, run)
                    correction.Fields["publication_uuid"] = Guid.NewGuid().ToString("D")
                    let request = Request(run, correction)
                    RequestData.Parse(J.Write(request))
                    RequestData.Request(request)
                    correction.Fields["publication"] = J.Map("stage", "prepared", "request", request)
                    Correction.Save(directory, correction)
                    intent = J.Get(correction.Element(), "publication")
                    File.WriteAllText(Path.Combine(directory, "request.json"), J.Write(request) + "\n")
                    File.WriteAllText(Path.Combine(directory, "publication.json"), J.Write(request) + "\n")
                } else if !Correction.Same(J.Get(intent, "request"), Request(run, correction)) {
                    throw Exception("Saved version-2 publication intent changed")
                }
                Preview(Path.Combine(directory, "request.json"), J.Write(J.Get(intent, "request")) + "\n")
                Preview(Path.Combine(directory, "publication.json"), J.Write(J.Get(intent, "request")) + "\n")
                let state = V2Authority(directory, run, correction)
                let stage = J.Text(intent, "stage")
                var remote = Remote(run, correction, stage == "prepared")
                let existing = Existing(run, correction)
                if state.Sha != run.Text("state_sha") {
                    if existing.ValueKind == JsonValueKind.Undefined || remote != correction.Text("commit") || J.Number(
                        J.Get(J.Get(state.Value(), "contribution"), "outcome"),
                        "pr"
                    ) != J.Number(existing, "number") {
                        throw Exception("Saved coordination outcome lacks exact physical PR and branch")
                    }
                    Complete(directory, run, correction, existing)
                    return
                }
                if existing.ValueKind != JsonValueKind.Undefined && remote != correction.Text("commit") {
                    throw Exception("Physical PR and remote branch disagree")
                }
                if remote != correction.Text("commit") {
                    SetStage(directory, correction, "push_pending")
                    AccessState.Check(
                        run.Text("repo"),
                        run.Number("issue"),
                        J.Get(record, "approval"),
                        J.Get(run.Element(), "donor_id")
                    )
                    Push(directory, run, correction)
                    remote = Remote(run, correction)
                    if remote != correction.Text("commit") {
                        throw Exception("Corrected remote commit missing after push")
                    }
                    V2Authority(directory, run, correction)
                }
                if stage == "request_pending" || stage == "requested" || existing.ValueKind != JsonValueKind.Undefined {
                    if !Posted(run, J.Get(intent, "request")) {
                        throw Exception(
                            "interrupted_publication: saved request has no unique physical comment; refusing blind retry"
                        )
                    }
                    SetStage(directory, correction, "requested")
                    Terminal.Message(
                        "Exact publication request is already posted; awaiting the coordinator. No write, checks or inference repeated."
                    )
                    return
                }
                Correction.Exact(directory, run, correction, record)
                let latest = V2Authority(directory, run, correction)
                AccessState.Check(
                    run.Text("repo"),
                    run.Number("issue"),
                    J.Get(record, "approval"),
                    J.Get(run.Element(), "donor_id")
                )
                SetStage(directory, correction, "request_pending")
                try {
                    GitHub.Api(
                        "repos/" + run.Text("repo") + "/issues/" + run.Number("issue").ToString() + "/comments",
                        J.Map("body", "/tokate " + RequestData.Canonical(J.Get(intent, "request"))),
                        expires: CoordinationState.Unix(J.Get(latest.Value(), "reservation"), "expires")
                    )
                } catch (error Exception) {
                    if !Posted(run, J.Get(intent, "request")) {
                        throw error
                    }
                }
                SetStage(directory, correction, "requested")
                Terminal.Message("Exact correction publication request posted. The coordinator remains publisher.")
            } catch (error Exception) {
                Failure(directory, correction, error)
                throw Exception("publication_interrupted (interrupted_publication): " + error.Message)
            }
        }
    }
}
