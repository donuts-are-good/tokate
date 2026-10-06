package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class Submission {
    shared {
        internal func Commit(directory string) {
            using let lease = Preparation.Lease(directory)
            let run = Data.Load(directory)
            let record = ContributionClaim.RecheckV2(run)
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
            PublicSummary.Bind(run, patch)
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
            let summary = PublicSummary.ForHead(run, run.Text("commit"))
            if summary.ValueKind != JsonValueKind.Undefined {
                run.Fields["public_summary"] = summary
            }
            run.Fields["verification_provenance"] = "tokate-observed locally"
            run.Fields[
                "tool_provenance"
            ] = "Tokate-observed harness invocation and requested model/effort; tool-reported usage, not identity attestation"
            run.Save(directory)
            Terminal.Message("Verified commit saved. Use submit --run " + directory)
        }

        internal func Posted(repo string, issue int32, actor JsonElement, request JsonElement) bool {
            RepositoryIdentity.PositiveId(actor)
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
                    let id = RepositoryIdentity.PositiveId(J.Get(row, "id"))
                    let canonical = GitHub.Api("repos/" + repo + "/issues/comments/" + id.ToString())
                    let failure = "Request UUID has changed actor, contents, repository or issue evidence"
                    if RepositoryIdentity.PositiveId(J.Get(canonical, "id")) != id {
                        throw Exception(failure)
                    }
                    let author = J.Get(J.Get(canonical, "user"), "id")
                    if RepositoryIdentity.PositiveId(author) != RepositoryIdentity.PositiveId(actor) {
                        throw Exception(failure)
                    }
                    if !RepositoryIdentity.IsIssueUrl(J.Text(canonical, "issue_url"), repo, issue) {
                        throw Exception(failure)
                    }
                    if J.Text(canonical, "body") != body {
                        throw Exception(failure)
                    }
                    if RequestData.Canonical(candidate) != RequestData.Canonical(request) {
                        throw Exception(failure)
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
            let info = GitHub.Api("repos/" + RepositoryIdentity.Repo(args.Need("repo")))
            let repo = RepositoryIdentity.Repo(J.Text(info, "full_name"))
            if !String.Equals(repo, args.Need("repo"), StringComparison.OrdinalIgnoreCase) {
                throw Exception("Canonical request repository differs from command")
            }
            RepositoryIdentity.PositiveId(J.Get(info, "id"))
            let issue = args.Number("issue")
            let viewer = GitHub.Api("user")
            let actor = J.Get(viewer, "id")
            RepositoryIdentity.PositiveId(actor)
            let binding = RequestData.Binding(actor, value)
            let journal = path + ".posting.json"
            if FileInfo(journal).LinkTarget != nil {
                throw Exception("Request posting journal must not be a symbolic link")
            }
            if File.Exists(journal) {
                let saved = RequestData.FileData(journal, 16384)
                let failure = "Saved request UUID binding changed; use a new file and UUID for new work"
                if !RepositoryIdentity.SameRepo(J.Text(saved, "repo"), repo) || J.Number(saved, "issue") != issue {
                    throw Exception(failure)
                }
                let savedActor = J.Get(saved, "actor").ToString()
                if savedActor != actor.ToString() || J.Text(saved, "binding") != binding {
                    throw Exception(failure)
                }
                if RequestData.Canonical(J.Get(saved, "request")) != RequestData.Canonical(value) {
                    throw Exception(failure)
                }
            }
            let state = CoordinationState.Load(repo, issue)
            if J.Text(value, "action") != "release" && AccessState.Task(J.Get(state.Value(), "approval")) {
                state.Check(repo, issue, RepositoryIdentity.Login(J.Text(viewer, "login")), actor)
            }
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
            if J.Text(value, "action") != "release" {
                state.Check(repo, issue, RepositoryIdentity.Login(J.Text(viewer, "login")), actor)
            }
            var expires int64
            if J.Text(value, "action") != "claim" {
                if LeaseLifecycle.Transition(J.Text(value, "action")) {
                    LeaseLifecycle.Owner(state, actor)
                    if !LeaseLifecycle.Supported(state.Value()) {
                        throw Exception("Legacy lease transitions are unsupported")
                    }
                } else {
                    state.Reservation(actor)
                    LeaseLifecycle.Fence(state, J.Text(J.Get(value, "metadata"), "attempt"))
                }
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
            WriteRequest(repo, issue, actor, value, expires)
            Terminal.Message("Request posted; coordinator outcome is recorded in the issue state ref")
        }

        internal func WriteRequest(repo string, issue int32, actor JsonElement, request JsonElement, expires int64) {
            try {
                let posted = GitHub.Api(
                    "repos/" + repo + "/issues/" + issue.ToString() + "/comments",
                    J.Map("body", "/tokate " + RequestData.Canonical(request)),
                    expires: expires
                )
                let failure = "Comment write response lacks exact request evidence"
                if !RepositoryIdentity.IsIssueUrl(J.Text(posted, "issue_url"), repo, issue) {
                    throw Exception(failure)
                }
                let author = J.Get(J.Get(posted, "user"), "id")
                if RepositoryIdentity.PositiveId(author) != RepositoryIdentity.PositiveId(actor) || J.Text(
                    posted,
                    "body"
                ) != "/tokate " +
                    RequestData.Canonical(request) {
                    throw Exception(failure)
                }
                RepositoryIdentity.PositiveId(J.Get(posted, "id"))
            } catch (error Exception) {
                let latest = CoordinationState.Load(repo, issue)
                if RequestData.Recorded(latest.Value(), actor, request)
                    .ValueKind == JsonValueKind.Undefined &&
                    !Posted(repo, issue, actor, request) {
                    throw Exception(
                        "Uncertain request write; no unique canonical evidence. No POST retry made. " + error.Message
                    )
                }
            }
        }

        internal func PublicationRequest(run Data, correction Data? = nil) JsonElement {
            let metadata = J.Map(
                "fork",
                run.Text("head_repo"),
                "branch",
                run.Text("branch"),
                "head",
                correction?.Text("commit") ?? run.Text("commit"),
                "source",
                run.Text("source"),
                "tools",
                J.Get(run.Element(), "tools"),
                "verification",
                "donor-reported-pass"
            )
            if run.Text("attempt") != "" {
                metadata["attempt"] = run.Text("attempt")
            }
            if correction != nil {
                metadata["correction"] = Correction.Provenance(correction)
            }
            var summary = PublicSummary.ForHead(run, run.Text("commit"))
            if let current = correction {
                summary = PublicSummary.ForHead(current, current.Text("commit"))
            }
            return J.Parse(
                J.Write(
                    J.Map(
                        "uuid",
                        correction?.Text("publication_uuid") ?? run.Text("publication_uuid"),
                        "expected",
                        run.Text("publication_expected") == "" ? run.Text("state_sha"): run.Text(
                            "publication_expected"
                        ),
                        "approval",
                        run.Text("approval"),
                        "action",
                        "publish",
                        "metadata",
                        PublicSummary.Attach(metadata, summary)
                    )
                )
            )
        }

        internal func Submit(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = Preparation.Lease(directory)
            let run = Data.Load(directory)
            if File.Exists(Path.Combine(directory, "correction.json")) {
                CorrectionPublication.SubmitLocked(directory, run)
                return
            }
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
                let state = CoordinationState.Load(RepositoryIdentity.Repo(run.Text("repo")), run.Number("issue"))
                let outcome = RequestData.Recorded(state.Value(), J.Get(viewer, "id"), saved)
                if outcome.ValueKind != JsonValueKind.Undefined {
                    if J.Text(state.Value(), "approval_id") != run.Text("approval") || J.Text(
                        J.Get(state.Value(), "reservation"),
                        "reservation"
                    ) != run.Text("id") {
                        throw Exception("Saved publication has stale coordination authority")
                    }
                    state.Reservation(J.Get(viewer, "id"))
                    state.Check(
                        RepositoryIdentity.Repo(run.Text("repo")),
                        run.Number("issue"),
                        run.Text("donor"),
                        J.Get(viewer, "id")
                    )
                    Terminal.Json(outcome, "Recorded publication outcome; no comment posted")
                    return
                }
            }
            let record = ContributionClaim.RecheckV2(run)
            if run.Text("state") != "generated" || run.Text("commit") == "" {
                throw Exception("Only an independently verified exact commit can be submitted")
            }
            Verification.Results(run, record)
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
                AccessState.Check(
                    run.Text("repo"),
                    run.Number("issue"),
                    J.Get(record, "approval"),
                    J.Get(run.Element(), "donor_id")
                )
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
                ContributionClaim.RecheckV2(run)
            }
            if run.Text("publication_uuid") == "" {
                let live = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
                live.Reservation(J.Get(run.Element(), "donor_id"))
                LeaseLifecycle.Fence(live, run.Text("attempt"))
                run.Fields["publication_expected"] = live.Sha
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
    }
}
