package Tokate

import System
import System.IO

internal class Checks {
    shared {
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
            let run = directory == "" ? ReceiptVerification.Verify(
                RepositoryIdentity.Repo(args.Need("repo")),
                args.Number("pr")
            ): Data.Load(directory)
            if run.Number("pr") == 0 {
                throw Exception("No PR has been published for this run")
            }
            var previous string = ""
            while true {
                ApiTransport.CheckDeadline()
                let verified = ReceiptVerification.Verify(run.Text("repo"), run.Number("pr"))
                if verified.Text("commit") != run.Text("commit") {
                    throw Exception("Saved commit differs from PR receipt")
                }
                let policy = Policy(J.Write(J.Get(verified.Element(), "policy")))
                let pullPath = "repos/" + run.Text("repo") + "/pulls/" + run.Number("pr").ToString()
                let pull = GitHub.Api(pullPath)
                if J.Text(J.Get(pull, "head"), "sha") != run.Text("commit") {
                    throw Exception("PR head changed. Saved run no longer describes this PR")
                }
                let rows = CommitChecks.Read(run.Text("repo"), run.Text("commit"))
                var failed bool
                var pending bool
                for row in J.Items(rows) {
                    let bucket = J.Text(row, "bucket")
                    if bucket == "fail" || bucket == "cancel" {
                        failed = true
                    } else if bucket != "pass" && bucket != "skipping" {
                        pending = true
                    }
                }
                for name in J.Items(J.Get(policy.Value, "required_checks")) {
                    var passed bool
                    for row in J.Items(rows) {
                        if J.Text(row, "name") == name.GetString() && J.Text(row, "bucket") == "pass" {
                            passed = true
                        }
                    }
                    if !passed {
                        pending = true
                    }
                }
                let latest = GitHub.Api(pullPath)
                if J.Text(J.Get(latest, "head"), "sha") != run.Text("commit") {
                    throw Exception("PR changed while reading checks")
                }
                let live = ReceiptVerification.Verify(run.Text("repo"), run.Number("pr"))
                if live.Text("commit") != run.Text("commit") {
                    throw Exception("PR authority changed while reading checks")
                }
                ApiTransport.CheckDeadline()
                let status = failed ? "failed": (pending ? "pending": "passed")
                PublicOutput.Checks(run, rows, status)
                let snapshot = J.Write(J.Map("head", run.Text("commit"), "status", status, "checks", rows))
                if snapshot != previous {
                    if directory != "" {
                        let path = Path.Combine(directory, "checks.json")
                        if !File.Exists(path) || File.ReadAllText(path) != snapshot {
                            File.WriteAllText(path, snapshot)
                        }
                    }
                    Terminal.Message(
                        "Checks " + status + ": " + run.Text("pr_url"),
                        failed ? "red": (pending ? "yellow": "green")
                    )
                    if !PublicOutput.Enabled {
                        Terminal.Checks(rows)
                    }
                    previous = snapshot
                }
                if failed {
                    return 1
                }
                if !pending {
                    return 0
                }
                if args.Get("watch") != "true" {
                    return 8
                }
                ApiTransport.PollWait()
            }
        }
    }
}
