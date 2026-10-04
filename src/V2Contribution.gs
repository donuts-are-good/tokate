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
            if !String.Equals(J.Text(viewer, "login"), run.Text("donor"), StringComparison.OrdinalIgnoreCase) || J.Get(
                viewer,
                "id"
            )
                .ToString() != J.Get(run.Element(), "donor_id").ToString() || state.Sha != run.Text("state_sha") ||
                J.Text(state.Value(), "approval_id") != run.Text("approval") || J.Text(
                J.Get(state.Value(), "reservation"),
                "reservation"
            ) != run.Text("id") {
                throw CliFailure("stale_approval", "Saved run has stale coordination authority")
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
                throw CliFailure("stale_approval", "Saved run differs from reservation and approval")
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            RequestData.Tools(J.Get(run.Element(), "tools"))
            policy.ValidateTools(J.Get(run.Element(), "tools"), run.Text("source"))
            let tools = J.Items(J.Get(run.Element(), "tools"))
            if run.Text("source") == "tokate" &&
                (run.Text("model") != J.Text(tools[0], "model") || run.Text("effort") != J.Text(tools[0], "effort")) {
                throw Exception("Saved execution differs from the declared tool; no model substitution is allowed")
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
                throw CliFailure("stale_approval", "Stale coordination revision")
            }
            state.Reservation(J.Get(viewer, "id"))
            let record = state.Check(repo, issue, donor)
            let source = args.Need("source")
            if source != "external" && source != "tokate" {
                throw Exception("source must be external or tokate")
            }
            var tools = args.Get("tools") == "" ? JsonElement{}: RequestData.FileData(args.Need("tools"), 8192)
            var selection = JsonElement{}
            if tools.ValueKind != JsonValueKind.Undefined {
                RequestData.Tools(tools)
                Policy(J.Write(J.Get(record, "policy"))).ValidateTools(tools, source)
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
                let policy = Policy(J.Write(J.Get(record, "policy")))
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
            if args.Get("verification-reserve") != "" {
                run.Fields["verification_reserve"] = RuntimeBudget.Reserve(args, run.Number("seconds"))
            }
            run.Fields["network"] = args.Get("allow-network") == "true"
            run.Fields["state"] = "claimed"
            if source == "tokate" {
                run.Fields["model"] = J.Text(J.Items(tools)[0], "model")
                run.Fields["effort"] = J.Text(J.Items(tools)[0], "effort")
                run.Fields["harness"] = J.Text(selection, "harness")
                run.Fields["provider"] = J.Text(selection, "provider")
                run.Fields["selection"] = selection
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
            PublicOutput.RunDirectory = directory
            if Directory.Exists(directory) {
                throw Exception("Saved contribution already exists; inspect it instead of overwriting")
            }
            Directory.CreateDirectory(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            if source == "tokate" {
                Terminal.Step(RuntimeBudget.Description(run))
            }
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
            Verification.Candidate(checkout)
            if Commands.Git(checkout, "rev-parse", "HEAD") != commit {
                throw Exception("Fetched commit differs from exact declaration")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), commit)
            run.Fields["commit"] = commit
            try {
                Commands.Git(checkout, "diff", "--check", run.Text("base"), commit)
                ProtectedPaths.Local(
                    checkout,
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    run.Text("base"),
                    commit
                )
            } catch (error Exception) {
                run.Fields["state"] = "failed"
                run.Fields["error"] = error.Message
                run.Save(directory)
                throw error
            }
            let timer = Stopwatch.StartNew()
            run.Fields["state"] = "verifying"
            run.Save(directory)
            let results = List[Object]()
            run.Fields["verification"] = results
            PublicOutput.FailureCode = "verification_failed"
            run.Fields["failure_stage"] = "owner_verification"
            run.Fields["failure_reason"] = "verification_failed"
            run.Save(directory)
            try {
                for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                    let remaining = run.Number("seconds") - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                    if remaining < 1 {
                        throw Exception("Verification budget exhausted")
                    }
                    let result = Verification.Check(
                        directory,
                        results,
                        command,
                        checkout,
                        run.Flag("network"),
                        remaining
                    )
                    if result.Code != 0 {
                        throw CliFailure(
                            "verification_failed",
                            "Independent external verification failed; no publication authority granted"
                        )
                    }
                }
                PublicOutput.FailureCode = "invalid_state"
                run.Fields["failure_stage"] = "changed_candidate"
                run.Fields["failure_reason"] = "candidate_changed"
                Verification.Candidate(checkout)
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
                run.Fields[
                    "tool_provenance"
                ] = "donor-reported; identity, usage and coding time not independently attested"
                run.Fields["state"] = "generated"
                run.Fields.Remove("failure_stage")
                run.Fields.Remove("failure_reason")
                run.Save(directory)
            } catch (error Exception) {
                run.Fields["state"] = "failed"
                run.Fields["error"] = error.Message
                run.Save(directory)
                throw error
            }
            Terminal.Message("Exact external commit passed independent verification. Use submit --run " + directory)
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
            let checkout = Verification.Candidate(Path.Combine(directory, "checkout"))
            if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("base") {
                throw Exception("Verified base changed")
            }
            Commands.Git(checkout, "diff", "--exit-code")
            ProtectedPaths.Local(checkout, J.Get(record, "policy"), J.Get(record, "approval"), run.Text("base"))
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
            ProtectedPaths.Local(
                checkout,
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                run.Text("base"),
                run.Text("commit")
            )
            run.Fields["verification_provenance"] = "tokate-observed locally"
            run.Fields[
                "tool_provenance"
            ] = "Tokate-observed harness invocation and requested model/effort; tool-reported usage, not identity attestation"
            run.Save(directory)
            Terminal.Message("Verified commit saved. Use submit --run " + directory)
        }

        internal func Posted(repo string, issue int32, actor JsonElement, request JsonElement) bool {
            RequestData.PositiveId(actor)
            var count int32
            for page in 1 ... 21 {
                let response = GitHub.Api(
                    "repos/" + repo + "/issues/" + issue.ToString() + "/comments?per_page=100&page=" + page.ToString()
                )
                if response.ValueKind != JsonValueKind.Array {
                    throw Exception("Cannot inspect complete request comment evidence")
                }
                let rows = J.Items(response)
                for row in rows {
                    if J.Get(J.Get(row, "user"), "id").ToString() != actor.ToString() {
                        continue
                    }
                    let body = J.Text(row, "body")
                    if !body.StartsWith("/tokate ", StringComparison.Ordinal) {
                        continue
                    }
                    var candidate JsonElement
                    try {
                        candidate = RequestData.Parse(body.Substring(8))
                    } catch {
                        continue
                    }
                    if J.Text(candidate, "uuid") != J.Text(request, "uuid") {
                        continue
                    }
                    let id = RequestData.PositiveId(J.Get(row, "id"))
                    let canonical = GitHub.Api("repos/" + repo + "/issues/comments/" + id.ToString())
                    if RequestData.PositiveId(J.Get(canonical, "id")) != id || RequestData.PositiveId(
                        J.Get(J.Get(canonical, "user"), "id")
                    ) != RequestData.PositiveId(actor) || J.Text(
                        canonical,
                        "issue_url"
                    ) != "https://api.github.com/repos/" +
                        repo +
                        "/issues/" +
                        issue.ToString() || J.Text(canonical, "body") != body || RequestData.Canonical(
                        candidate
                    ) != RequestData.Canonical(request) {
                        throw Exception("Request UUID has changed actor, contents, repository or issue evidence")
                    }
                    count++
                }
                if rows.Count < 100 {
                    if count > 1 {
                        throw Exception("Ambiguous duplicate request comments")
                    }
                    return count == 1
                }
            }
            throw Exception("Request comment inspection exceeded its bounded history; no write made")
        }

        internal func Request(args Args) {
            let path = Path.GetFullPath(args.Need("file"))
            let value = RequestData.FileData(path, 8192)
            RequestData.Request(value)
            let info = GitHub.Api("repos/" + Data.Repo(args.Need("repo")))
            let repo = Data.Repo(J.Text(info, "full_name"))
            if !String.Equals(repo, args.Need("repo"), StringComparison.OrdinalIgnoreCase) {
                throw Exception("Canonical request repository differs from command")
            }
            RequestData.PositiveId(J.Get(info, "id"))
            let issue = args.Number("issue")
            let viewer = GitHub.Api("user")
            let actor = J.Get(viewer, "id")
            RequestData.PositiveId(actor)
            let binding = RequestData.Binding(actor, value)
            let journal = path + ".posting.json"
            if FileInfo(journal).LinkTarget != nil {
                throw Exception("Request posting journal must not be a symbolic link")
            }
            if File.Exists(journal) {
                let saved = RequestData.FileData(journal, 16384)
                if J.Text(saved, "repo") != repo || J.Number(saved, "issue") != issue || J.Get(saved, "actor")
                    .ToString() != actor.ToString() || J.Text(saved, "binding") != binding || RequestData.Canonical(
                    J.Get(saved, "request")
                ) != RequestData.Canonical(value) {
                    throw Exception("Saved request UUID binding changed; use a new file and UUID for new work")
                }
            }
            let state = CoordinationState.Load(repo, issue)
            let outcome = RequestData.Recorded(state.Value(), actor, value)
            if outcome.ValueKind != JsonValueKind.Undefined {
                Terminal.Json(outcome, "Recorded request outcome; no comment posted")
                return
            }
            if Posted(repo, issue, actor, value) {
                Terminal.Message("Exact request already posted; awaiting coordinator outcome")
                return
            }
            if File.Exists(journal) {
                throw Exception(
                    "interrupted_publication: saved request has no unique physical comment; refusing blind retry"
                )
            }
            if state.Sha != J.Text(value, "expected") || J.Text(state.Value(), "approval_id") != J.Text(
                value,
                "approval"
            ) {
                throw Exception("Stale state or approval; no request posted")
            }
            state.Check(repo, issue, Data.Login(J.Text(viewer, "login")))
            var expires int64
            if J.Text(value, "action") != "claim" {
                state.Reservation(actor)
                expires = CoordinationState.Unix(J.Get(state.Value(), "reservation"), "expires")
            }
            {
                using let file = FileStream(
                    journal,
                    FileStreamOptions{
                        Mode: FileMode.CreateNew,
                        Access: FileAccess.Write,
                        Share: FileShare.None,
                        UnixCreateMode: UnixFileMode.UserRead | UnixFileMode.UserWrite
                    }
                )
                using let writer = StreamWriter(file)
                writer.WriteLine(
                    J.Write(J.Map("repo", repo, "issue", issue, "actor", actor, "binding", binding, "request", value))
                )
                writer.Flush()
                file.Flush(true)
            }
            try {
                let posted = GitHub.Api(
                    "repos/" + repo + "/issues/" + issue.ToString() + "/comments",
                    J.Map("body", "/tokate " + RequestData.Canonical(value)),
                    expires: expires
                )
                if J.Text(posted, "issue_url") != "https://api.github.com/repos/" +
                    repo +
                    "/issues/" +
                    issue.ToString() || RequestData.PositiveId(
                    J.Get(J.Get(posted, "user"), "id")
                ) != RequestData.PositiveId(actor) || J.Text(posted, "body") != "/tokate " + RequestData.Canonical(
                    value
                ) {
                    throw Exception("Comment write response lacks exact request evidence")
                }
                RequestData.PositiveId(J.Get(posted, "id"))
            } catch (error Exception) {
                let latest = CoordinationState.Load(repo, issue)
                if RequestData.Recorded(latest.Value(), actor, value)
                    .ValueKind == JsonValueKind.Undefined &&
                    !Posted(repo, issue, actor, value) {
                    throw Exception(
                        "Uncertain request write; no unique canonical evidence. No POST retry made. " + error.Message
                    )
                }
            }
            Terminal.Message("Request posted; coordinator outcome is recorded in the issue state ref")
        }

        private func PublicationRequest(run Data) JsonElement -> J.Parse(
            J.Write(
                J.Map(
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
            )
        )

        internal func Submit(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            if File.Exists(Path.Combine(directory, "correction.json")) {
                CorrectionPublication.Submit(directory)
                return
            }
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let path = Path.Combine(directory, "request.json")
            if run.Text("publication_uuid") != "" && File.Exists(path) {
                let saved = RequestData.FileData(path, 8192)
                let expected = PublicationRequest(run)
                if RequestData.Canonical(saved) != RequestData.Canonical(expected) {
                    throw Exception("Saved publication UUID binding changed")
                }
                let viewer = GitHub.Api("user")
                if J.Get(viewer, "id").ToString() != J.Get(run.Element(), "donor_id").ToString() {
                    throw Exception("Saved publication belongs to another authenticated actor")
                }
                let state = CoordinationState.Load(Data.Repo(run.Text("repo")), run.Number("issue"))
                let outcome = RequestData.Recorded(state.Value(), J.Get(viewer, "id"), saved)
                if outcome.ValueKind != JsonValueKind.Undefined {
                    if J.Text(state.Value(), "approval_id") != run.Text("approval") || J.Text(
                        J.Get(state.Value(), "reservation"),
                        "reservation"
                    ) != run.Text("id") {
                        throw Exception("Saved publication has stale coordination authority")
                    }
                    state.Reservation(J.Get(viewer, "id"))
                    state.Check(Data.Repo(run.Text("repo")), run.Number("issue"), run.Text("donor"))
                    Terminal.Json(outcome, "Recorded publication outcome; no comment posted")
                    return
                }
            }
            let record = Recheck(run)
            if run.Text("state") != "generated" || run.Text("commit") == "" {
                throw Exception("Only an independently verified exact commit can be submitted")
            }
            Publication.VerificationReport(run, record)
            let checkout = Verification.Candidate(Path.Combine(directory, "checkout"))
            if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("commit") || Commands.Git(
                checkout,
                "status",
                "--porcelain"
            ) != "" {
                throw Exception("Verified checkout changed")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), run.Text("commit"))
            Commands.Git(checkout, "diff", "--check", run.Text("base"), run.Text("commit"))
            ProtectedPaths.Local(
                checkout,
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                run.Text("base"),
                run.Text("commit")
            )
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
                    run.Text("commit") + ":refs/heads/" + run.Text("branch")
                )
                Recheck(run)
            }
            if run.Text("publication_uuid") == "" {
                run.Fields["publication_uuid"] = Guid.NewGuid().ToString("D")
                run.Save(directory)
            }
            let request = PublicationRequest(run)
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

        internal func VerifyReceipt(
            repo string,
            number int32,
            pull JsonElement,
            receipt JsonElement,
            ready bool = true,
            paths bool = true
        ) Data {
            RequestData.Keys(
                receipt,
                "version,repo,issue,approval,expected,reservation,donor,head,correction,amendment,synchronizations"
            )
            let state = CoordinationState.Load(repo, J.Number(receipt, "issue"))
            let contribution = J.Get(state.Value(), "contribution")
            let metadata = J.Get(contribution, "metadata")
            let current = Amendment.Current(state.Value())
            let exactHead = Amendment.Head(state.Value())
            let donor = Data.Login(J.Text(receipt, "donor"))
            let record = state.Check(repo, J.Number(receipt, "issue"), donor)
            state.Reservation(J.Get(contribution, "actor"))
            let stateCommit = GitHub.Api("repos/" + repo + "/git/commits/" + state.Sha)
            let parents = J.Items(J.Get(stateCommit, "parents"))
            if parents.Count != 1 || J.Text(parents[0], "sha") != J.Text(receipt, "expected") || J.Text(
                current,
                "expected"
            ) != J
                .Text(receipt, "expected") {
                throw CliFailure("stale_approval", "Receipt does not match the authoritative contribution revision")
            }
            if J.Text(receipt, "repo") != repo || J.Text(receipt, "approval") != J.Text(state.Value(), "approval_id") ||
                J.Text(receipt, "reservation") != J.Text(J.Get(state.Value(), "reservation"), "reservation") ||
                J.Number(J.Get(current, "outcome"), "pr") != number || J.Text(receipt, "head") != exactHead || J.Text(
                J.Get(pull, "head"),
                "sha"
            ) != exactHead ||
                J.Text(J.Get(pull, "head"), "ref") != J.Text(metadata, "branch") || J.Text(
                J.Get(J.Get(pull, "head"), "repo"),
                "full_name"
            ) != J.Text(metadata, "fork") || J.Text(J.Get(pull, "base"), "ref") != J.Text(
                J.Get(record, "approval"),
                "base_branch"
            ) {
                throw CliFailure("stale_approval", "PR receipt lacks current exact-commit coordination authority")
            }
            let policy = Policy(J.Write(J.Get(record, "policy")))
            policy.ValidateTools(J.Get(metadata, "tools"), J.Text(metadata, "source"))
            let amendment = J.Get(receipt, "amendment")
            if current.GetRawText() != contribution.GetRawText() {
                Amendment.ValidateReceipt(amendment, policy)
                let report = Amendment.Summary(
                    J.Text(amendment, "previous"),
                    exactHead,
                    J.Number(amendment, "seconds"),
                    J.Get(amendment, "tools")
                )
                if Amendment.ReportText(J.Text(pull, "body"), report) != report {
                    throw Exception("PR amendment report differs from coordination authority")
                }
                if J.Text(amendment, "id") != J.Text(current, "request") || J.Text(amendment, "previous") != J.Text(
                    current,
                    "previous"
                ) ||
                    J.Number(amendment, "seconds") != J.Number(current, "seconds") || RequestData.Canonical(
                    J.Get(amendment, "tools")
                ) != RequestData
                    .Canonical(J.Get(current, "tools")) {
                    throw Exception("Amendment receipt differs from current coordination record")
                }
            } else if amendment.ValueKind != JsonValueKind.Undefined {
                throw Exception("Receipt claims an amendment without coordination authority")
            }
            let history = Synchronization.History(receipt)
            if J.Text(amendment, "sync") != J.Text(current, "sync") || RequestData.Canonical(history) != RequestData
                .Canonical(Synchronization.History(current)) {
                throw Exception("Synchronization receipt differs from authoritative coordination history")
            }
            let correction = J.Get(receipt, "correction")
            if !Tokate.Correction.Same(correction, J.Get(metadata, "correction")) {
                throw Exception("Correction receipt differs from authoritative publication metadata")
            }
            if correction.ValueKind != JsonValueKind.Undefined {
                RequestData.Correction(correction, J.Text(metadata, "head"), J.Get(record, "policy"))
            }
            Synchronization.Live(
                repo,
                number,
                record,
                J.Text(state.Value(), "approval_id"),
                history,
                J.Text(metadata, "fork"),
                J.Text(metadata, "branch"),
                exactHead,
                ready: ready
            )
            if paths && history.GetArrayLength() > 0 {
                Synchronization.Remote(
                    repo,
                    policy.Value,
                    J.Get(record, "approval"),
                    J.Text(J.Get(record, "approval"), "base"),
                    history,
                    J.Text(metadata, "fork"),
                    exactHead
                )
            } else if paths {
                ProtectedPaths.Remote(
                    repo,
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    J.Text(J.Get(record, "approval"), "base"),
                    J.Text(metadata, "fork"),
                    exactHead
                )
            }
            if history.GetArrayLength() > 0 {
                let live = CoordinationState.Load(repo, J.Number(receipt, "issue"))
                if live.Sha != state.Sha {
                    throw Exception("Coordination authority changed during receipt validation")
                }
                live.Check(repo, J.Number(receipt, "issue"), donor)
                live.Reservation(J.Get(contribution, "actor"))
                Synchronization.Live(
                    repo,
                    number,
                    record,
                    J.Text(state.Value(), "approval_id"),
                    history,
                    J.Text(metadata, "fork"),
                    J.Text(metadata, "branch"),
                    exactHead,
                    ready: ready
                )
            }
            let run = Data()
            run.Fields["version"] = 2
            run.Fields["repo"] = repo
            run.Fields["pr"] = number
            run.Fields["commit"] = exactHead
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["policy"] = J.Get(record, "policy")
            Publication.Binding(run, receipt, J.Get(record, "approval"), state.Sha)
            return run
        }
    }
}
