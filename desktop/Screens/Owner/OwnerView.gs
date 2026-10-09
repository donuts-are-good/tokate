package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.Text.Json

partial class OwnerScreen {
    private func OwnerIssue(issue JsonElement) Blob {
        let number = TextOf(issue, "number")
        var approved = false
        for label in Items(Field(issue, "labels")) {
            approved = approved || TextOf(label, "name") == "tokate:approved"
        }
        var remote JsonElement
        ownerWork.TryGetValue(number, out remote)
        let card = ui.Panel()
        card.Children.Add(
            ui.Row(
                []Blob{
                    ui.Heading("#" + number + "  " + TextOf(issue, "title"), 27),
                    ui.StatusBadge(
                        remote.ValueKind == JsonValueKind.Object ? TextOf(remote, "state").Replace(
                            '_',
                            ' '
                        ): approved ? "Approved": "Needs approval"
                    )
                }
            )
        )
        let actions = ui.Row([]Blob{})
        actions.Children.Add(ui.Action("Refresh contribution", () -> InspectOwnerIssue(number)))
        actions.Children.Add(
            ui.Action(
                "Open issue #" + number,
                () -> Browser.Open("https://github.com/" + ownerRepository + "/issues/" + number)
            )
        )
        actions.Children.Add(
            ui.Action(
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
                        approved ? "Revoke issue approval #" + number: "Approve issue #" + number,
                        args.ToArray(),
                        approved ? "Stop future work under this approval.": "Authorize issue #" +
                            number +
                            " on " +
                            ownerBranch +
                            " under the current project policy."
                    )
                },
                !approved,
                !ownerCanWrite || (!approved && Number(ownerPolicy, "version") < 2)
            )
        )
        for draft in Items(Field(remote, "drafts")) {
            let pr = TextOf(draft, "pr")
            actions.Children.Add(
                ui.Action(
                    "Review PR #" + pr,
                    () -> Browser.Open("https://github.com/" + ownerRepository + "/pull/" + pr)
                )
            )
            actions.Children.Add(ui.Action("Verify PR #" + pr, () -> CheckOwnerPr(pr, "verify-pr")))
            actions.Children.Add(ui.Action("Check CI #" + pr, () -> CheckOwnerPr(pr, "checks")))
        }
        card.Children.Add(actions)
        return card
    }

    private func OwnerAccessView() Blob {
        let body = Container{Gap: 18}
        body.Children.Add(
            ui.Row(
                []Blob{
                    ui.Action("Refresh access", () -> LoadAccess()),
                    ui.Action(
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
            let card = ui.Panel()
            card.Children.Add(
                ui.Row([]Blob{ui.Heading(donor, 28), ui.StatusBadge("Access requested"), ui.Label("#" + issue, 22)})
            )
            card.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action(
                            "Grant #" + issue + " to " + donor,
                            () -> AccessAction("grant", donor, issue),
                            true,
                            !ownerCanWrite
                        ),
                        ui.Action("Trust " + donor, () -> AccessAction("trust", donor), disabled: !ownerCanWrite)
                    }
                )
            )
            body.Children.Add(card)
        }
        for member in Items(Field(ownerAccess, "members")) {
            let donor = TextOf(member, "donor")
            let trusted = Field(member, "trusted").ValueKind == JsonValueKind.True
            let denied = Field(member, "denied").ValueKind == JsonValueKind.True
            let card = ui.Panel()
            card.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Heading(donor, 28),
                        ui.StatusBadge(denied ? "Denied": trusted ? "Trusted": "Issue access")
                    }
                )
            )
            card.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action(
                            trusted ? "Untrust " + donor: "Trust " + donor,
                            () -> AccessAction(trusted ? "untrust": "trust", donor),
                            disabled: !ownerCanWrite
                        ),
                        ui.Action(
                            denied ? "Restore " + donor: "Deny " + donor,
                            () -> AccessAction(denied ? "restore": "deny", donor),
                            disabled: !ownerCanWrite
                        )
                    }
                )
            )
            body.Children.Add(card)
        }
        let add = ui.Panel()
        add.Children.Add(ui.Heading("Grant access", 28))
        add.Children.Add(
            ui.Row(
                []Blob{
                    ui.Entry(
                        "Donor",
                        ownerDonor,
                        value -> {
                            ownerDonor = value
                        },
                        "GitHub username",
                        280
                    ),
                    ui.Entry(
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
            ui.Row(
                []Blob{
                    ui.Action(
                        "Grant issue access",
                        () -> AccessAction("grant", ownerDonor, ownerIssue),
                        true,
                        !ownerCanWrite || ownerDonor == "" || !int32.TryParse(ownerIssue, out var number) || number < 1
                    ),
                    ui.Action(
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
        let panel = ui.Panel()
        panel.Children.Add(ui.Heading("Verification", 28))
        for index in 0 ... ownerCommands.Count {
            let current = index
            let args = ownerCommands[index]
            panel.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Label(String.Join(" ", args), 20),
                        ui.Action(
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
            ui.Row(
                []Blob{
                    ui.Entry(
                        "Command",
                        verifyCommand,
                        value -> {
                            verifyCommand = value
                        },
                        "dotnet test",
                        520
                    ),
                    ui.Action(
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
        panel.Children.Add(ui.Rule())
        panel.Children.Add(ui.Heading("Required CI checks", 28))
        let tags = ui.Row([]Blob{})
        for name in ownerChecks {
            let selected = name
            tags.Children.Add(
                ui.Action(
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
            ui.Row(
                []Blob{
                    ui.Entry(
                        "Check name",
                        checks,
                        value -> {
                            checks = value
                        },
                        "build",
                        360
                    ),
                    ui.Action(
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
        let access = ui.Panel()
        access.Children.Add(ui.Heading("Who can contribute", 28))
        let choices = ui.Row([]Blob{})
        let selected = ownerEligibility == "" ? TextOf(ownerPolicy, "eligibility"): ownerEligibility
        for mode in[]string{"trusted", "open", "manual"} {
            let value = mode
            choices.Children.Add(
                ui.ChoiceCard(
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
        let tools = ui.Panel()
        tools.Children.Add(ui.Heading("Coding tools", 28))
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
        let row = ui.Row([]Blob{})
        for choice in HarnessChoices.Items {
            let tool = choice
            row.Children.Add(
                ui.ChoiceCard(
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
        let models = ui.Panel()
        models.Children.Add(ui.Heading("Models", 28))
        let modelPolicy =
        ownerModelPolicy == "" ? TextOf(ownerPolicy, "model_policy"): ownerModelPolicy
        models.Children.Add(
            ui.Row(
                []Blob{
                    ui.ChoiceCard(
                        "All supported",
                        "",
                        "apps",
                        modelPolicy == "unrestricted",
                        () -> {
                            ownerModelPolicy = "unrestricted"
                            OwnerChanged()
                        }
                    ),
                    ui.ChoiceCard(
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
                    ui.Row(
                        []Blob{
                            ui.Label(key + " / " + String.Join(", ", item.Value), 20),
                            ui.Action(
                                "Remove " + key,
                                () -> {
                                    ownerModelMap.Remove(key)
                                    ownerModels = OwnerModelsJson()
                                    ownerModelPolicy = "whitelist"
                                    OwnerChanged()
                                }
                            )
                        }
                    )
                )
            }
            models.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Entry(
                            "Model ID",
                            ownerModel,
                            value -> {
                                ownerModel = value
                            },
                            "gpt-6.1-sol",
                            300
                        ),
                        ui.Entry(
                            "Efforts",
                            ownerEffort,
                            value -> {
                                ownerEffort = value
                            },
                            "high,xhigh",
                            200
                        ),
                        ui.Action(
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
                                ownerModels = OwnerModelsJson()
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
        let limits = ui.Panel()
        limits.Children.Add(ui.Heading("Limits", 28))
        limits.Children.Add(
            ui.Entry(
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
            ui.Check(
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
        let steps = ui.Row([]Blob{})
        let names = []string{"Checks", "Permissions", "Review"}
        for i in 0 ... names.Length {
            let step = i
            steps.Children.Add(
                ui.Action(
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
            let review = ui.Panel()
            review.Children.Add(ui.Heading("Project setup", 28))
            review.Children.Add(
                ui.Entry(
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
            review.Children.Add(ui.ReviewDetail("Repository", ownerRepository))
            review.Children.Add(
                ui.ReviewDetail(
                    "Checks",
                    ownerCommands.Count.ToString() + " commands, " + ownerChecks.Count.ToString() + " CI checks"
                )
            )
            review.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action("Preview setup", () -> PreviewOwner(), true, projectPath == ""),
                        ui.Action("Apply preview", () -> ApplyOwner(), disabled: ownerArguments.Length == 0)
                    }
                )
            )
            if ownerPreview != "" {
                review.Children.Add(
                    Text{
                        Content: ownerPreview,
                        FontFamily: "monospace",
                        FontSize: 14,
                        Color: ui.Ink(),
                        MaxHeight: 420,
                        OverflowY: Overflow.Scroll
                    }
                )
            }
            body.Children.Add(review)
        }
        if ownerStep < 2 {
            body.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action(
                            "Back",
                            () -> {
                                ownerStep--
                            },
                            disabled: ownerStep == 0
                        ),
                        ui.Action(
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

    func Build() Blob {
        let body = Container{Gap: 20}
        body.Children.Add(ui.Heading("My project", 38))
        if !ownerOpen {
            let project = ui.Panel()
            project.Children.Add(ui.Heading("Open a project", 28))
            project.Children.Add(
                ui.Entry(
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
                ui.Row(
                    []Blob{
                        ui.Action("Open project", () -> LoadOwner(), true, ownerRepository == ""),
                        ui.Action(
                            "Check owner prerequisites",
                            () -> app.Execute(
                                []string{"doctor", "--owner", "--auth"},
                                result -> {
                                    if !app.Error(result) {
                                        app.Message = "Owner prerequisites checked."
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
            ui.Row(
                []Blob{
                    ui.Heading(ownerRepository, 28),
                    ui.Action(
                        "Change project",
                        () -> {
                            ownerOpen = false
                        }
                    ),
                    ui.Action("Refresh project", () -> RefreshOwner())
                }
            )
        )
        let tabs = ui.Row([]Blob{})
        for tab in[]string{"Contributions", "Access", "Setup"} {
            let selected = tab
            tabs.Children.Add(
                ui.Action(
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
            if ownerSelected.ValueKind == JsonValueKind.Object {
                body.Children.Add(
                    ui.Row(
                        []Blob{
                            ui.Action(
                                "Back to issues",
                                () -> {
                                    ownerSelected = JsonElement{}
                                }
                            )
                        }
                    )
                )
                body.Children.Add(OwnerIssue(ownerSelected))
            } else {
                body.Children.Add(ui.IssueSearch(ownerIssues, () -> SearchOwnerIssues(1, true), true))
                body.Children.Add(
                    ui.IssueRows(
                        ownerIssues,
                        selected -> {
                            ownerSelected = selected
                            app.ActionName = "Refresh contribution"
                            InspectOwnerIssue(TextOf(selected, "number"))
                        }
                    )
                )
                body.Children.Add(ui.IssuePagination(ownerIssues, page -> SearchOwnerIssues(page)))
            }
        }
        return body
    }
}
