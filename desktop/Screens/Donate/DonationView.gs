package TokateDesktop

import Goo
import Goo.Widgets.Icons
import System
import System.Collections.Generic
import System.Text.Json

partial class DonationScreen {
    private func HarnessCards() Blob {
        let choices = ui.Row([]Blob{})
        for item in HarnessChoices.Items {
            let choice = item
            choices.Children.Add(
                ui.ChoiceCard(
                    choice.Name,
                    "",
                    choice.Icon,
                    harness == choice.Id,
                    () -> {
                        harness = choice.Id
                        model = choice.Id == "codex" ? "gpt-6.1-sol": ""
                        effort = choice.Id == "codex" ? "high": ""
                        profile = ""
                        if choice.Id == "codex" && codexModels.Count == 0 {
                            LoadCodexModels()
                        }
                    }
                )
            )
        }
        return choices
    }

    private func DonationHeading() Blob {
        let names = []string{"Issue", "Limits", "Review", "Donation"}
        let numerals = []string{"I", "II", "III", "IV"}
        let progress = ui.Row([]Blob{})
        progress.Gap = 10
        progress.Accessibility = Accessibility{
            Role: AccessibilityRole.Status,
            Name: "Step " + (step + 1).ToString() + " of 4: " + names[step],
        }
        for i in 0 ... names.Length {
            let item = Container{
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.Center,
                Gap: 8,
                Padding: Edges{Left: 12, Right: 12, Top: 8, Bottom: 8},
                BorderRadius: 4,
                BackgroundColor: i == step ? ui.Surface(): Color.Transparent,
                BorderWidth: Edges{Bottom: i == step ? 2: 0},
                BorderColor: ui.Accent(),
                ui.Label(numerals[i], 16, i != step),
                ui.Label(names[i], 16, i != step),
            }
            progress.Children.Add(item)
        }
        return Container{
            Gap: 18,
            ui.Heading(
                step == 0 ? "Choose an issue": step == 1 ? "Set your limits": step == 2 ? "Review": "Donation",
                38
            ),
            progress,
        }
    }

    func Build() Blob {
        if step == 3 {
            return Donation()
        }
        let body = Container{Gap: 20}
        body.Children.Add(DonationHeading())
        if app.Message != "" {
            body.Children.Add(
                Container{
                    Padding: 16,
                    BackgroundColor: ui.Surface(),
                    BorderWidth: Edges{Left: 3},
                    BorderColor: ui.Accent(),
                    Accessibility: Accessibility{Role: AccessibilityRole.Status, Name: app.Message},
                    ui.Label(app.Message, 18),
                }
            )
        }
        if step == 0 {
            if !donorIssues.Loaded {
                let project = ui.Panel()
                project.Children.Add(
                    ui.Entry(
                        "GitHub repository or issue URL",
                        repository,
                        value -> {
                            repository = value
                            donorIssues = IssuePage{Filter: "approved"}
                            account = ""
                            app.Message = ""
                        },
                        "owner/repository",
                        540
                    )
                )
                project.Children.Add(
                    ui.Row(
                        []Blob{
                            ui.Action(
                                "Find approved issues",
                                () -> LoadProject(),
                                true,
                                String.IsNullOrWhiteSpace(repository)
                            )
                        }
                    )
                )
                if account != "" {
                    project.Children.Add(ui.ReviewDetail("Account", account))
                }
                body.Children.Add(project)
            } else {
                body.Children.Add(
                    ui.Row(
                        []Blob{
                            ui.Heading(selectedRepository, 27),
                            ui.Action(
                                "Change repository",
                                () -> {
                                    donorIssues = IssuePage{Filter: "approved"}
                                    account = ""
                                }
                            ),
                        }
                    )
                )
            }
            if donorIssues.Loaded {
                body.Children.Add(
                    ui.IssueSearch(donorIssues, () -> issues.FindIssues(selectedRepository, donorIssues, search: true))
                )
                body.Children.Add(ui.IssueRows(donorIssues, item -> ChooseIssue(item)))
                body.Children.Add(
                    ui.IssuePagination(donorIssues, page -> issues.FindIssues(selectedRepository, donorIssues, page))
                )
            }
        } else if step == 1 {
            body.Children.Add(ui.Heading(selectedRepository + " #" + issue + "  " + issueTitle, 27))
            let columns = ui.ContentWidth >= 740
            let settings = ui.Row([]Blob{})
            settings.FlexDirection = columns ? FlexDirection.Row: FlexDirection.Column
            settings.AlignItems = AlignItems.Stretch
            settings.FlexWrap = FlexWrap.NoWrap
            let tools = ui.Panel()
            tools.FlexGrow = columns ? 1: 0
            tools.FlexBasis = columns ? Length(0): Length.Auto
            tools.Width = columns ? Length.Auto: Percent(100)
            tools.MinWidth = columns ? 350: 0
            tools.Accessibility = Accessibility{Role: AccessibilityRole.Group, Name: "Coding tool settings"}
            tools.Children.Add(ui.Heading("Coding tool", 28))
            tools.Children.Add(HarnessCards())
            if profiles.ValueKind == JsonValueKind.Object {
                let buttons = List[Blob]()
                for item in profiles.EnumerateObject() {
                    let name = item.Name
                    let value = item.Value
                    buttons.Add(
                        ui.Action(
                            "Use " + name,
                            () -> {
                                profile = name
                                UseSelection(value)
                            }
                        )
                    )
                }
                tools.Children.Add(ui.Row(buttons.ToArray()))
            }
            if profile != "" {
                tools.Children.Add(ui.ReviewDetail("Profile", profile))
            }
            if harness == "codex" {
                tools.Children.Add(
                    ui.Row(
                        []Blob{
                            ui.Dropdown(
                                "Model",
                                model,
                                CodexChoices(false),
                                value -> {
                                    model = value
                                    profile = ""
                                    var supported = false
                                    for choice in CodexChoices(true) {
                                        supported = supported || choice.Id == effort
                                    }
                                    if !supported {
                                        effort = ""
                                    }
                                },
                                230
                            ),
                            ui.Dropdown(
                                "Reasoning effort",
                                effort,
                                CodexChoices(true),
                                value -> {
                                    effort = value
                                    profile = ""
                                },
                                170
                            ),
                        }
                    )
                )
            } else {
                tools.Children.Add(
                    ui.Row(
                        []Blob{
                            ui.Entry(
                                "Model",
                                model,
                                value -> {
                                    model = value
                                    profile = ""
                                },
                                "Exact model ID",
                                230
                            ),
                            ui.Entry(
                                "Reasoning effort",
                                effort,
                                value -> {
                                    effort = value
                                    profile = ""
                                },
                                "For example, high",
                                170
                            ),
                        }
                    )
                )
            }
            if harness == "pi" {
                tools.Children.Add(
                    ui.Entry(
                        "Local endpoint",
                        endpoint,
                        value -> {
                            endpoint = value
                            profile = ""
                        },
                        "http://127.0.0.1:8080/v1",
                        540
                    )
                )
            }
            settings.Children.Add(tools)
            let time = ui.Panel()
            time.FlexGrow = columns ? 1: 0
            time.FlexBasis = columns ? Length(0): Length.Auto
            time.Width = columns ? Length.Auto: Percent(100)
            time.MinWidth = columns ? 350: 0
            time.Accessibility = Accessibility{Role: AccessibilityRole.Group, Name: "Time limit settings"}
            time.Children.Add(
                ui.Row([]Blob{MaterialIcons.Create("schedule", 25, ui.Accent()), ui.Heading("Time limits", 28)})
            )
            let presets = ui.Row([]Blob{})
            let maximum = Number(policy, "max_seconds")
            let reserve = int32.TryParse(verification, out var reserveMinutes) ? Math.Max(0, reserveMinutes): 0
            for minutes in[]string{"15", "30", "60"} {
                let chosen = minutes
                let total = (int32.Parse(minutes) + reserve) * 60
                presets.Children.Add(
                    ui.Action(
                        minutes + " min",
                        () -> {
                            coding = chosen
                            unlimited = false
                        },
                        !unlimited && coding == minutes,
                        total > 86400 || (maximum > 0 && total > maximum)
                    )
                )
            }
            time.Children.Add(presets)
            if maximum > 0 && !unlimited {
                time.Children.Add(
                    ui.Label("Coding + verification limit: " + (maximum / 60).ToString() + " minutes.", 16, true)
                )
            }
            if AllowsUnlimited() {
                time.Children.Add(
                    ui.Check(
                        "Unlimited coding time",
                        unlimited,
                        value -> {
                            unlimited = value
                        }
                    )
                )
            }
            let budgets = List[Blob]()
            if !unlimited {
                budgets.Add(
                    ui.Entry(
                        "Coding minutes",
                        coding,
                        value -> {
                            coding = value
                        },
                        width: 195
                    )
                )
            }
            budgets.Add(
                ui.Entry(
                    "Verification minutes",
                    verification,
                    value -> {
                        verification = value
                    },
                    width: 195
                )
            )
            time.Children.Add(ui.Row(budgets.ToArray()))
            time.Children.Add(ui.Rule())
            time.Children.Add(
                ui.Check(
                    "Allow project commands to use the network",
                    network,
                    value -> {
                        network = value
                    }
                )
            )
            settings.Children.Add(time)
            body.Children.Add(settings)
            body.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action(
                            "Back",
                            () -> {
                                step = 0
                                app.Message = ""
                            }
                        ),
                        ui.Action("Check selection & review", () -> ReviewDonation(), true)
                    }
                )
            )
        } else {
            let agreement = ui.Panel()
            agreement.Children.Add(
                Container{
                    Gap: 16,
                    ui.Heading("#" + issue + "  " + issueTitle, 27),
                    ui.Label(selectedRepository, 17, true),
                    ui.Rule(),
                    ui.Row(
                        []Blob{
                            ui.SummaryTile("Coding time", unlimited ? "Unlimited": coding + " minutes", "schedule"),
                            ui.SummaryTile("Verification", verification + " minutes", "verified"),
                        }
                    ),
                    ui.ReviewDetail("Account", account),
                    ui.ReviewDetail("Coding tool", harness),
                    ui.ReviewDetail("Model", model + " / " + effort),
                    ui.ReviewDetail("Project network", network ? "Allowed": "Offline"),
                }
            )
            body.Children.Add(agreement)
            body.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action(
                            "Change details",
                            () -> {
                                step = 1
                            }
                        ),
                        ui.Action("Reserve contribution", () -> Reserve(), true)
                    }
                )
            )
        }
        return body
    }

    private func Donation() Blob {
        let unbounded = Field(donation, "unlimited").ValueKind == JsonValueKind.True
        let codingTime = unbounded ? "Unlimited": (Number(donation, "coding_seconds") / 60).ToString() + " minutes"
        let verificationTime = (Number(donation, "verification_reserve") / 60).ToString() + " minutes"
        let body = Container{
            Height: donationStarted && !ui.Short() ? Percent(100): Length.Auto,
            MinHeight: 0,
            Gap: 18,
            DonationHeading(),
            ui.Label(
                donationPath == "" ? selectedRepository +
                    " #" +
                    issue: TextOf(donation, "repo") +
                    " #" +
                    TextOf(donation, "issue"),
                21
            ),
        }
        if !donationStarted {
            let waiting = ui.Panel()
            waiting.Children.Add(
                ui.Row(
                    []Blob{
                        MaterialIcons.Create(donationReady ? "task_alt": "hourglass_top", 32, ui.Accent()),
                        ui.Heading(donationState, 32),
                    }
                )
            )
            if donationPath != "" {
                waiting.Children.Add(
                    ui.Row(
                        []Blob{
                            ui.SummaryTile("Coding", codingTime, "schedule"),
                            ui.SummaryTile("Verification", verificationTime, "verified"),
                        }
                    )
                )
                waiting.Children.Add(
                    ui.ReviewDetail("Model", TextOf(donation, "model") + " / " + TextOf(donation, "effort"))
                )
            }
            if app.Message != "" {
                waiting.Children.Add(ui.Label(app.Message, 17, true))
            }
            waiting.Children.Add(
                ui.Row([]Blob{ui.Action("Start donation", () -> StartDonation(), true, !donationReady)})
            )
            if app.Busy && app.Page == app.ActivePage {
                waiting.Children.Add(ui.Row([]Blob{ui.CancelCommand()}))
            }
            if !app.Busy && donationPath == "" {
                waiting.Children.Add(ui.Row([]Blob{ui.Action("Inspect saved work", () -> app.Navigate("Saved work"))}))
            }
            body.Children.Add(waiting)
            return body
        }
        if app.Message != "" {
            body.Children.Add(ui.Label(app.Message, 17))
        }
        if renderedOutput != donationOutput || renderedTheme != ui.Twilight || activityLines.Count == 0 {
            renderedOutput = donationOutput
            renderedTheme = ui.Twilight
            let rows = List[ActivityLine]()
            let lines = (donationOutput == "" ? "Starting donation...": donationOutput).Split('\n')
            for i in 0 ... lines.Length {
                if !String.IsNullOrWhiteSpace(lines[i]) {
                    rows.Add(ActivityLine{Index: i, Content: lines[i].TrimEnd('\r'), Theme: renderedTheme})
                }
            }
            activityLines = rows
        }
        let output = VirtualRows(
            activityLines,
            64,
            (line ActivityLine) -> line.Index.ToString(),
            (line ActivityLine) -> Container{
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.FlexStart,
                Gap: 14,
                Padding: Edges{Left: 22, Right: 22, Top: 16, Bottom: 16},
                BorderWidth: Edges{Bottom: 1},
                BorderColor: ui.Line(),
                MaterialIcons.Create("chevron_right", 18, ui.Accent()),
                Text{
                    Content: line.Content,
                    FontFamily: "Newsreader",
                    FontSize: 18,
                    Color: ui.Ink(),
                    FlexGrow: 1,
                    FlexBasis: 0,
                    MinWidth: 0,
                    Accessibility: Accessibility{Role: AccessibilityRole.Text, Name: "Command output"},
                },
            }
        )
        output.Handle = outputViewport
        output.Accessibility = Accessibility{Role: AccessibilityRole.Generic, Name: "Donation output"}
        output.FlexGrow = ui.Short() ? 0: 1
        output.FlexBasis = ui.Short() ? Length.Auto: Length(0)
        output.MinHeight = ui.Short() ? 240: 0
        output.Focusable = true
        output.OnKeyDown = event -> {
            if event.Key == Key.Home {
                followOutput = false
                outputViewport.JumpTo(0, 0)
                event.PreventDefault()
            } else if event.Key == Key.End {
                followOutput = true
                if activityLines.Count > 0 {
                    outputViewport.ScrollToItem(activityLines[activityLines.Count - 1].Index.ToString())
                }
                event.PreventDefault()
            }
        }
        let footer = Container{
            FlexDirection: FlexDirection.Row,
            FlexWrap: FlexWrap.Wrap,
            AlignItems: AlignItems.Center,
            Gap: 16,
            Padding: Edges{Left: 18, Right: 18, Top: 12, Bottom: 12},
            ui.Label("Elapsed " + Elapsed(donationElapsed), 17, true),
            Container{FlexGrow: 1},
        }
        if donationRunning {
            if !followOutput {
                footer.Children.Add(
                    ui.Action(
                        "Follow live",
                        () -> {
                            followOutput = true
                            if activityLines.Count > 0 {
                                outputViewport.ScrollToItem(activityLines[activityLines.Count - 1].Index.ToString())
                            }
                        },
                        allowWhileBusy: true
                    )
                )
            }
            footer.Children.Add(ui.CancelCommand())
        } else {
            footer.Children.Add(
                ui.Action(
                    "New donation",
                    () -> {
                        step = 0
                        donationStarted = false
                        app.Message = ""
                        app.Report = ""
                    }
                )
            )
            footer.Children.Add(
                ui.Action(
                    "View saved work",
                    () -> {
                        openSaved(donationPath)
                    }
                )
            )
        }
        body.Children.Add(
            Container{
                FlexGrow: 1,
                FlexBasis: 0,
                MinHeight: 0,
                Overflow: Overflow.Hidden,
                BackgroundColor: ui.Surface(),
                BorderWidth: 1,
                BorderColor: ui.Line(),
                BorderRadius: 5,
                Container{
                    Padding: Edges{Left: 18, Right: 18, Top: 14, Bottom: 14},
                    Accessibility: Accessibility{
                        Role: AccessibilityRole.Status,
                        Name: donationState,
                        Busy: donationRunning
                    },
                    ui.Row(
                        []Blob{
                            MaterialIcons.Create(donationRunning ? "auto_awesome": "task_alt", 24, ui.Accent()),
                            ui.Heading(donationState, 28),
                        }
                    ),
                    ui.Label("Coding: " + codingTime + "   /   Verification: " + verificationTime, 16, true),
                },
                ui.Rule(),
                output,
                ui.Rule(),
                footer,
            }
        )
        return body
    }
}

data struct ActivityLine {
    var Index int32
    var Content string
    var Theme float64
}
