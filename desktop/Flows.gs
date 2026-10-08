package TokateDesktop

import Goo
import Goo.Widgets.Inputs
import System
import System.Collections.Generic
import System.IO
import System.Text.Json

partial class Desktop {
    private var repository string = ""
    private var account string = ""
    private var selectedRepository string = ""
    private var issue string = ""
    private var issueTitle string = ""
    private var issues List[JsonElement] = List[JsonElement]()
    private var policy JsonElement
    private var step int32
    private var harness string = "codex"
    private var model string = "gpt-6.1-sol"
    private var effort string = "high"
    private var codexModels List[JsonElement] = List[JsonElement]()
    private var endpoint string = ""
    private var profile string = ""
    private var profiles JsonElement
    private var coding string = "30"
    private var unlimited bool
    private var verification string = "30"
    private var network bool
    private var selection JsonElement
    private var runDirectory string = ""
    private var run JsonElement
    private var runActions List[string] = List[string]()
    private var savedPaths List[string] = List[string]()
    private var projectPath string = ""
    private var ownerRepository string = ""
    private var checks string = ""
    private var verifyCommand string = ""
    private var ownerModels string = ""
    private var ownerTools string = ""
    private var ownerEligibility string = ""
    private var ownerArguments[]string = []string{}
    private var ownerPreview string = ""

    private func Error(result CommandResult) bool {
        if result.ExitCode == 0 {
            return false
        }
        if page == "Donate" {
            message = TextOf(Field(result.Value, "error"), "message")
            if message == "" {
                message = result.Diagnostics.Trim().Split('\n')[0]
            }
            if message == "" {
                message = "Could not complete this action."
            }
            report = ""
            return true
        }
        ShowResult(result)
        return true
    }

    private func LoadProject() {
        try {
            selectedRepository = Repository(repository)
            unlimited = false
            issues.Clear()
            account = ""
            let parts = repository.Trim().TrimEnd('/').Split('/')
            let requested = parts.Length > 2 && parts[parts.Length - 2] == "issues" ? parts[parts.Length - 1]: ""
            if requested != "" && (!int32.TryParse(requested, out var number) || number <= 0) {
                throw Exception("Enter a valid GitHub issue number.")
            }
            issue = ""
            issueTitle = ""
            selection = JsonElement{}
            Execute(
                []string{"api", "user"},
                user -> {
                    if Error(user) {
                        return
                    }
                    account = TextOf(user.Value, "login")
                    Execute(
                        []string{"policy", "--repo", selectedRepository},
                        response -> {
                            if Error(response) {
                                return
                            }
                            policy = Field(Field(response.Value, "data"), "policy")
                            Execute(
                                []string{
                                    "api",
                                    "repos/" +
                                        selectedRepository +
                                        (
                                        requested == "" ? "/issues?state=open&labels=tokate%3Aapproved&sort=updated&direction=desc&per_page=20": "/issues/" +
                                            requested
                                    )
                                },
                                found -> {
                                    if Error(found) {
                                        return
                                    }
                                    issues.Clear()
                                    let candidates = requested == "" ? Items(found.Value): List[JsonElement]{
                                        found.Value
                                    }
                                    for item in candidates {
                                        var approved = false
                                        for label in Items(Field(item, "labels")) {
                                            approved = approved || TextOf(label, "name") == "tokate:approved"
                                        }
                                        if !approved || TextOf(item, "state") != "open" {
                                            continue
                                        }
                                        if Field(item, "pull_request").ValueKind == JsonValueKind.Undefined {
                                            issues.Add(item)
                                        }
                                    }
                                    message = issues.Count == 0 ? requested == "" ?
                                    "No approved issues found.":
                                    Field(found.Value, "pull_request").ValueKind != JsonValueKind.Undefined ?
                                    "This is a pull request. Choose an issue.":
                                    TextOf(found.Value, "state") != "open" ?
                                    "Issue #" + requested + " is closed.":
                                    "Issue #" + requested + " needs owner approval.": ""
                                    if requested != "" && issues.Count == 1 {
                                        ChooseIssue(issues[0])
                                    }
                                },
                                "gh"
                            )
                        }
                    )
                },
                "gh"
            )
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func ChooseIssue(value JsonElement) {
        issue = TextOf(value, "number")
        issueTitle = TextOf(value, "title")
        step = 1
        Execute(
            []string{"defaults", "list"},
            result -> {
                if Error(result) {
                    return
                }
                profiles = Field(Field(result.Value, "data"), "profiles")
                LoadCodexModels()
            }
        )
    }

    private func LoadCodexModels() {
        Execute(
            []string{"debug", "models", "--bundled"},
            result -> {
                if Error(result) {
                    return
                }
                codexModels.Clear()
                for item in Items(Field(result.Value, "models")) {
                    if TextOf(item, "visibility") != "hide" {
                        codexModels.Add(item)
                    }
                }
            },
            "codex",
            seconds: 15
        )
    }

    private func CodexChoices(reasoning bool)[]ComboBoxOption {
        let result = List[ComboBoxOption]()
        for item in codexModels {
            let id = TextOf(item, "slug")
            if reasoning {
                if id == model {
                    for level in Items(Field(item, "supported_reasoning_levels")) {
                        let value = TextOf(level, "effort")
                        let name = value == "xhigh" ? "Extra high": char.ToUpperInvariant(value[0]).ToString() +
                            value.Substring(1)
                        result.Add(ComboBoxOption{Id: value, Label: name, Content: Label(name)})
                    }
                }
            } else {
                let name = TextOf(item, "display_name")
                result.Add(ComboBoxOption{Id: id, Label: name, Content: Label(name)})
            }
        }
        return result.ToArray()
    }

    private func UseSelection(value JsonElement) {
        harness = TextOf(value, "harness")
        model = TextOf(value, "model")
        effort = TextOf(value, "effort")
        endpoint = TextOf(value, "endpoint")
    }

    private func SelectionArguments(command string) List[string] {
        let result = List[string]()
        for argument in[]string{command, "--repo", selectedRepository} {
            result.Add(argument)
        }
        if profile != "" {
            result.Add("--profile")
            result.Add(profile)
        }
        if profile == "" || command == "claim" {
            for argument in[]string{"--harness", harness, "--model", model.Trim(), "--effort", effort.Trim()} {
                result.Add(argument)
            }
            if harness == "pi" && endpoint.Trim() != "" {
                result.Add("--endpoint")
                result.Add(endpoint.Trim())
            }
        }
        result.Add("--non-interactive")
        return result
    }

    private func AllowsUnlimited() bool -> Number(policy, "version") == 2 && Field(
        policy,
        "allow_unlimited"
    ).ValueKind == JsonValueKind.True

    private func BudgetSeconds() int32 {
        var minutes int32
        var reserve int32
        if !int32.TryParse(verification, out reserve) || reserve < 1 || reserve > 1440 {
            throw Exception("Use whole verification minutes from 1 to 1440.")
        }
        if unlimited && !AllowsUnlimited() {
            throw Exception("The owner does not allow unlimited coding.")
        }
        if !unlimited && (!int32.TryParse(coding, out minutes) || minutes < 1 || minutes > 1440) {
            throw Exception("Use whole coding minutes from 1 to 1440.")
        }
        let total = (unlimited ? reserve: minutes + reserve) * 60
        let maximum = Number(policy, "max_seconds")
        if total > 86400 || (maximum > 0 && total > maximum) {
            throw Exception(
                "The time budget exceeds the limit of " +
                    (maximum > 0 ? Math.Min(maximum, 86400) / 60: 1440).ToString() + " minutes."
            )
        }
        return total
    }

    private func ReviewDonation() {
        try {
            BudgetSeconds()
            Execute(
                SelectionArguments("select").ToArray(),
                result -> {
                    if Error(result) {
                        return
                    }
                    selection = Field(result.Value, "data")
                    harness = TextOf(selection, "harness")
                    model = TextOf(selection, "model")
                    effort = TextOf(selection, "effort")
                    step = 2
                    message = ""
                }
            )
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func Reserve() {
        try {
            let args = SelectionArguments("claim")
            let seconds = BudgetSeconds()
            if unlimited {
                args.Add("--unlimited")
            } else {
                args.Add("--seconds")
                args.Add(seconds.ToString())
            }
            for argument in[]string{
                "--issue",
                issue,
                "--verification-reserve",
                (int32.Parse(verification) * 60).ToString()
            } {
                args.Add(argument)
            }
            if network {
                args.Add("--allow-network")
            }
            Confirm(
                "Reserve this contribution?",
                "",
                () -> {
                    step = 3
                    donationStarted = false
                    donationReady = false
                    donationPath = ""
                    donationState = "Reserving donation"
                    Execute(
                        args.ToArray(),
                        result -> {
                            let directory = TextOf(Field(result.Value, "data"), "run")
                            if directory != "" && (result.ExitCode == 0 || result.ExitCode == 8) {
                                Execute(
                                    []string{"status", "--run", directory},
                                    status -> {
                                        if !Error(status) {
                                            OpenDonation(Field(status.Value, "data"), directory, false)
                                        }
                                    }
                                )
                            } else {
                                donationState = "Reservation needs attention"
                                step = 2
                                ShowResult(result)
                            }
                        },
                        seconds: 600
                    )
                },
                label: "Send request",
                content: () -> Container{
                    Gap: 16,
                    Heading(selectedRepository + " #" + issue, 25),
                    Row(
                        []Blob{
                            SummaryTile("Coding", unlimited ? "Unlimited": coding + " minutes", "schedule"),
                            SummaryTile("Verification", verification + " minutes", "verified"),
                        }
                    ),
                    ReviewDetail("Model", model + " / " + effort),
                    ReviewDetail("Network", network ? "Allowed": "Offline"),
                }
            )
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func Discover() {
        savedPaths.Clear()
        let previous = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local/state")
        let configured = Environment.GetEnvironmentVariable("XDG_STATE_HOME") ?? ""
        let current = Path.IsPathFullyQualified(configured) ? configured: previous
        try {
            for storage in current == previous ? []string{current}: []string{current, previous} {
                let root = Path.Combine(storage, "tokate/runs")
                if !Directory.Exists(root) || DirectoryInfo(root).LinkTarget != nil {
                    continue
                }
                for directory in Directory.EnumerateDirectories(root) {
                    if savedPaths.Count >= 128 {
                        break
                    }
                    if DirectoryInfo(directory).LinkTarget == nil {
                        savedPaths.Add(directory)
                    }
                }
            }
            savedPaths.Sort(StringComparer.Ordinal)
            message = savedPaths.Count == 0 ? "No saved run directories found. You can enter a custom run path.":
            ""
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func LoadRun() {
        if String.IsNullOrWhiteSpace(runDirectory) {
            message = "Choose a saved run directory."
            return
        }
        run = JsonElement{}
        runActions.Clear()
        Execute(
            []string{"status", "--run", runDirectory},
            result -> {
                ShowResult(result)
                if Error(result) {
                    return
                }
                run = Field(result.Value, "data")
                report = ""
                for action in Items(Field(result.Value, "next_actions")) {
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
                        runActions.Add(command)
                    }
                }
                if TextOf(run, "state") == "claim_pending" && !runActions.Contains("prepare") {
                    runActions.Add("prepare")
                }
                message = ""
            }
        )
    }

    private func RunAction(command string) {
        if command == "work" {
            OpenDonation(run, runDirectory)
            StartDonation()
            return
        }
        let args = List[string]()
        for argument in[]string{command, "--run", runDirectory} {
            args.Add(argument)
        }
        var seconds = 600
        var description = "Run " + command + " for this saved contribution."
        if command == "submit" || command == "publish" {
            description = "Push verified work and request a draft pull request on GitHub. The owner still reviews and merges it."
        }
        if command == "recover" {
            var minutes int32
            if !int32.TryParse(verification, out minutes) || minutes < 1 || minutes > 1440 {
                message = "Enter 1 to 1440 verification minutes."
                return
            }
            args.Add("--seconds")
            args.Add((minutes * 60).ToString())
            seconds = minutes * 60 + 120
            description = "Run independent verification for up to " + verification + " minutes. No inference."
        }
        let timeout = seconds
        Confirm(
            "Continue contribution",
            TextOf(run, "repo") + " #" + TextOf(run, "issue") + "\n\n" + description,
            () -> {
                Execute(
                    args.ToArray(),
                    result -> {
                        ShowResult(result)
                        runActions.Clear()
                        message += " Refresh saved status before taking another action."
                    },
                    seconds: timeout
                )
            }
        )
    }

    private func Saved() Blob {
        let body = Container{Gap: 18}
        body.Children.Add(Heading("Good work is worth returning to."))
        body.Children.Add(
            Label("Find your saved contribution, inspect its state, then choose the next step.", 19, true)
        )
        body.Children.Add(
            Row(
                []Blob{
                    Action("Find saved work", () -> Discover()),
                    Action("Refresh status", () -> LoadRun(), disabled: runDirectory == "")
                }
            )
        )
        body.Children.Add(
            Entry(
                "Run directory",
                runDirectory,
                value -> {
                    runDirectory = value
                    run = JsonElement{}
                    runActions.Clear()
                },
                "Path printed by Tokate",
                650
            )
        )
        if run.ValueKind == JsonValueKind.Object {
            body.Children.Add(
                Container{
                    Padding: 24,
                    Gap: 14,
                    BackgroundColor: Surface(),
                    BorderRadius: 6,
                    Heading(TextOf(run, "repo") + " #" + TextOf(run, "issue"), 28),
                    Label("State: " + TextOf(run, "state"), 22),
                    Label("Model: " + TextOf(run, "model") + " / " + TextOf(run, "effort"), 18, true),
                    Label(
                        "Next: " +
                            (
                            runActions.Count == 0 ? "Inspect the state and wait for the responsible person.": "Choose an action below."
                        ),
                        17,
                        true
                    ),
                }
            )
            let actions = List[Blob]()
            for command in runActions {
                let selected = command
                let title = switch command {
                    case "work": "Start donation"
                    case "prepare": "Check reservation & prepare"
                    case "submit": "Submit draft PR"
                    case "publish": "Publish draft PR"
                    case "checks": "Check PR and CI"
                    default: "Run verification again"
                }
                actions.Add(Action(title, () -> RunAction(selected)))
            }
            if runActions.Contains("recover") {
                body.Children.Add(
                    Entry(
                        "Verification minutes",
                        verification,
                        value -> {
                            verification = value
                        },
                        width: 240
                    )
                )
            }
            body.Children.Add(Row(actions.ToArray()))
        }
        if savedPaths.Count > 0 {
            body.Children.Add(Rule())
            body.Children.Add(Label("LOCAL RUN DIRECTORIES", 13, true))
            for directory in savedPaths {
                let selected = directory
                body.Children.Add(
                    Action(
                        Path.GetFileName(directory),
                        () -> {
                            runDirectory = selected
                            LoadRun()
                        }
                    )
                )
            }
        }
        return body
    }

    private func PreviewOwner() {
        try {
            let repo = Repository(ownerRepository)
            if !Path.IsPathFullyQualified(projectPath) || !Directory.Exists(projectPath) {
                throw Exception("Enter an existing absolute checkout path.")
            }
            let args = List[string]()
            for item in[]string{"init", "--repo", repo, "--path", projectPath, "--non-interactive"} {
                args.Add(item)
            }
            if verifyCommand.Trim() != "" {
                args.Add("--verification")
                args.Add("[[\"/bin/sh\",\"-c\"," + JsonSerializer.Serialize(verifyCommand) + "]]")
            }
            if checks.Trim() != "" {
                let names = List[string]()
                for name in checks.Split(',') {
                    if name.Trim() != "" {
                        names.Add(JsonSerializer.Serialize(name.Trim()))
                    }
                }
                args.Add("--required-checks")
                args.Add("[" + String.Join(",", names) + "]")
            }
            if ownerModels.Trim() != "" {
                args.Add("--models")
                args.Add(ownerModels)
            }
            if ownerTools.Trim() != "" {
                args.Add("--allowed-tools")
                args.Add(ownerTools)
            }
            if ownerEligibility.Trim() != "" {
                args.Add("--eligibility")
                args.Add(ownerEligibility)
            }
            ownerArguments = []string{}
            let proposed = args.ToArray()
            Execute(
                proposed,
                result -> {
                    ShowResult(result)
                    if Error(result) {
                        return
                    }
                    ownerArguments = proposed
                    ownerPreview = result.Diagnostics
                    report = result.Diagnostics
                    message = "Preview only. Read the complete proposed files below before applying."
                },
                directory: projectPath
            )
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func ApplyOwner() {
        let preview = ownerArguments
        let reviewed = ownerPreview
        let args = List[string](ownerArguments)
        args.Add("--yes")
        Confirm(
            "Apply project setup?",
            "Write the policy and workflow shown in the preview.\n\nReview and commit these files before approving work. Existing checks are preserved unless you explicitly replaced them.",
            () -> {
                Execute(
                    preview,
                    checked -> {
                        if Error(checked) {
                            return
                        }
                        if checked.Diagnostics != reviewed {
                            ownerArguments = []string{}
                            report = checked.Diagnostics
                            message = "Project setup changed. Preview and review it again before applying."
                            return
                        }
                        Execute(
                            args.ToArray(),
                            result -> {
                                ShowResult(result)
                                ownerArguments = []string{}
                                if result.ExitCode == 0 {
                                    message = "Setup saved. Review and commit the files, initialize access, then approve issues."
                                }
                            },
                            directory: projectPath
                        )
                    },
                    directory: projectPath
                )
            }
        )
    }

    private func Owner() Blob -> Container{
        Gap: 18,
        Heading("Make room for good work."),
        Label("Define the contribution policy. You keep review and merge authority.", 19, true),
        Row(
            []Blob{
                Action(
                    "Check owner prerequisites",
                    () -> Execute([]string{"doctor", "--owner", "--auth"}, result -> ShowResult(result))
                )
            }
        ),
        Entry(
            "GitHub repository",
            ownerRepository,
            value -> {
                ownerRepository = value
                ownerArguments = []string{}
            },
            "owner/repository",
            540
        ),
        Entry(
            "Local checkout",
            projectPath,
            value -> {
                projectPath = value
                ownerArguments = []string{}
            },
            "/path/to/project",
            650
        ),
        Label("Optional changes. Leave fields empty to preserve existing settings.", 17, true),
        Entry(
            "Verification command",
            verifyCommand,
            value -> {
                verifyCommand = value
                ownerArguments = []string{}
            },
            "For example: dotnet test",
            650
        ),
        Entry(
            "Required CI checks",
            checks,
            value -> {
                checks = value
                ownerArguments = []string{}
            },
            "Comma-separated check names",
            650
        ),
        Row(
            []Blob{
                Entry(
                    "Allowed tools",
                    ownerTools,
                    value -> {
                        ownerTools = value
                        ownerArguments = []string{}
                    },
                    "codex,pi",
                    310
                ),
                Entry(
                    "Donor eligibility",
                    ownerEligibility,
                    value -> {
                        ownerEligibility = value
                        ownerArguments = []string{}
                    },
                    "trusted, open or manual",
                    310
                ),
            }
        ),
        Entry(
            "Model whitelist",
            ownerModels,
            value -> {
                ownerModels = value
                ownerArguments = []string{}
            },
            "Optional JSON model-to-effort map",
            650
        ),
        Row(
            []Blob{
                Action("Preview setup", () -> PreviewOwner(), true),
                Action("Apply preview", () -> ApplyOwner(), disabled: ownerArguments.Length == 0)
            }
        ),
        Label(
            "Setup does not grant access or approve tasks. Commit the reviewed configuration before accepting donations.",
            17,
            true
        ),
    }
}
