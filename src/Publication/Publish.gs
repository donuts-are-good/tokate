package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class Publication {
    shared {
        internal func Push(checkout string, run Data, commit string) {
            Commands.Git(
                checkout,
                "-c",
                "credential.helper=",
                "-c",
                "credential.helper=!gh auth git-credential",
                "push",
                "https://github.com/" + run.Text("head_repo") + ".git",
                commit + ":refs/heads/" + run.Text("branch")
            )
        }

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
            let marker = "<!-- tokate-v2:" + run.Text("id") + " -->"
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

        internal func SavePr(directory string, run Data, pull JsonElement) {
            run.Fields["pr"] = J.Number(pull, "number")
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["state"] = "published"
            run.Save(directory)
            Terminal.Message("Draft PR: " + run.Text("pr_url"))
        }
    }
}
