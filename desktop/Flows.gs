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
    private var runDirectory string = ""
    private var run JsonElement
    private var runActions List[string] = List[string]()
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
        if page == "Donate" || page == "My project" || page == "Saved work" {
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
                            if requested == "" {
                                FindIssues(selectedRepository, donorIssues, search: true)
                                return
                            }
                            Execute(
                                []string{"api", "repos/" + selectedRepository + "/issues/" + requested},
                                found -> {
                                    if Error(found) {
                                        return
                                    }
                                    let item = found.Value
                                    if Field(item, "pull_request").ValueKind != JsonValueKind.Undefined {
                                        message = "This is a pull request. Choose an issue."
                                    } else if TextOf(item, "state") != "open" {
                                        message = "Issue #" + requested + " is closed."
                                    } else if !ApprovedIssue(item) {
                                        message = "Issue #" + requested + " needs owner approval."
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
}
