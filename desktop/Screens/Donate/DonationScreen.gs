package TokateDesktop

import Goo
import Goo.Widgets.Inputs
import System
import System.Collections.Generic
import System.Text.Json

partial class DonationScreen {
    private var repository string = ""
    private var account string = ""
    private var selectedRepository string = ""
    private var issue string = ""
    private var issueTitle string = ""
    private var donorIssues IssuePage = IssuePage{Filter: "approved"}
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
    private var donation JsonElement
    private var donationPath string = ""
    private var donationReady bool
    private var donationStarted bool
    private var donationRunning bool
    private var donationOutput string = ""
    private var donationElapsed int32
    private var donationState string = ""
    private var approvalTimer WindowTimer?
    private var approvalRunner CommandClient?
    private let outputViewport ElementHandle = ElementHandle()
    private var outputRange float64
    private var outputOffset float64
    private var followOutput bool = true
    private var renderedOutput string = ""
    private var renderedTheme float64 = -1
    private var activityLines List[ActivityLine] = List[ActivityLine]()

    private let app DesktopSession
    private let ui ThemedControls
    private let issues IssueBrowser
    private let openSaved Action[string]
    private let rememberRun Action[string]

    init(session DesktopSession, controls ThemedControls, saved Action[string], remember Action[string]) {
        app = session
        ui = controls
        issues = IssueBrowser(app)
        openSaved = saved
        rememberRun = remember
        outputViewport.MetricsChanged += metrics -> {
            let follow = outputRange - outputOffset <= 2
            let changed = metrics.ScrollRange.Y != outputRange
            if metrics.ScrollOffset.Y < Math.Min(outputOffset, metrics.ScrollRange.Y) - 1 {
                followOutput = false
                app.Refresh()
            }
            outputRange = metrics.ScrollRange.Y
            outputOffset = metrics.ScrollOffset.Y
            if changed && follow && followOutput {
                if activityLines.Count > 0 {
                    outputViewport.ScrollToItem(activityLines[activityLines.Count - 1].Index.ToString())
                } else {
                    outputViewport.ScrollTo(0, outputRange)
                }
            }
        }
    }

    prop Key string -> "Donate" + step.ToString()
    prop IsDonating bool -> step == 3
    prop IsLive bool -> IsDonating && donationStarted
    prop IsBrowsing bool -> step == 0 && donorIssues.Loaded

    func Stop() {
        approvalTimer?.Dispose()
        approvalTimer = nil
        approvalRunner?.Stop()
        approvalRunner = nil
    }

    private func LoadProject() {
        try {
            selectedRepository = Repository(repository)
            unlimited = false
            donorIssues = IssuePage{Filter: "approved"}
            account = ""
            let parts = repository.Trim().TrimEnd('/').Split('/')
            let requested = parts.Length > 2 && parts[parts.Length - 2] == "issues" ? parts[parts.Length - 1]: ""
            if requested != "" && (!int32.TryParse(requested, out var number) || number <= 0) {
                throw Exception("Enter a valid GitHub issue number.")
            }
            issue = ""
            issueTitle = ""
            selection = JsonElement{}
            app.Execute(
                []string{"api", "user"},
                user -> {
                    if app.Error(user) {
                        return
                    }
                    account = TextOf(user.Value, "login")
                    app.Execute(
                        []string{"policy", "--repo", selectedRepository},
                        response -> {
                            if app.Error(response) {
                                return
                            }
                            policy = Field(Field(response.Value, "data"), "policy")
                            if requested == "" {
                                issues.FindIssues(selectedRepository, donorIssues, search: true)
                                return
                            }
                            app.Execute(
                                []string{"api", "repos/" + selectedRepository + "/issues/" + requested},
                                found -> {
                                    if app.Error(found) {
                                        return
                                    }
                                    let item = found.Value
                                    if Field(item, "pull_request").ValueKind != JsonValueKind.Undefined {
                                        app.Message = "This is a pull request. Choose an issue."
                                    } else if TextOf(item, "state") != "open" {
                                        app.Message = "Issue #" + requested + " is closed."
                                    } else if !IssuePage.ApprovedIssue(item) {
                                        app.Message = "Issue #" + requested + " needs owner approval."
                                    } else {
                                        ChooseIssue(item)
                                    }
                                    return
                                },
                                "gh"
                            )
                        }
                    )
                },
                "gh"
            )
        } catch (error Exception) {
            app.Message = error.Message
        }
    }

    private func ChooseIssue(value JsonElement) {
        issue = TextOf(value, "number")
        issueTitle = TextOf(value, "title")
        step = 1
        app.Execute(
            []string{"defaults", "list"},
            result -> {
                if app.Error(result) {
                    return
                }
                profiles = Field(Field(result.Value, "data"), "profiles")
                LoadCodexModels()
            }
        )
    }

    private func LoadCodexModels() {
        app.Execute(
            []string{"debug", "models", "--bundled"},
            result -> {
                if app.Error(result) {
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
                        result.Add(ComboBoxOption{Id: value, Label: name, Content: ui.Label(name)})
                    }
                }
            } else {
                let name = TextOf(item, "display_name")
                result.Add(ComboBoxOption{Id: id, Label: name, Content: ui.Label(name)})
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
            app.Execute(
                SelectionArguments("select").ToArray(),
                result -> {
                    if app.Error(result) {
                        return
                    }
                    selection = Field(result.Value, "data")
                    harness = TextOf(selection, "harness")
                    model = TextOf(selection, "model")
                    effort = TextOf(selection, "effort")
                    step = 2
                    app.Message = ""
                }
            )
        } catch (error Exception) {
            app.Message = error.Message
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
            app.Confirm(
                "Reserve this contribution?",
                "",
                () -> {
                    step = 3
                    donationStarted = false
                    donationReady = false
                    donationPath = ""
                    donationState = "Reserving donation"
                    app.Execute(
                        args.ToArray(),
                        result -> {
                            if result.Error != "" {
                                donationState = "Reservation needs attention"
                                return
                            }
                            let directory = TextOf(Field(result.Value, "data"), "run")
                            if directory != "" && (result.ExitCode == 0 || result.ExitCode == 8) {
                                app.Execute(
                                    []string{"status", "--run", directory},
                                    status -> {
                                        if !app.Error(status) {
                                            OpenDonation(Field(status.Value, "data"), directory, false)
                                        }
                                    }
                                )
                            } else {
                                donationState = "Reservation needs attention"
                                step = 2
                                app.ShowResult(result)
                            }
                        },
                        seconds: 600,
                        completeOnError: true
                    )
                },
                label: "Send request",
                content: () -> Container{
                    Gap: 16,
                    ui.Heading(selectedRepository + " #" + issue, 25),
                    ui.Row(
                        []Blob{
                            ui.SummaryTile("Coding", unlimited ? "Unlimited": coding + " minutes", "schedule"),
                            ui.SummaryTile("Verification", verification + " minutes", "verified"),
                        }
                    ),
                    ui.ReviewDetail("Model", model + " / " + effort),
                    ui.ReviewDetail("Network", network ? "Allowed": "Offline"),
                }
            )
        } catch (error Exception) {
            app.Message = error.Message
        }
    }
}
