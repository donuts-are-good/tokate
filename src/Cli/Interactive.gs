package Tokate

import System
import System.Collections.Generic
import System.IO

internal class Interactive {
    shared {
        internal func Available() bool -> !PublicOutput.Enabled &&
            !Console.IsInputRedirected &&
            !Console.IsOutputRedirected &&
            !Console.IsErrorRedirected

        private func Execute(options Args) int32 {
            PublicOutput.Reset(options.Command)
            Cli.Validate(options)
            if options.Get("run") != "" {
                PublicOutput.RunDirectory = options.Need("run")
            }
            var result int32
            try {
                result = Dispatch(options)
            } finally {
                DonationView.Close()
                WizardScreen.Close()
            }
            PublicOutput.Next(options, result == 0 ? "": "command_failed")
            Terminal.RunOutcome(result, "")
            return result
        }

        private func Continue(directory string) {
            while true {
                PublicOutput.Reset("status")
                PublicOutput.RunDirectory = directory
                let summary = J.Parse(J.Write(PublicOutput.RunSummary(directory)))
                let options = Args([]string{"status", "--run", directory})
                PublicOutput.Next(options, "")
                let commands = List[string]()
                let labels = List[string]()
                if J.Text(summary, "state") == "claim_pending" {
                    commands.Add("prepare")
                    labels.Add("Check reservation and prepare work")
                }
                for action in PublicOutput.Actions {
                    let command = action[1]
                    let label = switch command {
                        case "work": "Start reserved donation"
                        case "prepare": "Continue preparation"
                        case "submit": J.Bool(
                            summary,
                            "incomplete"
                        ) ? "Submit incomplete work for a draft PR": "Submit verified work for a draft PR"
                        case "checks": "Check PR review and CI"
                        case "recover": "Prepare an explicit correction"
                        default: ""
                    }
                    if label != "" {
                        commands.Add(command)
                        labels.Add(label)
                    }
                }
                commands.Add("status")
                labels.Add("Inspect saved status and evidence")
                labels.Add("Back to home")
                let next = commands.Count == 1 ?
                "No local work can start from this state. Inspect status for the next required action.":
                "Choose the next action. Nothing starts automatically."
                let selected = WizardScreen.Choose(
                    "Continue contribution",
                    J.Text(summary, "repo") + " #" + J.Number(summary, "issue").ToString() + "\nState  " + J.Text(
                        summary,
                        "state"
                    ) +
                        "\nModel  " +
                        J.Text(summary, "model") + "\n\n" + next,
                    labels.ToArray()
                )
                if selected > commands.Count {
                    return
                }
                let command = commands[selected - 1]
                let args = Args([]string{command, "--run", directory})
                if command == "work" {
                    if WizardScreen.Choose(
                        "Start reserved donation",
                        "Model  " + J.Text(summary, "model") + " / " + J.Text(summary, "effort") +
                            "\nBudget  " +
                            RuntimeBudget.Description(Data.From(summary)) +
                            "\nProject network  " +
                            (J.Bool(summary, "network") ? "allowed": "offline") +
                            "\n\nUses your selected coding tool and allowance. Authority is rechecked before starting.",
                        []string{"Start donation", "Back"}
                    ) != 1 {
                        continue
                    }
                    args.Values["--yes"] = "true"
                }
                if command == "recover" {
                    args.Values["--seconds"] = (
                        int32.Parse(
                            WizardScreen.Read(
                                "Verification time",
                                "Runs owner checks without inference.",
                                "Minutes",
                                "30"
                            )
                        ) * 60
                    ).ToString()
                }
                Execute(args)
                Console.Error.Write("Enter returns to this contribution: ")
                if Console.ReadLine() == nil {
                    throw OperationCanceledException("Cancelled")
                }
            }
        }

        private func Saved() {
            let saved = RunStorage.Discover()
            let rows = J.Items(J.Get(saved, "runs"))
            if rows.Count == 0 {
                WizardScreen.Read(
                    "Saved contributions",
                    "No readable saved contributions were found." +
                        (J.Bool(saved, "truncated") ? "\nShowing the first 128 inspected entries.": ""),
                    "Enter to return"
                )
                return
            }
            let labels = List[string]()
            for row in rows {
                labels.Add(
                    J.Text(row, "repo") + " #" + J.Number(row, "issue").ToString() + " | " + J.Text(row, "model") +
                        " | " +
                        J.Text(row, "state") + " | " + Path.GetFileName(J.Text(row, "run")) +
                        (J.Text(row, "storage") == "previous" ? " (previous storage)": "")
                )
            }
            var note = "Saved work on this computer. No network access is needed to list it."
            if J.Number(saved, "skipped") > 0 {
                note += "\nUnreadable entries skipped: " + J.Number(saved, "skipped").ToString()
            }
            if J.Bool(saved, "truncated") {
                note += "\nShowing the first 128 inspected entries."
            }
            let selected = WizardScreen.Choose("Saved contributions", note, labels.ToArray())
            Continue(J.Text(rows[selected - 1], "run"))
        }

        private func Start(command string) {
            let options = Args([]string{command})
            options.Guided = true
            if command == "init" {
                GuidedWork.Repository(options)
            }
            Cli.Validate(options, guided: true)
            GuidedWork.Fill(options)
            Execute(options)
            let directory = PublicOutput.RunDirectory
            if directory != "" {
                Continue(directory)
            } else {
                WizardScreen.Read(
                    "Project setup",
                    "Review and commit the configuration before approving work. Every contribution still needs owner review.",
                    "Enter to return"
                )
            }
        }

        internal func Run() int32 {
            if !OperatingSystem.IsLinux() {
                throw Exception("This release supports Linux")
            }
            while true {
                try {
                    let action = WizardScreen.Choose(
                        "Welcome",
                        "What would you like to do?",
                        []string{
                            "Donate AI time          Work on an approved issue",
                            "Set up my project       Let people contribute",
                            "Continue existing work  Find a saved contribution"
                        },
                        "Choose the job you want to do. Tokate fills in details it can find."
                    )
                    if action == 3 {
                        Saved()
                    } else {
                        Start(action == 1 ? "work": "init")
                    }
                } catch (error WizardHome) {
                    continue
                } catch (error OperationCanceledException) {
                    return 0
                } catch (error Exception) {
                    Terminal.Message(
                        "tokate: " + (error is CliFailure failure ? failure.Summary: error.Message),
                        "red",
                        true
                    )
                    try {
                        WizardScreen.Read("Action needs attention", error.Message, "Enter to return home")
                    } catch (cancel OperationCanceledException) {
                        return 0
                    } catch (home WizardHome) { }
                } finally {
                    PublicOutput.Reset()
                }
            }
        }
    }
}
