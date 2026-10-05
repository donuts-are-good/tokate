package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class ExternalContribution {
    shared {
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
            let record = ContributionClaim.RecheckV2(run)
            let commit = RepositoryIdentity.CommitSha(args.Need("commit"))
            let summary = PublicSummary.FileSummary(args.Get("summary"), commit)
            if summary.ValueKind != JsonValueKind.Undefined {
                run.Fields["public_summary"] = summary
            }
            let metadata = J.Parse(
                J.Write(J.Map("fork", run.Text("head_repo"), "branch", run.Text("branch"), "head", commit))
            )
            RepositoryAccess.ValidateFork(run.Text("repo"), metadata, J.Get(run.Element(), "donor_id"))
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
                    let result = Terminal.Verify(
                        directory,
                        results,
                        command,
                        checkout,
                        run.Flag("network"),
                        remaining,
                        progressBudget: RuntimeBudget(timer, run.Number("seconds"))
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
                ContributionClaim.RecheckV2(run)
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
    }
}
