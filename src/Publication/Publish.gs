package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class Publication {
    shared {
        internal func Usage(run Data) string -> PublicSummary.Usage(J.Get(run.Element(), "usage"))

        internal func Pulls(run Data) List[JsonElement] {
            let pulls = List[JsonElement]()
            for page in 1 ... 21 {
                let response = GitHub.Api(
                    "repos/" + RepositoryIdentity.Repo(run.Text("repo")) +
                        "/pulls?state=all&head=" +
                        Uri.EscapeDataString(run.Text("donor") + ":" + run.Text("branch")) +
                        "&per_page=100&page=" +
                        page.ToString()
                )
                if response.ValueKind != JsonValueKind.Array {
                    throw Exception("interrupted_publication: matching PR history is invalid; refusing publication")
                }
                let rows = J.Items(response)
                pulls.AddRange(rows)
                if rows.Count < 100 {
                    return pulls
                }
            }
            throw Exception("interrupted_publication: matching PR history is incomplete; refusing publication")
        }

        internal func Match(run Data, pull JsonElement, expectedReceipt JsonElement) {
            let marker = run.Number("version") == 1 ? "<!-- tokate-run:" + run.Text("id") + " -->":
            "<!-- tokate-v2:" + run.Text("id") + " -->"
            let body = J.Text(pull, "body")
            let failure = "interrupted_publication: physical PR differs from exact saved run/head/receipt"
            let receipt = RequestData.Parse(PrBody.ReceiptText(body, failure, failure))
            if !RepositoryIdentity.SameRepo(J.Text(receipt, "repo"), J.Text(expectedReceipt, "repo")) {
                throw Exception(failure)
            }
            let comparable = Dictionary[string, Object?]()
            for field in receipt.EnumerateObject() {
                comparable[field.Name] = field.Name == "repo" ? J.Text(expectedReceipt, "repo"): field.Value
            }
            if !RequestData.Same(J.Parse(J.Write(comparable)), expectedReceipt) || !body.Contains(marker) ||
                body.IndexOf(marker, StringComparison.Ordinal) != body.LastIndexOf(marker, StringComparison.Ordinal) {
                throw Exception(failure)
            }
            let head = J.Get(pull, "head")
            let base = J.Get(pull, "base")
            if J.Text(head, "sha") != run.Text("commit") || J.Text(head, "ref") != run.Text("branch") ||
                !RepositoryIdentity.SameRepo(J.Text(J.Get(head, "repo"), "full_name"), run.Text("head_repo")) {
                throw Exception(failure)
            }
            if run.Number("version") == 1 && !RepositoryIdentity.SameDonor(J.Get(pull, "user"), run) {
                throw Exception(failure)
            }
            let baseRepo = J.Text(J.Get(base, "repo"), "full_name")
            let mergedAt = J.Get(pull, "merged_at").ValueKind
            if J.Text(base, "ref") != run.Text("base_branch") || !RepositoryIdentity.SameRepo(
                baseRepo,
                run.Text("repo")
            ) ||
                J.Text(pull, "state") != "open" || !J.Bool(pull, "draft") || J.Bool(pull, "merged") ||
                (mergedAt != JsonValueKind.Undefined && mergedAt != JsonValueKind.Null) ||
                J.Number(pull, "number") < 1 {
                throw Exception(failure)
            }
        }

        internal func Find(run Data, expectedReceipt JsonElement) JsonElement {
            let pulls = Pulls(run)
            if pulls.Count > 1 {
                throw Exception("interrupted_publication: ambiguous physical PRs; intent preserved")
            }
            if pulls.Count == 0 {
                return JsonElement{}
            }
            Match(run, pulls[0], expectedReceipt)
            return pulls[0]
        }

        internal func Publish(directory string) {
            using let lease = Preparation.Lease(directory)
            let run = Data.Load(directory)
            if run.Number("version") == 2 {
                throw Exception("Version-2 runs use submit and the owner-installed coordinator")
            }
            if File.Exists(Path.Combine(directory, "correction.json")) {
                CorrectionPublication.PublishLocked(
                    directory,
                    run,
                    Data.Read(Path.Combine(directory, "correction.json")),
                    Correction.Authority(directory, run)
                )
                return
            }
            let record = ContributionClaim.Recheck(run)
            if run.Text("state") != "generated" && run.Text("state") != "published" {
                throw Exception("Only a successful saved run can be published")
            }
            let marker = "<!-- tokate-run:" + run.Text("id") + " -->"
            let fields = ContributionReceipt.Native(run, run.Text("commit"))
            let amendments = J.Items(J.Get(run.Element(), "amendments"))
            if amendments.Count > 0 {
                let latest = amendments[amendments.Count - 1]
                let amendment = Data.Load(Path.Combine(directory, "amendments", run.Text("commit")))
                let original = OriginalEvidence.Amended(directory, run, amendment)
                if amendment.Text("state") != "published" || amendment.Text("commit") != run.Text("commit") || J.Text(
                    latest,
                    "head"
                ) != run.Text("commit") || J.Text(latest, "id") != amendment.Text("id") {
                    throw Exception("Saved published amendment differs from current contribution")
                }
                fields["original_head"] = original.Text("commit")
                let publicAmendment = J.Parse(J.Write(Amendment.PublicRecord(amendment)))
                Amendment.ValidateReceipt(publicAmendment, Policy(J.Write(J.Get(record, "policy"))), run.Text("commit"))
                fields["amendment"] = publicAmendment
                Synchronization.Keep(fields, Synchronization.History(amendment.Element()))
            }
            let expectedReceipt = J.Parse(J.Write(fields))
            let existing = Find(run, expectedReceipt)
            if existing.ValueKind != JsonValueKind.Undefined {
                GitHubPathEvidence.Check(
                    run.Text("repo"),
                    J.Get(record, "policy"),
                    J.Get(record, "approval"),
                    run.Text("base"),
                    run.Text("head_repo"),
                    run.Text("commit")
                )
                SavePr(directory, run, existing)
                return
            }
            let checkout = Verification.Candidate(Path.Combine(directory, "checkout"))
            if run.Text("commit") == "" {
                if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("base") {
                    throw Exception("Saved checkout HEAD changed")
                }
                Commands.Git(checkout, "add", "-A")
                ProtectedPaths.Local(checkout, J.Get(record, "policy"), J.Get(record, "approval"), run.Text("base"))
                Commands.Git(checkout, "diff", "--cached", "--check")
                let patch = Commands.Git(checkout, "diff", "--cached", "--binary", run.Text("base"))
                if patch == "" || patch + "\n" != File.ReadAllText(Path.Combine(directory, "changes.patch")) {
                    throw Exception("Saved patch changed. Inspect this run before publishing")
                }
                Commands.Git(
                    checkout,
                    "-c",
                    "user.name=" + run.Text("donor"),
                    "-c",
                    "user.email=" + J.Get(run.Element(), "donor_id").ToString() + "+" + run.Text("donor") +
                        "@users.noreply.github.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    J.Text(J.Get(record, "issue"), "title")
                )
                run.Fields["commit"] = Commands.Git(checkout, "rev-parse", "HEAD")
                run.Save(directory)
            }
            if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("commit") || Commands.Git(
                checkout,
                "status",
                "--porcelain"
            ) != "" {
                throw Exception("Saved commit or checkout changed")
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), run.Text("commit"))
            let committedPatch = Commands.Git(checkout, "diff", "--binary", run.Text("base"), run.Text("commit"))
            if committedPatch + "\n" != File.ReadAllText(Path.Combine(directory, "changes.patch")) {
                throw Exception("Canonical commit differs from the independently verified patch")
            }
            ProtectedPaths.Local(
                checkout,
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                run.Text("base"),
                run.Text("commit")
            )
            PublicSummary.Bind(run, committedPatch)
            run.Save(directory)
            let receipt = ContributionReceipt.Native(run, run.Text("commit"))
            let values = Dictionary[string, string]()
            values["issue"] = run.Number("issue").ToString()
            values["report"] = PrBody.Report(PrBody.ManagedReport(run, record))
            values["donor"] = run.Text("donor")
            values["model"] = PublicSummary.Identifier(run.Text("model"))
            values["effort"] = PublicSummary.Identifier(run.Text("effort"))
            values["seconds"] = run.Flag("recovered") ? "unknown (verification-only recovery: " + run.Number(
                "elapsed_seconds"
            )
                .ToString() + ")": run.Number("elapsed_seconds").ToString()
            values["base"] = run.Text("base")
            values["policy"] = run.Text("policy_hash")
            values["usage"] = Usage(run)
            values["receipt"] = marker + "\n<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            var body = J.Text(record, "template")
            body = PrBody.Render(body, values)
            File.WriteAllText(Path.Combine(directory, "pr-body.md"), body)
            let publication = J.Map(
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
            File.WriteAllText(Path.Combine(directory, "publication.json"), J.Write(publication) + "\n")
            Terminal.Message("Publication content: " + Path.Combine(directory, "publication.json"))
            let remote = GitHub.Api("repos/" + run.Text("head_repo") + "/git/ref/heads/" + run.Text("branch"))
            let sha = J.Text(J.Get(remote, "object"), "sha")
            if sha != run.Text("base") && sha != run.Text("commit") {
                throw Exception("Remote claim changed. Refusing to overwrite it")
            }
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
            ContributionClaim.Recheck(run)
            let pull = GitHub.Api("repos/" + run.Text("repo") + "/pulls", publication)
            Match(run, pull, J.Parse(J.Write(receipt)))
            SavePr(directory, run, pull)
        }

        internal func SavePr(directory string, run Data, pull JsonElement) {
            run.Fields["pr"] = J.Number(pull, "number")
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["state"] = "published"
            run.Save(directory)
            Terminal.Message("Draft PR: " + run.Text("pr_url"))
        }
    }
}
