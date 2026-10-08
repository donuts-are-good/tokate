package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

class SavedContribution {
    var Path string = ""
    var Data JsonElement
    var Actions JsonElement
    var Title string = ""
    var Remote JsonElement
    var RemoteError bool
}

partial class Desktop {
    private let savedWork List[SavedContribution] = List[SavedContribution]()
    private let savedPaths List[string] = List[string]()
    private var savedLoaded bool
    private var savedImport bool
    private var savedSkipped int32
    private var amendment bool
    private var amendmentCommit string = ""
    private var amendmentSummary string = ""
    private var amendmentTools string = ""

    private func OpenLink(url string) {
        if Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.Host == "github.com" {
            Process.Start(ProcessStartInfo{FileName: "xdg-open", UseShellExecute: false, ArgumentList: {url}})
        }
    }

    private func StatusBadge(value string) Blob -> Container{
        Padding: Edges{Left: 12, Right: 12, Top: 7, Bottom: 7},
        BorderRadius: 4,
        BackgroundColor: Paper(),
        Accessibility: Accessibility{Role: AccessibilityRole.Status, Name: value},
        Label(value, 17),
    }

    private func SavedStatus(item SavedContribution) string {
        let remote = item.Remote
        if TextOf(remote, "state") == "MERGED" {
            return "Merged"
        }
        if TextOf(remote, "reviewDecision") == "CHANGES_REQUESTED" {
            return "Needs amendment"
        }
        for check in Items(Field(remote, "statusCheckRollup")) {
            let result = TextOf(check, "conclusion")
            if result == "FAILURE" || result == "TIMED_OUT" || TextOf(check, "state") == "FAILURE" {
                return "CI failed"
            }
        }
        for check in Items(Field(remote, "statusCheckRollup")) {
            if TextOf(check, "status") == "IN_PROGRESS" ||
                TextOf(check, "status") == "QUEUED" ||
                TextOf(check, "state") == "PENDING" {
                return "CI pending"
            }
        }
        if TextOf(remote, "state") == "CLOSED" {
            return "Closed without merge"
        }
        let state = TextOf(item.Data, "state")
        return switch state {
            case "claim_pending": "Awaiting reservation"
            case "claimed": "Claimed, not started"
            case "preparing": "Preparing workspace"
            case "running": "Donation in progress"
            case "failed": TextOf(
                item.Data,
                "failure_reason"
            ) == "verification_failed" ? "Verification failed": "Initial donation failed"
            case "generated": "Ready to submit"
            case "published": "Awaiting review"
            default: state.Replace('_', ' ')
        }
    }

    private func Discover() {
        activityAction = "Refresh contributions"
        savedPaths.Clear()
        savedWork.Clear()
        savedLoaded = true
        savedSkipped = 0
        let previous = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local/state")
        let configured = Environment.GetEnvironmentVariable("XDG_STATE_HOME") ?? ""
        let current = Path.IsPathFullyQualified(configured) ? configured: previous
        try {
            if runDirectory != "" {
                savedPaths.Add(runDirectory)
            }
            for storage in current == previous ? []string{current}: []string{current, previous} {
                let root = Path.Combine(storage, "tokate/runs")
                if !Directory.Exists(root) || DirectoryInfo(root).LinkTarget != nil {
                    continue
                }
                for directory in Directory.EnumerateDirectories(root) {
                    if savedPaths.Count >= 128 {
                        break
                    }
                    if DirectoryInfo(directory).LinkTarget == nil && !savedPaths.Contains(directory) {
                        savedPaths.Add(directory)
                    }
                }
            }
            ReadSaved(0)
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func ReadSaved(index int32) {
        if index >= savedPaths.Count {
            RefreshSaved(0)
            return
        }
        let path = savedPaths[index]
        Execute(
            []string{"status", "--run", path},
            result -> {
                if result.ExitCode == 0 && result.Error == "" {
                    let data = Field(result.Value, "data")
                    if TextOf(data, "repo") != "" && Number(data, "issue") > 0 {
                        savedWork.Add(
                            SavedContribution{Path: path, Data: data, Actions: Field(result.Value, "next_actions")}
                        )
                    } else {
                        savedSkipped++
                    }
                } else {
                    savedSkipped++
                }
                if result.Error.StartsWith("Command cancelled") {
                    return
                }
                ReadSaved(index + 1)
            },
            completeOnError: true
        )
    }

    private func RefreshSaved(index int32) {
        if index >= savedWork.Count {
            message = savedSkipped > 0 ? savedSkipped.ToString() + " unreadable saved contributions.": ""
            return
        }
        let item = savedWork[index]
        let repo = TextOf(item.Data, "repo")
        let issue = TextOf(item.Data, "issue")
        Execute(
            []string{"api", "repos/" + repo + "/issues/" + issue},
            result -> {
                if result.Error.StartsWith("Command cancelled") {
                    return
                }
                if result.ExitCode == 0 && result.Error == "" {
                    item.Title = TextOf(result.Value, "title")
                }
                if Number(item.Data, "pr") == 0 {
                    RefreshSaved(index + 1)
                    return
                }
                Execute(
                    []string{
                        "pr",
                        "view",
                        TextOf(item.Data, "pr"),
                        "--repo",
                        repo,
                        "--json",
                        "state,reviewDecision,statusCheckRollup,url"
                    },
                    pull -> {
                        if pull.Error.StartsWith("Command cancelled") {
                            return
                        }
                        item.RemoteError = pull.ExitCode != 0 || pull.Error != ""
                        if !item.RemoteError {
                            item.Remote = pull.Value
                        }
                        RefreshSaved(index + 1)
                    },
                    "gh",
                    completeOnError: true
                )
            },
            "gh",
            completeOnError: true
        )
    }

    private func SelectRun(data JsonElement, actions JsonElement, path string) {
        run = data
        runDirectory = path
        runActions.Clear()
        amendment = false
        for action in Items(actions) {
            let values = Items(action)
            if values.Count < 2 {
                continue
            }
            let command = values[1].GetString() ?? ""
            if command == "work" ||
                command == "prepare" ||
                command == "submit" ||
                command == "publish" ||
                command == "checks" ||
                command == "recover" {
                if !runActions.Contains(command) {
                    runActions.Add(command)
                }
            }
        }
        if TextOf(data, "state") == "claim_pending" && !runActions.Contains("prepare") {
            runActions.Add("prepare")
        }
    }

    private func LoadRun() {
        if String.IsNullOrWhiteSpace(runDirectory) {
            return
        }
        Execute(
            []string{"status", "--run", runDirectory},
            result -> {
                if Error(result) {
                    return
                }
                let data = Field(result.Value, "data")
                SelectRun(data, Field(result.Value, "next_actions"), runDirectory)
                var found = false
                for item in savedWork {
                    if item.Path == runDirectory {
                        item.Data = data
                        item.Actions = Field(result.Value, "next_actions")
                        found = true
                    }
                }
                if !found {
                    savedWork.Add(
                        SavedContribution{Path: runDirectory, Data: data, Actions: Field(result.Value, "next_actions")}
                    )
                }
                savedLoaded = true
                savedImport = false
                RefreshSaved(0)
            }
        )
    }

    private func RunAction(command string) {
        if command == "work" {
            OpenDonation(run, runDirectory)
            StartDonation()
            return
        }
        let args = List[string]{command, "--run", runDirectory}
        var seconds = 600
        if command == "recover" || command == "amend" {
            if !int32.TryParse(verification, out var minutes) || minutes < 1 || minutes > 1440 {
                message = "Enter 1 to 1440 verification minutes."
                return
            }
            args.Add("--seconds")
            args.Add((minutes * 60).ToString())
            seconds = minutes * 60 + 120
        }
        if command == "amend" {
            if amendmentCommit.Length != 40 ||
                !System
                .Text
                .RegularExpressions
                .Regex
                .IsMatch(amendmentCommit, "^[a-fA-F0-9]{40}$") {
                message = "Enter the complete 40-character commit."
                return
            }
            args.Add("--commit")
            args.Add(amendmentCommit)
            for pair in[]string{amendmentSummary, amendmentTools} {
                if pair != "" && !File.Exists(pair) {
                    message = "Selected amendment file does not exist."
                    return
                }
            }
            if amendmentSummary != "" {
                args.Add("--summary")
                args.Add(amendmentSummary)
            }
            if amendmentTools != "" {
                args.Add("--tools")
                args.Add(amendmentTools)
            }
        }
        let title = command == "amend" ? "Publish amendment": command == "recover" ? "Run verification": command == "reconcile" ? "Update workspace": command == "checks" ? "Check pull request": "Continue contribution"
        let detail = command == "amend" ||
            command == "submit" ||
            command == "publish" ? "Publish verified changes to GitHub. The owner reviews and merges.": command == "reconcile" ? "Merge the current target into this saved workspace.": command == "recover" ? "Run project verification without inference.": "Inspect and continue this contribution."
        let timeout = seconds
        Confirm(
            title,
            TextOf(run, "repo") + " #" + TextOf(run, "issue") + "\n\n" + detail,
            () -> {
                Execute(
                    args.ToArray(),
                    result -> {
                        if !Error(result) {
                            LoadRun()
                        }
                    },
                    seconds: timeout
                )
            }
        )
    }

    private func SavedDetails() Blob {
        let panel = DonatePanel()
        panel.Children.Add(Heading(TextOf(run, "repo") + " #" + TextOf(run, "issue"), 28))
        panel.Children.Add(ReviewDetail("Model", TextOf(run, "model") + " / " + TextOf(run, "effort")))
        let failure = TextOf(Field(run, "error"), "message")
        if failure != "" {
            panel.Children.Add(Label(failure, 18))
        }
        let actions = Row([]Blob{})
        for command in runActions {
            let selected = command
            let title = switch command {
                case "work": "Start donation"
                case "prepare": "Check reservation"
                case "submit": "Submit draft PR"
                case "publish": "Publish draft PR"
                case "checks": "Check PR and CI"
                default: "Run verification again"
            }
            actions.Children.Add(Action(title, () -> RunAction(selected), command == "work" || command == "submit"))
        }
        if Number(run, "pr") > 0 {
            actions.Children.Add(
                Action(
                    "Amend contribution",
                    () -> {
                        amendment = !amendment
                    }
                )
            )
            actions.Children.Add(Action("Update workspace", () -> RunAction("reconcile")))
            actions.Children.Add(
                Action(
                    "Open pull request",
                    () -> OpenLink("https://github.com/" + TextOf(run, "repo") + "/pull/" + TextOf(run, "pr"))
                )
            )
        }
        actions.Children.Add(
            Action(
                "Open issue",
                () -> OpenLink("https://github.com/" + TextOf(run, "repo") + "/issues/" + TextOf(run, "issue"))
            )
        )
        panel.Children.Add(actions)
        if runActions.Contains("recover") || amendment {
            panel.Children.Add(
                Entry(
                    "Verification minutes",
                    verification,
                    value -> {
                        verification = value
                    },
                    width: 220
                )
            )
        }
        if amendment {
            panel.Children.Add(
                Entry(
                    "Candidate commit",
                    amendmentCommit,
                    value -> {
                        amendmentCommit = value
                    },
                    width: 650
                )
            )
            panel.Children.Add(
                Entry(
                    "Public summary file",
                    amendmentSummary,
                    value -> {
                        amendmentSummary = value
                    },
                    "Optional path",
                    650
                )
            )
            panel.Children.Add(
                Entry(
                    "Tool declarations file",
                    amendmentTools,
                    value -> {
                        amendmentTools = value
                    },
                    "Optional path",
                    650
                )
            )
            panel.Children.Add(Action("Verify and publish amendment", () -> RunAction("amend"), true))
        }
        return panel
    }

    private func Saved() Blob {
        let body = Container{Gap: 20}
        body.Children.Add(Heading("Saved work", 38))
        body.Children.Add(
            Row(
                []Blob{
                    Action(savedLoaded ? "Refresh contributions": "Find saved work", () -> Discover(), true),
                    Action(
                        "Open saved run",
                        () -> {
                            savedImport = !savedImport
                        }
                    ),
                }
            )
        )
        if savedImport {
            let opening = DonatePanel()
            opening.Children.Add(
                Row(
                    []Blob{
                        Entry(
                            "Run directory",
                            runDirectory,
                            value -> {
                                runDirectory = value
                            },
                            "Path printed by Tokate",
                            560
                        ),
                        Action("Open run", () -> LoadRun(), true, runDirectory == ""),
                    }
                )
            )
            body.Children.Add(opening)
        }
        var count = 0
        for item in savedWork {
            if SavedStatus(item) == "Merged" {
                continue
            }
            count++
            let current = item
            let card = DonatePanel()
            card.BorderColor = runDirectory == item.Path ? Accent(): Line()
            let identity = TextOf(item.Data, "repo") + " #" + TextOf(item.Data, "issue")
            card.Children.Add(Row([]Blob{Heading(identity, 27), StatusBadge(SavedStatus(item))}))
            if item.Title != "" {
                card.Children.Add(Heading(item.Title, 25))
            }
            if item.RemoteError {
                card.Children.Add(Label("GitHub status unavailable", 17, true))
            }
            card.Children.Add(
                Row(
                    []Blob{
                        Action(
                            runDirectory == item.Path ? "Selected contribution": "View contribution",
                            () -> SelectRun(current.Data, current.Actions, current.Path),
                            disabled: runDirectory == item.Path
                        )
                    }
                )
            )
            body.Children.Add(card)
            if runDirectory == item.Path {
                body.Children.Add(SavedDetails())
            }
        }
        if savedLoaded && count == 0 && !busy {
            let empty = DonatePanel()
            empty.Children.Add(Heading("No unmerged contributions", 28))
            body.Children.Add(empty)
        }
        return body
    }
}
