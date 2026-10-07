package Tokate

import System
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

        private func Repository() string {
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

        internal func Run() int32 {
            if !OperatingSystem.IsLinux() {
                throw Exception("This release supports Linux")
            }
            Terminal.InteractiveHeading()
            var repo = Repository()
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
