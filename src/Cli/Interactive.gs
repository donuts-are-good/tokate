package Tokate

import System
import System.IO
import System.Text.Json

internal class Interactive {
    shared {
        internal func Available() bool -> !PublicOutput.Enabled &&
            !Console.IsInputRedirected &&
            !Console.IsOutputRedirected &&
            !Console.IsErrorRedirected

        private func Options(command string, repo string, issue string = "") Args {
            let args = issue == "" ? Args([]string{command, "--repo", repo}): Args(
                []string{command, "--repo", repo, "--issue", issue}
            )
            Cli.Validate(args)
            return args
        }

        internal func Repository() string {
            var inferred = ""
            try {
                inferred = RepositoryInput.Local()
            } catch (error Exception) {
                Terminal.Message(error.Message, "yellow")
            }
            while true {
                Terminal.Message(
                    inferred == "" ? "Repository OWNER/REPO or URL (blank cancels):":
                    "Repository [" + inferred + "] (Enter keeps it, another repo corrects it, exit cancels):",
                    "default"
                )
                Console.Write("repo> ")
                let answer = Console.ReadLine()?.Trim()
                if answer == nil || String.Equals(answer, "exit", StringComparison.OrdinalIgnoreCase) {
                    return ""
                }
                if answer == "" {
                    return inferred
                }
                try {
                    return RepositoryInput.Repo(answer)
                } catch (error Exception) {
                    Terminal.Message(error.Message, "red")
                }
            }
        }

        private func Selection(repo string) Args? {
            Terminal.Message("Issue number, issue URL, or repository (all clears, blank cancels):", "default")
            Console.Write("issue> ")
            let answer = Console.ReadLine()?.Trim()
            if answer == nil || answer == "" {
                return nil
            }
            var options Args
            if String.Equals(answer, "all", StringComparison.OrdinalIgnoreCase) {
                options = Options("status", repo)
            } else if answer.Contains("/") && !answer.Contains("/issues/") {
                options = Options("status", answer)
            } else if answer.StartsWith("https://", StringComparison.OrdinalIgnoreCase) {
                options = Args([]string{"status", "--issue", answer})
                Cli.Validate(options)
            } else {
                options = Options("status", repo, answer)
            }
            return options
        }

        private func Read(repo string, issue string) JsonElement {
            try {
                let options = Options("status", repo, issue)
                Startup.Check(options)
                let snapshot = ContributionStatus.Snapshot(options)
                if let failure = snapshot.Failure {
                    Error(failure)
                }
                return J.Parse(J.Write(snapshot.Result))
            } catch (error Exception) {
                Error(error)
                return JsonElement{}
            }
        }

        private func Status(repo string, issue string, snapshot JsonElement) {
            Terminal.Row("Selection", repo + (issue == "" ? " / approved work": " #" + issue))
            if snapshot.ValueKind == JsonValueKind.Object {
                Terminal.ContributionStatus(snapshot)
            } else {
                Terminal.Message("Status unavailable. Correct the selection or choose refresh.", "yellow")
            }
        }

        private func PolicyRead(repo string) {
            let options = Options("policy", repo)
            Startup.Check(options)
            let info = GitHub.Api("repos/" + repo)
            Terminal.Json(Policy.Load(repo, J.Text(info, "default_branch")).Value, "Repository policy")
        }

        private func Error(error Exception) -> Terminal.Message(
            "tokate: " + (error is CliFailure failure ? failure.Summary: error.Message),
            "red"
        )

        private func Saved() {
            PublicOutput.Reset("status")
            try {
                let saved = RunStorage.Discover()
                let rows = J.Items(J.Get(saved, "runs"))
                Terminal.Heading("Saved contributions")
                var index int32 = 1
                for row in rows {
                    Terminal.Message(
                        index.ToString() + ") " + J.Text(row, "repo") + " #" + J.Number(row, "issue").ToString() +
                            " / " +
                            J.Text(row, "donor") + " / " + J.Text(row, "model") + " / " + J.Text(row, "state") +
                            " / " +
                            Path.GetFileName(J.Text(row, "run")) +
                            (J.Text(row, "storage") == "previous" ? " (previous storage)": ""),
                        "default"
                    )
                    index++
                }
                if J.Number(saved, "skipped") > 0 {
                    Terminal.Message(
                        "Skipped unreadable or invalid entries: " + J.Number(saved, "skipped").ToString(),
                        "yellow"
                    )
                }
                if J.Bool(saved, "truncated") {
                    Terminal.Message(
                        "Only the first 128 entries were inspected. Use status --run for another saved directory.",
                        "yellow"
                    )
                }
                if rows.Count == 0 {
                    Terminal.Message("No readable saved contributions.", "default")
                    return
                }
                while true {
                    Console.Write("Saved contribution number (blank cancels)> ")
                    let answer = Console.ReadLine()?.Trim()
                    if answer == nil || answer == "" || answer == "exit" {
                        return
                    }
                    var selected int32
                    if !int32.TryParse(answer, out selected) || selected < 1 || selected > rows.Count {
                        Terminal.Message("Choose one of the listed numbers.", "yellow")
                        continue
                    }
                    let directory = J.Text(rows[selected - 1], "run")
                    let options = Args([]string{"status", "--run", directory})
                    Cli.Validate(options)
                    PublicOutput.RunDirectory = directory
                    let summary = PublicOutput.RunSummary(directory)
                    PublicOutput.Next(options, "")
                    Terminal.SavedRun(J.Parse(J.Write(summary)))
                    return
                }
            } finally {
                PublicOutput.Reset()
            }
        }

        private func Start(command string) {
            PublicOutput.Reset(command)
            try {
                let options = Args([]string{command})
                if command == "init" {
                    let repo = Repository()
                    if repo == "" {
                        return
                    }
                    options.Values["--repo"] = repo
                }
                Cli.Validate(options, guided: true)
                GuidedWork.Fill(options)
                Cli.Validate(options)
                let code = Dispatch(options)
                PublicOutput.Next(options, "")
                Terminal.RunOutcome(code, "")
            } finally {
                PublicOutput.Reset()
            }
        }

        internal func Run() int32 {
            if !OperatingSystem.IsLinux() {
                throw Exception("This release supports Linux")
            }
            Terminal.InteractiveHeading()
            var repo = ""
            while repo == "" {
                Terminal.Message("donate / owner / repository / saved / help / exit", "default")
                Console.Write("action> ")
                let answer = Console.ReadLine()?.Trim()
                if answer == nil || answer == "" || answer == "exit" {
                    return 0
                }
                try {
                    if answer == "donate" || answer == "owner" {
                        Start(answer == "donate" ? "work": "init")
                    } else if answer == "saved" {
                        Saved()
                    } else if answer == "help" {
                        Terminal.Message(
                            "donate starts guided work. owner opens repository setup. repository shows current work. saved inspects local contributions offline. You can also enter OWNER/REPO directly.",
                            "default"
                        )
                    } else {
                        repo = answer == "repository" ? Repository(): RepositoryInput.Repo(answer)
                    }
                } catch (error Exception) {
                    Error(error)
                }
            }
            if repo == "" {
                return 0
            }
            var issue = ""
            var snapshot = Read(repo, issue)
            Status(repo, issue, snapshot)
            while true {
                Terminal.Message("status / issue / refresh / policy / help / exit", "default")
                Console.Write("tokate> ")
                let answer = Console.ReadLine()?.Trim().ToLowerInvariant()
                if answer == nil || answer == "exit" {
                    return 0
                }
                try {
                    switch answer {
                        case "status" {
                            Status(repo, issue, snapshot)
                        }
                        case "refresh" {
                            snapshot = Read(repo, issue)
                            Status(repo, issue, snapshot)
                        }
                        case "issue" {
                            if let selection = Selection(repo) {
                                repo = selection.Need("repo")
                                issue = selection.Get("issue")
                                snapshot = Read(repo, issue)
                                Status(repo, issue, snapshot)
                            }
                        }
                        case "policy" {
                            PolicyRead(repo)
                        }
                        case "help" {
                            Terminal.Message(
                                "status shows this snapshot. refresh reads current contribution state. issue selects a number, issue URL, or repository. A repository change clears the issue. policy reads owner policy. exit closes this view. Use tokate help for command help.",
                                "default"
                            )
                        }
                        default {
                            if answer != "" {
                                Terminal.Message("Choose status, issue, refresh, policy, help, or exit.", "yellow")
                            }
                        }
                    }
                } catch (error Exception) {
                    Error(error)
                }
            }
        }
    }
}
