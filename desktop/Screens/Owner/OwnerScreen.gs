package TokateDesktop

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.Json.Nodes

partial class OwnerScreen {
    private var projectPath string = ""
    private var ownerRepository string = ""
    private var checks string = ""
    private var verifyCommand string = ""
    private var ownerModels string = ""
    private var ownerTools string = ""
    private var ownerEligibility string = ""
    private var ownerArguments[]string = []string{}
    private var ownerPreview string = ""

    private var ownerOpen bool
    private var ownerTab string = "Contributions"
    private var ownerStep int32
    private var ownerPolicy JsonElement
    private let ownerWork Dictionary[string, JsonElement] = Dictionary[string, JsonElement]()
    private var ownerAccess JsonElement
    private var ownerIssues IssuePage = IssuePage()
    private var ownerSelected JsonElement
    private var ownerCanWrite bool
    private var ownerBranch string = ""
    private var ownerDonor string = ""
    private var ownerIssue string = ""
    private var ownerModelPolicy string = ""
    private var ownerModel string = ""
    private var ownerEffort string = ""
    private var ownerMinutes string = ""
    private var ownerNetwork string = ""
    private var ownerChecksChanged bool
    private var ownerCommandsChanged bool
    private let ownerChecks List[string] = List[string]()
    private let ownerCommands List[[]string] = List[[]string]()
    private let ownerModelMap Dictionary[string, List[string]] = Dictionary[string, List[string]]()

    private let app DesktopSession
    private let ui ThemedControls
    private let issues IssueBrowser

    init(session DesktopSession, controls ThemedControls) {
        app = session
        ui = controls
        issues = IssueBrowser(app)
    }

    prop Key string -> "My project" + ownerTab + ownerStep.ToString()
    prop IsBrowsing bool -> ownerOpen && ownerTab == "Contributions" && ownerSelected.ValueKind != JsonValueKind.Object

    private func OwnerStrings(values IEnumerable[string]) JsonArray {
        let result = JsonArray()
        for value in values {
            result.Add(JsonValue.Create(value) as JsonNode)
        }
        return result
    }

    private func OwnerModelsJson() string {
        let result = JsonObject()
        for item in ownerModelMap {
            result[item.Key] = OwnerStrings(item.Value)
        }
        return result.ToJsonString()
    }

    private func OwnerCommandsJson() string {
        let result = JsonArray()
        for command in ownerCommands {
            result.Add(OwnerStrings(command) as JsonNode)
        }
        return result.ToJsonString()
    }

    private func
    OwnerChanged() {
        ownerArguments = []string{}
        ownerPreview = ""
    }

    private func ReadOwnerPolicy(value JsonElement) {
        ownerPolicy = value
        ownerTools = ""
        ownerEligibility = ""
        ownerModelPolicy = value.ValueKind == JsonValueKind.Object ? "": "unrestricted"
        ownerModels = ""
        ownerMinutes = ""
        ownerNetwork = ""
        ownerChecksChanged = false
        ownerCommandsChanged = false
        ownerChecks.Clear()
        ownerCommands.Clear()
        ownerModelMap.Clear()
        for check in Items(Field(value, "required_checks")) {
            ownerChecks.Add(check.GetString() ?? "")
        }
        for command in Items(Field(value, "verification")) {
            let args = List[string]()
            for arg in Items(command) {
                args.Add(arg.GetString() ?? "")
            }
            ownerCommands.Add(args.ToArray())
        }
        let models = Field(value, "models")
        if models.ValueKind == JsonValueKind.Object {
            for model in models.EnumerateObject() {
                let efforts = List[string]()
                for effort in Items(model.Value) {
                    efforts.Add(effort.GetString() ?? "")
                }
                ownerModelMap[model.Name] = efforts
            }
        }
        OwnerChanged()
    }

    private func LoadOwner() {
        try {
            ownerRepository = Repository(ownerRepository)
            OwnerChanged()
            app.Execute(
                []string{"api", "repos/" + ownerRepository},
                repo -> {
                    if app.Error(repo) {
                        return
                    }
                    ownerIssues = IssuePage()
                    ownerSelected = JsonElement{}
                    ownerOpen = true
                    app.ActionName = "Refresh project"
                    ownerCanWrite = Field(Field(repo.Value, "permissions"), "push").ValueKind == JsonValueKind.True
                    ownerBranch = TextOf(repo.Value, "default_branch")
                    app.Execute(
                        []string{"policy", "--repo", ownerRepository},
                        policy -> {
                            ReadOwnerPolicy(Field(Field(policy.Value, "data"), "policy"))
                            if TextOf(ownerPolicy, "target_branch") != "" {
                                ownerBranch = TextOf(ownerPolicy, "target_branch")
                            }
                            if policy.ExitCode != 0 {
                                ownerTab = "Setup"
                                app.Message = "Project policy could not be loaded. Check access before applying setup."
                                return
                            }
                            RefreshOwner()
                        }
                    )
                },
                "gh"
            )
        } catch (error Exception) {
            app.Message = error.Message
        }
    }

    private func RefreshOwner() {
        ownerWork.Clear()
        SearchOwnerIssues(1, true)
    }

    private func SearchOwnerIssues(page int32 = 1, search bool = false) {
        ownerSelected = JsonElement{}
        issues.FindIssues(ownerRepository, ownerIssues, page, search)
    }

    private func InspectOwnerIssue(number string) {
        app.Execute(
            []string{"status", "--repo", ownerRepository, "--issue", number},
            result -> {
                for item in Items(Field(Field(result.Value, "data"), "work")) {
                    ownerWork[TextOf(item, "issue")] = item
                }
                app.Error(result)
            }
        )
    }

    private func LoadAccess() {
        app.Execute(
            []string{"access", "--repo", ownerRepository, "--operation", "list"},
            result -> {
                if !app.Error(result) {
                    ownerAccess = Field(result.Value, "data")
                }
            }
        )
    }

    private func OwnerAction(title string, args[]string, detail string, access bool = false) {
        app.Confirm(
            title,
            ownerRepository + "\n\n" + detail,
            () -> {
                app.Execute(
                    args,
                    result -> {
                        if !app.Error(result) {
                            if access {
                                LoadAccess()
                            } else {
                                RefreshOwner()
                            }
                        }
                    }
                )
            }
        )
    }

    private func CheckOwnerPr(pr string, command string) {
        app.Execute(
            []string{command, "--repo", ownerRepository, "--pr", pr},
            result -> {
                if app.Error(result) {
                    return
                }
                let data = Field(result.Value, "data")
                app.Message = command == "verify-pr" ? "PR #" +
                    pr +
                    " receipt verified. Review the diff before accepting.": "PR #" +
                    pr +
                    ": " +
                    TextOf(data, "checks_status").Replace('_', ' ')
            }
        )
    }

    private func AccessAction(operation string, donor string, issue string = "") {
        let args = List[string]{"access", "--repo", ownerRepository, "--operation", operation}
        if donor != "" {
            args.Add("--donor")
            args.Add(donor)
        }
        if issue != "" {
            args.Add("--issue")
            args.Add(issue)
        }
        OwnerAction(
            operation == "init" ? "Initialize donor access": operation + " " + donor,
            args.ToArray(),
            operation == "trust" ? "Permit this donor to claim issues with trusted eligibility.": operation == "grant" ? "Permit this donor to claim issue #" +
                issue +
                ".": "Change this project's donor access.",
            true
        )
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
            if ownerCommandsChanged {
                args.Add("--verification")
                args.Add(OwnerCommandsJson())
            }
            if ownerChecksChanged {
                args.Add("--required-checks")
                args.Add(OwnerStrings(ownerChecks).ToJsonString())
            }
            if ownerModelPolicy != "" {
                args.Add("--model-policy")
                args.Add(ownerModelPolicy)
                if ownerModelPolicy == "whitelist" {
                    ownerModels = OwnerModelsJson()
                }
            }
            if ownerMinutes != "" {
                if !int32.TryParse(ownerMinutes, out var minutes) || minutes < 1 || minutes > 1440 {
                    throw Exception("Enter 1 to 1440 minutes per donation.")
                }
                args.Add("--seconds")
                args.Add((minutes * 60).ToString())
            }
            if ownerNetwork != "" {
                args.Add("--network")
                args.Add(ownerNetwork)
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
            app.Execute(
                proposed,
                result -> {
                    if app.Error(result) {
                        return
                    }
                    ownerArguments = proposed
                    ownerPreview = result.Diagnostics
                    app.Message = "Review the proposed files before applying."
                },
                directory: projectPath
            )
        } catch (error Exception) {
            app.Message = error.Message
        }
    }

    private func ApplyOwner() {
        let preview = ownerArguments
        let reviewed = ownerPreview
        let args = List[string](ownerArguments)
        args.Add("--yes")
        app.Confirm(
            "Apply project setup?",
            "Write the policy and workflow shown in the preview.\n\nReview and commit these files before approving work. Existing checks are preserved unless you explicitly replaced them.",
            () -> {
                app.Execute(
                    preview,
                    checked -> {
                        if app.Error(checked) {
                            return
                        }
                        if checked.Diagnostics != reviewed {
                            ownerArguments = []string{}
                            app.Report = checked.Diagnostics
                            app.Message = "Project setup changed. Preview and review it again before applying."
                            return
                        }
                        app.Execute(
                            args.ToArray(),
                            result -> {
                                ownerArguments = []string{}
                                if result.ExitCode == 0 {
                                    ownerPreview = ""
                                    app.Message = "Setup saved. Review and commit the files before approving issues."
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
}
