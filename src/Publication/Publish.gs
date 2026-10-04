package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class Publication {
    shared {
        internal func VerificationReport(run Data, record JsonElement) string {
            let checks = J.Items(J.Get(run.Element(), "verification"))
            let commands = J.Items(J.Get(J.Get(record, "policy"), "verification"))
            if checks.Count == 0 || checks.Count != commands.Count {
                throw Exception("Missing independent verification results")
            }
            for i in 0 ... checks.Count {
                var code int32
                let check = checks[i]
                if (J.Text(check, "state") != "" && J.Text(check, "state") != "completed") || J.Get(check, "exit_code")
                    .ValueKind != JsonValueKind.Number ||
                    !J
                    .Get(check, "exit_code").TryGetInt32(out code) || code != 0 || J.Write(
                    J.Get(check, "command")
                ) != J.Write(commands[i]) {
                    throw Exception("Owner verification did not pass")
                }
            }
            let recovery = run.Flag(
                "recovered"
            ) ? "The original run failed independent verification. Explicit verification-only recovery passed all original checks without new inference. Original total runtime was not recorded.\n\n": ""
            return recovery +
                "Generated a patch for the approved issue. Independent owner verification: " +
                checks
                .Count
                .ToString() + "/" + checks.Count.ToString() +
                " checks passed.\n\nReview the changes against the issue's acceptance criteria and limitations."
        }

        internal func Usage(run Data) string {
            let usage = J.Get(run.Element(), "usage")
            let counts = Dictionary[string, Object?]()
            for key in[]string{"input_tokens", "cached_input_tokens", "output_tokens"} {
                let item = J.Get(usage, key)
                var count int64
                if item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out count) && count >= 0 {
                    counts[key] = count
                }
            }
            return J.Write(counts)
        }

        internal func Find(run Data) JsonElement {
            let query = "?state=all&head=" + Uri.EscapeDataString(run.Text("donor") + ":" + run.Text("branch")) +
                "&base=" +
                Uri.EscapeDataString(run.Text("base_branch"))
            let pulls = J.Items(GitHub.Api("repos/" + RepositoryIdentity.Repo(run.Text("repo")) + "/pulls" + query))
            return pulls.Count == 0 ? JsonElement{}: pulls[0]
        }

        internal func Publish(directory string) {
            if File.Exists(Path.Combine(directory, "correction.json")) {
                CorrectionPublication.Publish(directory)
                return
            }
            if Data.Load(directory).Number("version") == 2 {
                throw Exception("Version-2 runs use submit and the owner-installed coordinator")
            }
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let record = ContributionClaim.Recheck(run)
            if run.Text("state") != "generated" && run.Text("state") != "published" {
                throw Exception("Only a successful saved run can be published")
            }
            let marker = "<!-- tokate-run:" + run.Text("id") + " -->"
            let existing = Find(run)
            if existing.ValueKind != JsonValueKind.Undefined {
                if !J.Text(existing, "body").Contains(marker) || J.Text(J.Get(existing, "head"), "sha") != run.Text(
                    "commit"
                ) {
                    throw Exception("Another PR or commit already owns this branch")
                }
                ProtectedPaths.Remote(
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
            let receipt = ContributionReceipt.Native(run, run.Text("commit"))
            let values = Dictionary[string, string]()
            values["issue"] = run.Number("issue").ToString()
            values["report"] = PrBody.Report(VerificationReport(run, record))
            values["donor"] = run.Text("donor")
            values["model"] = run.Text("model")
            values["effort"] = run.Text("effort")
            values["seconds"] = run.Flag("recovered") ? "unknown (verification-only recovery: " + run.Number(
                "elapsed_seconds"
            )
                .ToString() + ")": run.Number("elapsed_seconds").ToString()
            values["base"] = run.Text("base")
            values["policy"] = run.Text("policy_hash")
            values["usage"] = Usage(run)
            values["receipt"] = marker + "\n<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            var body = J.Text(record, "template")
            body = Regex.Replace(body, "\\{\\{([a-z_]+)\\}\\}", (match Match) -> values[match.Groups[1].Value])
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
            SavePr(directory, run, pull)
        }

        internal func SavePr(directory string, run Data, pull JsonElement) {
            run.Fields["pr"] = J.Number(pull, "number")
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["state"] = "published"
            run.Save(directory)
            Terminal.Message("Draft PR: " + run.Text("pr_url"))
        }

        internal func OriginalReport(metadata JsonElement) string {
            var report = "Donor-declared contribution source: " + J.Text(metadata, "source") +
                ". The coordinator did not observe coding execution. Local verification pass is donor-reported to the coordinator. Owner CI and review must validate this exact commit."
            let correction = J.Get(metadata, "correction")
            if correction.ValueKind != JsonValueKind.Undefined {
                report += " Explicit correction " + J.Text(correction, "uuid") +
                    ": " +
                    (
                    J.Items(J.Get(correction, "tools"))
                        .Count == 0 ? "manual/unknown editing": "donor-reported tools " +
                        J.Write(J.Get(correction, "tools"))
                ) +
                    ". Original source/tools, model and usage declarations describe the original completed turn only. Correction editing is separate. " +
                    "Exact-commit local verification is reported by the donor; the coordinator did not observe it. Separate verification budget: " +
                    J
                    .Number(correction, "seconds").ToString() + " seconds."
            }
            return report
        }
    }
}
