package TokateDesktop

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

partial class SavedWorkScreen {
    private var runDirectory string = ""
    private var run JsonElement
    private var runActions List[string] = List[string]()
    private var verification string = "30"
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

    private let app DesktopSession
    private let ui ThemedControls
    private let startDonation Action[JsonElement, string]

    init(session DesktopSession, controls ThemedControls, start Action[JsonElement, string]) {
        app = session
        ui = controls
        startDonation = start
    }

    prop IsBrowsing bool -> savedLoaded && !savedSelected && !savedImport

    func Remember(stringPath string) {
        StopSavedUpdates()
        runDirectory = stringPath
    }

    func Open(directory string) {
        runDirectory = directory
        app.Navigate("Saved work")
        LoadRun()
    }

    func Enter() {
        if !savedLoaded && runDirectory == "" && !app.Busy {
            Discover()
        } else if savedLoaded && !savedSelected && !app.Busy {
            LoadSavedPage(savedPage)
        }
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
            app.Message = error.Message
        }
    }

    func StopSavedUpdates() {
        savedRevision++
        savedReader?.Stop()
        savedReader = nil
        savedReading = false
    }

    private func LoadSavedPage(page int32) {
        StopSavedUpdates()
        savedPage = Math.Clamp(page, 1, Math.Max(1, (savedPaths.Count + IssuePage.Size - 1) / IssuePage.Size))
        savedSelected = false
        savedWork.Clear()
        let start = (savedPage - 1) * IssuePage.Size
        for index in start ... Math.Min(savedPaths.Count, start + IssuePage.Size) {
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
            app.Refresh()
            return
        }
        let reader = SavedPageLoader()
        savedReader = reader
        savedReading = true
        let revision = savedRevision
        go ReadSavedPage(
            reader,
            pending.ToArray(),
            item -> app.Post(
                () -> {
                    if revision != savedRevision {
                        return
                    }
                    savedCache[item.Path] = item
                    for index in 0 ... savedWork.Count {
                        if savedWork[index].Path == item.Path {
                            savedWork[index] = item
                        }
                    }
                    app.Refresh()
                }
            ),
            () -> app.Post(
                () -> {
                    if revision == savedRevision {
                        savedReader = nil
                        savedReading = false
                        app.Refresh()
                    }
                }
            )
        )
        app.Refresh()
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
        app.Execute(
            []string{"status", "--run", runDirectory},
            result -> {
                if app.Error(result) {
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
            startDonation(run, runDirectory)
            return
        }
        let args = List[string]{command, "--run", runDirectory}
        var seconds = 600
        if command == "recover" || command == "amend" {
            if !int32.TryParse(verification, out var minutes) || minutes < 1 || minutes > 1440 {
                app.Message = "Enter 1 to 1440 verification minutes."
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
                app.Message = "Enter the complete 40-character commit."
                return
            }
            args.Add("--commit")
            args.Add(amendmentCommit)
            for pair in[]string{amendmentSummary, amendmentTools} {
                if pair != "" && !File.Exists(pair) {
                    app.Message = "Selected amendment file does not exist."
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
        app.Confirm(
            title,
            TextOf(run, "repo") + " #" + TextOf(run, "issue") + "\n\n" + detail,
            () -> {
                app.Execute(
                    args.ToArray(),
                    result -> {
                        if !app.Error(result) {
                            LoadRun()
                        }
                    },
                    seconds: timeout
                )
            }
        )
    }
}
