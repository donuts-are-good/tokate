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
    var Error string = ""
    var Refreshed bool
}

partial class Desktop {
    private let savedWork List[SavedContribution] = List[SavedContribution]()
    private let savedPaths List[string] = List[string]()
    private var savedLoaded bool
    private var savedImport bool
    private let savedCache Dictionary[string, SavedContribution] = Dictionary[string, SavedContribution]()
    private var savedPage int32 = 1
    private var savedSelected bool
    private var savedReading bool
    private var savedRevision int32
    private var savedReader SavedPageLoader?
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
        if item.Error != "" {
            return "Unavailable"
        }
        if item.Data.ValueKind != JsonValueKind.Object {
            return "Loading"
        }
        if item.RemoteError && Number(item.Data, "pr") > 0 && item.Remote.ValueKind != JsonValueKind.Object {
            return "Review unavailable"
        }
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
        StopSavedUpdates()
        savedPaths.Clear()
        savedCache.Clear()
        savedLoaded = true
        let previous = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local/state")
        let configured = Environment.GetEnvironmentVariable("XDG_STATE_HOME") ?? ""
        let current = Path.IsPathFullyQualified(configured) ? configured: previous
        let seen = HashSet[string](StringComparer.Ordinal)
        try {
            if runDirectory != "" {
                savedPaths.Add(runDirectory)
                seen.Add(runDirectory)
            }
            for storage in current == previous ? []string{current}: []string{current, previous} {
                let root = Path.Combine(storage, "tokate/runs")
                if !Directory.Exists(root) || DirectoryInfo(root).LinkTarget != nil {
                    continue
                }
                let paths = List[string](Directory.EnumerateDirectories(root))
                paths.Sort(StringComparer.Ordinal)
                for directory in paths {
                    if DirectoryInfo(directory).LinkTarget == nil && seen.Add(directory) {
                        savedPaths.Add(directory)
                    }
                }
            }
            LoadSavedPage(savedPage)
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func StopSavedUpdates() {
        savedRevision++
        savedReader?.Stop()
        savedReader = nil
        savedReading = false
    }

    private func LoadSavedPage(page int32) {
        StopSavedUpdates()
        savedPage = Math.Clamp(page, 1, Math.Max(1, (savedPaths.Count + PageSize - 1) / PageSize))
        savedSelected = false
        savedWork.Clear()
        let start = (savedPage - 1) * PageSize
        for index in start ... Math.Min(savedPaths.Count, start + PageSize) {
            let path = savedPaths[index]
            savedWork.Add(savedCache.TryGetValue(path, out var cached) ? cached: SavedContribution{Path: path})
        }
        StartSavedUpdates(savedWork.ToArray())
    }

    private func StartSavedUpdates(items[]SavedContribution) {
        let pending = List[SavedContribution]()
        for item in items {
            if !item.Refreshed {
                pending.Add(item)
            }
        }
        if pending.Count == 0 {
            Rebuild()
            return
        }
        let window = host ?? throw InvalidOperationException("The desktop window is not attached.")
        let reader = SavedPageLoader()
        savedReader = reader
        savedReading = true
        let revision = savedRevision
        go ReadSavedPage(
            reader,
            window,
            pending.ToArray(),
            item -> {
                if revision != savedRevision {
                    return
                }
                savedCache[item.Path] = item
                for index in 0 ... savedWork.Count {
                    if savedWork[index].Path == item.Path {
                        savedWork[index] = item
                    }
                }
                Rebuild()
            },
            () -> {
                if revision == savedRevision {
                    savedReader = nil
                    savedReading = false
                    Rebuild()
                }
            }
        )
        Rebuild()
    }

    private func SelectRun(data JsonElement, actions JsonElement, path string) {
        StopSavedUpdates()
        savedSelected = true
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
        StopSavedUpdates()
        Execute(
            []string{"status", "--run", runDirectory},
            result -> {
                if Error(result) {
                    return
                }
                let data = Field(result.Value, "data")
                let item = SavedContribution{
                    Path: runDirectory,
                    Data: data,
                    Actions: Field(result.Value, "next_actions")
                }
                savedCache[runDirectory] = item
                if !savedPaths.Contains(runDirectory) {
                    savedPaths.Add(runDirectory)
                }
                SelectRun(data, item.Actions, runDirectory)
                savedLoaded = true
                savedImport = false
                StartSavedUpdates([]SavedContribution{item})
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

    private func SavedRow(item SavedContribution, index int32) Blob {
        let identity = item
            .Data
            .ValueKind == JsonValueKind.Object ? TextOf(item.Data, "repo") +
            " #" +
            TextOf(item.Data, "issue"): "Saved contribution " +
            (index + 1).ToString()
        let title = Heading(item.Title == "" ? identity: item.Title, 24)
        title.TextMaxLines = 2
        let copy = Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, Gap: 5}
        if item.Title != "" {
            copy.Children.Add(Label(identity, 16, true))
        }
        copy.Children.Add(title)
        return Keyboard(
            Button{
                Key: item.Path,
                MinHeight: 72,
                Padding: 12,
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.Center,
                Gap: 18,
                BorderWidth: Edges{Bottom: 1},
                BorderColor: Line(),
                BackgroundColor: Color.Transparent,
                Hover: Style{BackgroundColor: Paper()},
                Focus: FocusStyle(),
                Focusable: true,
                Disabled: busy || item.Data.ValueKind != JsonValueKind.Object || item.Error != "",
                Accessibility: Accessibility{
                    Role: AccessibilityRole.Button,
                    Name: "Saved " + identity,
                    Description: item.Error
                },
                OnClick: () -> SelectRun(item.Data, item.Actions, item.Path),
                copy,
                StatusBadge(SavedStatus(item)),
            }
        )
    }

    private func Saved() Blob {
        let body = Container{Gap: 20}
        body.Children.Add(Heading("Saved work", 38))
        body.Children.Add(
            Row(
                []Blob{
                    Action(
                        savedReading ? "Stop updating": savedLoaded ? "Refresh contributions": "Find saved work",
                        () -> {
                            if savedReading {
                                StopSavedUpdates()
                            } else {
                                Discover()
                            }
                        },
                        true
                    ),
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
        if savedSelected {
            body.Children.Add(
                Row(
                    []Blob{
                        Action("Back to contributions", () -> LoadSavedPage(savedPage)),
                        Action("Refresh status", () -> LoadRun()),
                    }
                )
            )
            body.Children.Add(SavedDetails())
        } else if savedLoaded {
            let table = TablePanel()
            var visible = 0
            for index in 0 ... savedWork.Count {
                let item = savedWork[index]
                if SavedStatus(item) == "Merged" {
                    continue
                }
                visible++
                table.Children.Add(SavedRow(item, index + (savedPage - 1) * PageSize))
            }
            if visible == 0 && !savedReading {
                table.Children.Add(
                    Label(
                        savedPaths.Count == 0 ? "No saved contributions": "No unmerged contributions on this page",
                        24
                    )
                )
            }
            body.Children.Add(table)
            body.Children.Add(
                PageNavigation(
                    savedPage,
                    savedPaths.Count,
                    savedPaths.Count.ToString() + " saved runs",
                    page -> LoadSavedPage(page)
                )
            )
        }
        return body
    }
}
