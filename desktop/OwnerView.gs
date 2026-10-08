package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.IO
import System.Text.Json

partial class Desktop {
    private var ownerOpen bool
    private var ownerTab string = "Contributions"
    private var ownerStep int32
    private var ownerPolicy JsonElement
    private var ownerStatus JsonElement
    private var ownerAccess JsonElement
    private var ownerIssues List[JsonElement] = List[JsonElement]()
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
            Execute(
                []string{"api", "repos/" + ownerRepository},
                repo -> {
                    if Error(repo) {
                        return
                    }
                    ownerOpen = true
                    ownerCanWrite = Field(Field(repo.Value, "permissions"), "push").ValueKind == JsonValueKind.True
                    ownerBranch = TextOf(repo.Value, "default_branch")
                    Execute(
                        []string{"policy", "--repo", ownerRepository},
                        policy -> {
                            ReadOwnerPolicy(Field(Field(policy.Value, "data"), "policy"))
                            if policy.ExitCode != 0 {
                                ownerTab = "Setup"
                                message = "Project policy could not be loaded. Check access before applying setup."
                                return
                            }
                            RefreshOwner()
                        }
                    )
                },
                "gh"
            )
        } catch (error Exception) {
            message = error.Message
        }
    }

    private func RefreshOwner() {
        Execute(
            []string{"status", "--repo", ownerRepository},
            result -> {
                ownerStatus = Field(result.Value, "data")
                Execute(
                    []string{"api", "repos/" + ownerRepository + "/issues?state=open&sort=updated&per_page=30"},
                    issues -> {
                        if Error(issues) {
                            return
                        }
                        ownerIssues.Clear()
                        for issue in Items(issues.Value) {
                            if Field(issue, "pull_request").ValueKind == JsonValueKind.Undefined {
                                ownerIssues.Add(issue)
                            }
                        }
                    },
                    "gh"
                )
            }
        )
    }

    private func LoadAccess() {
        Execute(
            []string{"access", "--repo", ownerRepository, "--operation", "list"},
            result -> {
                if !Error(result) {
                    ownerAccess = Field(result.Value, "data")
                }
            }
        )
    }

    private func OwnerAction(title string, args[]string, detail string, access bool = false) {
        Confirm(
            title,
            ownerRepository + "\n\n" + detail,
            () -> {
                Execute(
                    args,
                    result -> {
                        if !Error(result) {
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

    private func OwnerIssue(issue JsonElement) Blob {
        let number = TextOf(issue, "number")
        var approved = false
        for label in Items(Field(issue, "labels")) {
            approved = approved || TextOf(label, "name") == "tokate:approved"
        }
        var remote JsonElement
        for item in Items(Field(ownerStatus, "work")) {
            if TextOf(item, "issue") == number {
                remote = item
            }
        }
        let card = DonatePanel()
        card.Children.Add(
            Row(
                []Blob{
                    Heading("#" + number + "  " + TextOf(issue, "title"), 27),
                    StatusBadge(approved ? TextOf(remote, "state").Replace('_', ' '): "Needs approval")
                }
            )
        )
        let actions = Row([]Blob{})
        actions.Children.Add(
            Action(
                "Open issue #" + number,
                () -> OpenLink("https://github.com/" + ownerRepository + "/issues/" + number)
            )
        )
        actions.Children.Add(
            Action(
                approved ? "Revoke approval #" + number: "Approve issue #" + number,
                () -> {
                    let args = List[string]{
                        approved ? "revoke": "approve",
                        "--repo",
                        ownerRepository,
                        "--issue",
                        number
                    }
                    if !approved {
                        args.Add("--base-branch")
                        args.Add(ownerBranch)
                    }
                    OwnerAction(
                        approved ? "Revoke issue approval": "Approve issue",
                        args.ToArray(),
                        approved ? "Stop future work under this approval.": "Authorize this issue under the current project policy."
                    )
                },
                !approved,
                !ownerCanWrite || (!approved && Number(ownerPolicy, "version") < 2)
            )
        )
        for draft in Items(Field(remote, "drafts")) {
            let pr = TextOf(draft, "pr")
            actions.Children.Add(
                Action("Review PR #" + pr, () -> OpenLink("https://github.com/" + ownerRepository + "/pull/" + pr))
            )
            actions.Children.Add(Action("Verify PR #" + pr, () -> CheckOwnerPr(pr, "verify-pr")))
            actions.Children.Add(Action("Check CI #" + pr, () -> CheckOwnerPr(pr, "checks")))
        }
        card.Children.Add(actions)
        return card
    }

    private func CheckOwnerPr(pr string, command string) {
        Execute(
            []string{command, "--repo", ownerRepository, "--pr", pr},
            result -> {
                if Error(result) {
                    return
                }
                let data = Field(result.Value, "data")
                message = command == "verify-pr" ? "PR #" +
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

    private func OwnerAccessView() Blob {
        let body = Container{Gap: 18}
        body.Children.Add(
            Row(
                []Blob{
                    Action("Refresh access", () -> LoadAccess()),
                    Action(
                        "Initialize access",
                        () -> AccessAction("init", ""),
                        disabled: !ownerCanWrite || TextOf(ownerAccess, "access_sha") != ""
                    )
                }
            )
        )
        for request in Items(Field(ownerAccess, "pending")) {
            let donor = TextOf(request, "donor")
            let issue = TextOf(request, "issue")
            let card = DonatePanel()
            card.Children.Add(Row([]Blob{Heading(donor, 28), StatusBadge("Access requested"), Label("#" + issue, 22)}))
            card.Children.Add(
                Row(
                    []Blob{
                        Action(
                            "Grant #" + issue + " to " + donor,
                            () -> AccessAction("grant", donor, issue),
                            true,
                            !ownerCanWrite
                        ),
                        Action("Trust " + donor, () -> AccessAction("trust", donor), disabled: !ownerCanWrite)
                    }
                )
            )
            body.Children.Add(card)
        }
        for member in Items(Field(ownerAccess, "members")) {
            let donor = TextOf(member, "donor")
            let trusted = Field(member, "trusted").ValueKind == JsonValueKind.True
            let denied = Field(member, "denied").ValueKind == JsonValueKind.True
            let card = DonatePanel()
            card.Children.Add(
                Row([]Blob{Heading(donor, 28), StatusBadge(denied ? "Denied": trusted ? "Trusted": "Issue access")})
            )
            card.Children.Add(
                Row(
                    []Blob{
                        Action(
                            trusted ? "Untrust " + donor: "Trust " + donor,
                            () -> AccessAction(trusted ? "untrust": "trust", donor),
                            disabled: !ownerCanWrite
                        ),
                        Action(
                            denied ? "Restore " + donor: "Deny " + donor,
                            () -> AccessAction(denied ? "restore": "deny", donor),
                            disabled: !ownerCanWrite
                        )
                    }
                )
            )
            body.Children.Add(card)
        }
        let add = DonatePanel()
        add.Children.Add(Heading("Grant access", 28))
        add.Children.Add(
            Row(
                []Blob{
                    Entry(
                        "Donor",
                        ownerDonor,
                        value -> {
                            ownerDonor = value
                        },
                        "GitHub username",
                        280
                    ),
                    Entry(
                        "Issue",
                        ownerIssue,
                        value -> {
                            ownerIssue = value
                        },
                        "Issue number",
                        180
                    )
                }
            )
        )
        add.Children.Add(
            Row(
                []Blob{
                    Action(
                        "Grant issue access",
                        () -> AccessAction("grant", ownerDonor, ownerIssue),
                        true,
                        !ownerCanWrite || ownerDonor == "" || !int32.TryParse(ownerIssue, out var number) || number < 1
                    ),
                    Action(
                        "Trust donor",
                        () -> AccessAction("trust", ownerDonor),
                        disabled: !ownerCanWrite || ownerDonor == ""
                    )
                }
            )
        )
        body.Children.Add(add)
        return body
    }

    private func OwnerChecks() Blob {
        let panel = DonatePanel()
        panel.Children.Add(Heading("Verification", 28))
        for index in 0 ... ownerCommands.Count {
            let current = index
            let args = ownerCommands[index]
            panel.Children.Add(
                Row(
                    []Blob{
                        Label(String.Join(" ", args), 20),
                        Action(
                            "Remove command " + (index + 1).ToString(),
                            () -> {
                                ownerCommands.RemoveAt(current)
                                ownerCommandsChanged = true
                                OwnerChanged()
                            }
                        )
                    }
                )
            )
        }
        panel.Children.Add(
            Row(
                []Blob{
                    Entry(
                        "Command",
                        verifyCommand,
                        value -> {
                            verifyCommand = value
                        },
                        "dotnet test",
                        520
                    ),
                    Action(
                        "Add command",
                        () -> {
                            ownerCommands.Add([]string{"/bin/sh", "-c", verifyCommand})
                            verifyCommand = ""
                            ownerCommandsChanged = true
                            OwnerChanged()
                        },
                        disabled: String.IsNullOrWhiteSpace(verifyCommand)
                    )
                }
            )
        )
        panel.Children.Add(Rule())
        panel.Children.Add(Heading("Required CI checks", 28))
        let tags = Row([]Blob{})
        for name in ownerChecks {
            let selected = name
            tags.Children.Add(
                Action(
                    name + " ×",
                    () -> {
                        ownerChecks.Remove(selected)
                        ownerChecksChanged = true
                        OwnerChanged()
                    }
                )
            )
        }
        panel.Children.Add(tags)
        panel.Children.Add(
            Row(
                []Blob{
                    Entry(
                        "Check name",
                        checks,
                        value -> {
                            checks = value
                        },
                        "build",
                        360
                    ),
                    Action(
                        "Add check",
                        () -> {
                            if !ownerChecks.Contains(checks.Trim()) {
                                ownerChecks.Add(checks.Trim())
                            }
                            checks = ""
                            ownerChecksChanged = true
                            OwnerChanged()
                        },
                        disabled: String.IsNullOrWhiteSpace(checks)
                    )
                }
            )
        )
        return panel
    }

    private func OwnerPermissions() Blob {
        let body = Container{Gap: 18}
        let access = DonatePanel()
        access.Children.Add(Heading("Who can contribute", 28))
        let choices = Row([]Blob{})
        let selected = ownerEligibility == "" ? TextOf(ownerPolicy, "eligibility"): ownerEligibility
        for mode in[]string{"trusted", "open", "manual"} {
            let value = mode
            choices.Children.Add(
                ChoiceCard(
                    mode == "trusted" ? "Trusted donors": mode == "open" ? "Everyone": "Per issue",
                    "",
                    mode == "open" ? "public": "verified_user",
                    (selected == "" ? "trusted": selected) == mode,
                    () -> {
                        ownerEligibility = value
                        OwnerChanged()
                    }
                )
            )
        }
        access.Children.Add(choices)
        body.Children.Add(access)
        let tools = DonatePanel()
        tools.Children.Add(Heading("Coding tools", 28))
        let allowed = List[string]()
        if ownerTools != "" {
            for name in ownerTools.Split(',') {
                allowed.Add(name)
            }
        } else {
            for tool in Items(Field(ownerPolicy, "allowed_tools")) {
                allowed.Add(TextOf(tool, "harness"))
            }
        }
        if allowed.Count == 0 {
            allowed.Add("codex")
        }
        let row = Row([]Blob{})
        for choice in harnessChoices {
            let tool = choice
            row.Children.Add(
                ChoiceCard(
                    tool.Name,
                    "",
                    tool.Icon,
                    allowed.Contains(tool.Id),
                    () -> {
                        if allowed.Contains(tool.Id) {
                            if allowed.Count > 1 {
                                allowed.Remove(tool.Id)
                            }
                        } else {
                            allowed.Add(tool.Id)
                        }
                        ownerTools = String.Join(",", allowed)
                        OwnerChanged()
                    }
                )
            )
        }
        tools.Children.Add(row)
        body.Children.Add(tools)
        let models = DonatePanel()
        models.Children.Add(Heading("Models", 28))
        let modelPolicy =
        ownerModelPolicy == "" ? TextOf(ownerPolicy, "model_policy"): ownerModelPolicy
        models.Children.Add(
            Row(
                []Blob{
                    ChoiceCard(
                        "All supported",
                        "",
                        "apps",
                        modelPolicy == "unrestricted",
                        () -> {
                            ownerModelPolicy = "unrestricted"
                            OwnerChanged()
                        }
                    ),
                    ChoiceCard(
                        "Selected models",
                        "",
                        "checklist",
                        modelPolicy != "unrestricted",
                        () -> {
                            ownerModelPolicy = "whitelist"
                            OwnerChanged()
                        }
                    ),
                }
            )
        )
        if modelPolicy != "unrestricted" {
            for item in ownerModelMap {
                let key = item.Key
                models.Children.Add(
                    Row(
                        []Blob{
                            Label(key + " / " + String.Join(", ", item.Value), 20),
                            Action(
                                "Remove " + key,
                                () -> {
                                    ownerModelMap.Remove(key)
                                    ownerModels = JsonSerializer.Serialize(ownerModelMap)
                                    ownerModelPolicy = "whitelist"
                                    OwnerChanged()
                                }
                            )
                        }
                    )
                )
            }
            models.Children.Add(
                Row(
                    []Blob{
                        Entry(
                            "Model ID",
                            ownerModel,
                            value -> {
                                ownerModel = value
                            },
                            "gpt-6.1-sol",
                            300
                        ),
                        Entry(
                            "Efforts",
                            ownerEffort,
                            value -> {
                                ownerEffort = value
                            },
                            "high,xhigh",
                            200
                        ),
                        Action(
                            "Add model",
                            () -> {
                                let efforts = List[string]()
                                for value in ownerEffort.Split(',') {
                                    if value.Trim() != "" {
                                        efforts.Add(value.Trim())
                                    }
                                }
                                if efforts.Count == 0 {
                                    efforts.Add("absent")
                                }
                                ownerModelMap[ownerModel.Trim()] = efforts
                                ownerModels = JsonSerializer.Serialize(ownerModelMap)
                                ownerModelPolicy = "whitelist"
                                ownerModel = ""
                                ownerEffort = ""
                                OwnerChanged()
                            },
                            disabled: String.IsNullOrWhiteSpace(ownerModel)
                        )
                    }
                )
            )
        }
        body.Children.Add(models)
        let limits = DonatePanel()
        limits.Children.Add(Heading("Limits", 28))
        limits.Children.Add(
            Entry(
                "Maximum minutes per donation",
                ownerMinutes,
                value -> {
                    ownerMinutes = value
                    OwnerChanged()
                },
                (Number(ownerPolicy, "max_seconds") / 60).ToString(),
                280
            )
        )
        limits.Children.Add(
            Check(
                "Allow project network access",
                (
                    ownerNetwork == "" ? Field(
                        ownerPolicy,
                        "allow_network"
                    ).ValueKind == JsonValueKind.True: ownerNetwork == "allow"
                ),
                value -> {
                    ownerNetwork = value ? "allow": "deny"
                    OwnerChanged()
                }
            )
        )
        body.Children.Add(limits)
        return body
    }

    private func OwnerSetupView() Blob {
        let body = Container{Gap: 18}
        let steps = Row([]Blob{})
        let names = []string{"Checks", "Permissions", "Review"}
        for i in 0 ... names.Length {
            let step = i
            steps.Children.Add(
                Action(
                    names[i],
                    () -> {
                        ownerStep = step
                    },
                    ownerStep == i
                )
            )
        }
        body.Children.Add(steps)
        if ownerStep == 0 {
            body.Children.Add(OwnerChecks())
        } else if ownerStep == 1 {
            body.Children.Add(OwnerPermissions())
        } else {
            let review = DonatePanel()
            review.Children.Add(Heading("Project setup", 28))
            review.Children.Add(
                Entry(
                    "Local checkout",
                    projectPath,
                    value -> {
                        projectPath = value
                        OwnerChanged()
                    },
                    "/path/to/project",
                    650
                )
            )
            review.Children.Add(ReviewDetail("Repository", ownerRepository))
            review.Children.Add(
                ReviewDetail(
                    "Checks",
                    ownerCommands.Count.ToString() + " commands, " + ownerChecks.Count.ToString() + " CI checks"
                )
            )
            review.Children.Add(
                Row(
                    []Blob{
                        Action("Preview setup", () -> PreviewOwner(), true, projectPath == ""),
                        Action("Apply preview", () -> ApplyOwner(), disabled: ownerArguments.Length == 0)
                    }
                )
            )
            if ownerPreview != "" {
                review.Children.Add(
                    Text{
                        Content: ownerPreview,
                        FontFamily: "monospace",
                        FontSize: 14,
                        Color: Ink(),
                        MaxHeight: 420,
                        OverflowY: Overflow.Scroll
                    }
                )
            }
            body.Children.Add(review)
        }
        if ownerStep < 2 {
            body.Children.Add(
                Row(
                    []Blob{
                        Action(
                            "Back",
                            () -> {
                                ownerStep--
                            },
                            disabled: ownerStep == 0
                        ),
                        Action(
                            ownerStep == 0 ? "Set permissions": "Review setup",
                            () -> {
                                ownerStep++
                            },
                            true
                        )
                    }
                )
            )
        }
        return body
    }

    private func Owner() Blob {
        let body = Container{Gap: 20}
        body.Children.Add(Heading("My project", 38))
        if !ownerOpen {
            let project = DonatePanel()
            project.Children.Add(Heading("Open a project", 28))
            project.Children.Add(
                Entry(
                    "GitHub repository",
                    ownerRepository,
                    value -> {
                        ownerRepository = value
                        OwnerChanged()
                    },
                    "owner/repository",
                    540
                )
            )
            project.Children.Add(
                Row(
                    []Blob{
                        Action("Open project", () -> LoadOwner(), true, ownerRepository == ""),
                        Action(
                            "Check owner prerequisites",
                            () -> Execute(
                                []string{"doctor", "--owner", "--auth"},
                                result -> {
                                    if !Error(result) {
                                        message = "Owner prerequisites checked."
                                    }
                                }
                            )
                        )
                    }
                )
            )
            body.Children.Add(project)
            return body
        }
        body.Children.Add(
            Row(
                []Blob{
                    Heading(ownerRepository, 28),
                    Action(
                        "Change project",
                        () -> {
                            ownerOpen = false
                        }
                    ),
                    Action("Refresh project", () -> RefreshOwner())
                }
            )
        )
        let tabs = Row([]Blob{})
        for tab in[]string{"Contributions", "Access", "Setup"} {
            let selected = tab
            tabs.Children.Add(
                Action(
                    tab,
                    () -> {
                        ownerTab = selected
                        if selected == "Access" {
                            LoadAccess()
                        }
                    },
                    ownerTab == tab
                )
            )
        }
        body.Children.Add(tabs)
        if ownerTab == "Setup" {
            body.Children.Add(OwnerSetupView())
        } else if ownerTab == "Access" {
            body.Children.Add(OwnerAccessView())
        } else {
            for issue in ownerIssues {
                body.Children.Add(OwnerIssue(issue))
            }
            if ownerIssues.Count == 0 && !busy {
                body.Children.Add(Label("No open issues", 24))
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
            if ownerCommandsChanged {
                args.Add("--verification")
                args.Add(JsonSerializer.Serialize(ownerCommands))
            }
            if ownerChecksChanged {
                args.Add("--required-checks")
                args.Add(JsonSerializer.Serialize(ownerChecks))
            }
            if ownerModelPolicy != "" {
                args.Add("--model-policy")
                args.Add(ownerModelPolicy)
                if ownerModelPolicy == "whitelist" {
                    ownerModels = JsonSerializer.Serialize(ownerModelMap)
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
            Execute(
                proposed,
                result -> {
                    if Error(result) {
                        return
                    }
                    ownerArguments = proposed
                    ownerPreview = result.Diagnostics
                    message = "Review the proposed files before applying."
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
                                ownerArguments = []string{}
                                if result.ExitCode == 0 {
                                    ownerPreview = ""
                                    message = "Setup saved. Review and commit the files before approving issues."
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
