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
                if !J.Get(check, "exit_code").TryGetInt32(out code) || code != 0 || J.Write(
                    J.Get(check, "command")
                ) != J.Write(commands[i]) {
                    throw Exception("Owner verification did not pass")
                }
            }
            return "Generated a patch for the approved issue. Independent owner verification: " +
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
            let pulls = J.Items(GitHub.Api("repos/" + Data.Repo(run.Text("repo")) + "/pulls" + query))
            return pulls.Count == 0 ? JsonElement{}: pulls[0]
        }

        internal func Publish(directory string) {
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            let record = Workflow.Recheck(run)
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
                SavePr(directory, run, existing)
                return
            }
            let checkout = Path.Combine(directory, "checkout")
            if run.Text("commit") == "" {
                if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("base") {
                    throw Exception("Saved checkout HEAD changed")
                }
                Commands.Git(checkout, "add", "-A")
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
            let receipt = J.Map(
                "version",
                1,
                "repo",
                run.Text("repo"),
                "issue",
                run.Number("issue"),
                "donor",
                run.Text("donor"),
                "approval",
                run.Text("approval"),
                "head",
                run.Text("commit"),
                "model",
                run.Text("model"),
                "effort",
                run.Text("effort"),
                "seconds",
                run.Number("seconds"),
                "network",
                run.Flag("network"),
                "policy",
                run.Text("policy_hash")
            )
            let values = Dictionary[string, string]()
            values["issue"] = run.Number("issue").ToString()
            values["report"] = VerificationReport(run, record)
            values["donor"] = run.Text("donor")
            values["model"] = run.Text("model")
            values["effort"] = run.Text("effort")
            values["seconds"] = run.Number("elapsed_seconds").ToString()
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
                "HEAD:refs/heads/" + run.Text("branch")
            )
            Workflow.Recheck(run)
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

        internal func Verify(repo string, number int32) Data {
            let pull = GitHub.Api("repos/" + repo + "/pulls/" + number.ToString())
            let body = J.Text(pull, "body")
            let prefix = "<!-- tokate-receipt:"
            let start = body.IndexOf(prefix, StringComparison.Ordinal)
            if start < 0 || body.IndexOf(prefix, start + prefix.Length, StringComparison.Ordinal) >= 0 {
                throw Exception("PR needs exactly one Tokate receipt")
            }
            let end = body.IndexOf(" -->", start, StringComparison.Ordinal)
            if end < 0 {
                throw Exception("Malformed Tokate receipt")
            }
            let receipt = J.Parse(body.Substring(start + prefix.Length, end - start - prefix.Length))
            if J.Number(receipt, "version") != 1 || J.Text(receipt, "repo") != repo || J.Text(
                J.Get(pull, "user"),
                "login"
            ) != J.Text(receipt, "donor") {
                throw Exception("PR author or repository does not match the receipt")
            }
            let head = J.Get(pull, "head")
            if J.Text(head, "sha") != J.Text(receipt, "head") {
                throw Exception("PR head changed since the receipt was written")
            }
            let record = Workflow.Approved(repo, J.Number(receipt, "issue"), Data.Login(J.Text(receipt, "donor")))
            let approval = J.Get(record, "approval")
            if J.Text(record, "sha") != J.Text(receipt, "approval") || J.Text(approval, "policy_hash") != J.Text(
                receipt,
                "policy"
            ) ||
                J.Text(J.Get(pull, "base"), "ref") != J.Text(approval, "base_branch") {
                throw Exception("PR approval or policy no longer matches")
            }
            let expectedBranch = "tokate/issue-" + J.Number(receipt, "issue").ToString() + "-" + J.Text(record, "sha")
                .Substring(0, 12)
            if J.Text(head, "ref") != expectedBranch || !String.Equals(
                J.Text(J.Get(J.Get(head, "repo"), "owner"), "login"),
                J.Text(receipt, "donor"),
                StringComparison.OrdinalIgnoreCase
            ) {
                throw Exception("PR does not use the assigned donor's claim")
            }
            Policy(J.Write(J.Get(record, "policy"))).Validate(
                J.Text(receipt, "model"),
                J.Text(receipt, "effort"),
                J.Number(receipt, "seconds"),
                J.Bool(receipt, "network")
            )
            let run = Data()
            run.Fields["repo"] = repo
            run.Fields["pr"] = number
            run.Fields["pr_url"] = J.Text(pull, "html_url")
            run.Fields["commit"] = J.Text(head, "sha")
            return run
        }

        internal func Checks(args Args) int32 {
            args.Allow("run,repo,pr,watch,timeout")
            let directory = args.Get("run") == "" ? "": Path.GetFullPath(args.Need("run"))
            let run = directory == "" ? Verify(Data.Repo(args.Need("repo")), args.Number("pr")): Data.Load(directory)
            if run.Number("pr") == 0 {
                throw Exception("No PR has been published for this run")
            }
            let deadline = DateTime.UtcNow.AddSeconds(args.Number("timeout", "1200"))
            while true {
                let verified = Verify(run.Text("repo"), run.Number("pr"))
                if verified.Text("commit") != run.Text("commit") {
                    throw Exception("Saved commit differs from PR receipt")
                }
                let info = GitHub.Api("repos/" + Data.Repo(run.Text("repo")))
                let policy = Policy.Load(run.Text("repo"), J.Text(info, "default_branch"))
                let pullPath = "repos/" + run.Text("repo") + "/pulls/" + run.Number("pr").ToString()
                let pull = GitHub.Api(pullPath)
                if J.Text(J.Get(pull, "head"), "sha") != run.Text("commit") {
                    throw Exception("PR head changed. Saved run no longer describes this PR")
                }
                let result = Commands.Run(
                    "gh",
                    []string{
                        "pr",
                        "checks",
                        run.Number("pr").ToString(),
                        "--repo",
                        run.Text("repo"),
                        "--json",
                        "name,state,bucket,link,workflow"
                    },
                    github: true
                )
                var rows = J.Parse("[]")
                if result.Output.Trim().StartsWith("[") {
                    rows = J.Parse(result.Output)
                } else if !result.Error.Contains("no checks reported") {
                    throw Exception("Cannot read PR checks: " + result.Error)
                }
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
                let status = failed ? "failed": (pending ? "pending": "passed")
                if directory != "" {
                    File.WriteAllText(
                        Path.Combine(directory, "checks.json"),
                        J.Write(J.Map("head", run.Text("commit"), "status", status, "checks", rows))
                    )
                }
                Terminal.Message(
                    "Checks " + status + ": " + run.Text("pr_url"),
                    failed ? "red": (pending ? "yellow": "green")
                )
                if failed {
                    return 1
                }
                if !pending {
                    return 0
                }
                if args.Get("watch") != "true" || DateTime.UtcNow >= deadline {
                    return 8
                }
                select {
                    case <- after(TimeSpan.FromSeconds(2.0)) { }
                }
            }
        }
    }
}
