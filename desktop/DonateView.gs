package TokateDesktop

import Goo
import Goo.Widgets.Icons
import System
import System.Collections.Generic
import System.Text.Json

class HarnessChoice(id string, name string, icon string) {
    let Id string = id
    let Name string = name
    let Icon string = icon
}

partial class Desktop {
    private let harnessChoices[]HarnessChoice = []HarnessChoice{
        HarnessChoice("codex", "Codex", "terminal"),
        HarnessChoice("pi", "Pi / local", "memory"),
    }

    private func HarnessCards() Blob {
        let choices = Row([]Blob{})
        for item in harnessChoices {
            let choice = item
            choices.Children.Add(
                ChoiceCard(
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
        let progress = Row([]Blob{})
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
                BackgroundColor: i == step ? Surface(): Color.Transparent,
                BorderWidth: Edges{Bottom: i == step ? 2: 0},
                BorderColor: Accent(),
                Label(numerals[i], 16, i != step),
                Label(names[i], 16, i != step),
            }
            progress.Children.Add(item)
        }
        return Container{
            Gap: 18,
            Heading(step == 0 ? "Choose an issue": step == 1 ? "Set your limits": step == 2 ? "Review": "Donation", 38),
            progress,
        }
    }

    private func DonatePanel() Container -> Container{
        Padding: contentWidth < 650 ? 20: 28,
        Gap: 18,
        BackgroundColor: Surface(),
        BorderWidth: 1,
        BorderColor: Line(),
        BorderRadius: 8,
    }

    private func ChoiceCard(title string, detail string, icon string, selected bool, choose Action) Blob -> Keyboard(
        Button{
            FlexGrow: 1,
            FlexBasis: 0,
            MinWidth: 190,
            MinHeight: 82,
            Padding: 20,
            Gap: 10,
            AlignSelf: AlignSelf.Stretch,
            AlignItems: AlignItems.FlexStart,
            BackgroundColor: selected ? Paper(): Surface(),
            BorderWidth: selected ? 2: 1,
            BorderColor: selected ? Accent(): Line(),
            BorderRadius: 6,
            Disabled: busy,
            Focusable: true,
            Focus: FocusStyle(),
            Hover: Style{BorderColor: Accent()},
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: title, Description: detail},
            OnClick: choose,
            Container{
                Width: Percent(100),
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.Center,
                Gap: 12,
                MaterialIcons.Create(icon, 24, Accent()),
                Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, Heading(title, 27)},
                MaterialIcons.Create("check_circle", 18, selected ? Accent(): Color.Transparent),
            },
        }
    )

    private func SummaryTile(title string, value string, icon string) Blob -> Container{
        FlexGrow: 1,
        FlexBasis: 0,
        MinWidth: 190,
        Padding: 20,
        Gap: 12,
        BackgroundColor: Paper(),
        BorderRadius: 6,
        Row([]Blob{MaterialIcons.Create(icon, 22, Accent()), Label(title, 16, true)}),
        Heading(value, 29),
    }

    private func ReviewDetail(label string, value string) Blob -> Container{
        FlexDirection: FlexDirection.Row,
        AlignItems: AlignItems.FlexStart,
        Gap: 16,
        Container{Width: 120, FlexShrink: 0, Label(label, 17, true)},
        Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, Label(value, 19)},
    }

    private func Donate() Blob {
        if step == 3 {
            return Donation()
        }
        let body = Container{Gap: 20}
        body.Children.Add(DonationHeading())
        if message != "" {
            body.Children.Add(
                Container{
                    Padding: 16,
                    BackgroundColor: Surface(),
                    BorderWidth: Edges{Left: 3},
                    BorderColor: Accent(),
                    Accessibility: Accessibility{Role: AccessibilityRole.Status, Name: message},
                    Label(message, 18),
                }
            )
        }
        if step == 0 {
            let project = DonatePanel()
            project.Children.Add(
                Entry(
                    "GitHub repository or issue URL",
                    repository,
                    value -> {
                        repository = value
                        issues.Clear()
                        account = ""
                        message = ""
                    },
                    "owner/repository",
                    540
                )
            )
            project.Children.Add(
                Row(
                    []Blob{
                        Action("Find approved issues", () -> LoadProject(), true, String.IsNullOrWhiteSpace(repository))
                    }
                )
            )
            if account != "" {
                project.Children.Add(ReviewDetail("Account", account))
            }
            body.Children.Add(project)
            for item in issues {
                let current = item
                body.Children.Add(
                    ChoiceCard(
                        "#" + TextOf(item, "number") + "   " + TextOf(item, "title"),
                        "Approved by the maintainer. Choose this work to continue.",
                        "task_alt",
                        false,
                        () -> ChooseIssue(current)
                    )
                )
            }
        } else if step == 1 {
            body.Children.Add(Heading(selectedRepository + " #" + issue + "  " + issueTitle, 27))
            let columns = contentWidth >= 740
            let settings = Row([]Blob{})
            settings.FlexDirection = columns ? FlexDirection.Row: FlexDirection.Column
            settings.AlignItems = AlignItems.Stretch
            settings.FlexWrap = FlexWrap.NoWrap
            let tools = DonatePanel()
            tools.FlexGrow = columns ? 1: 0
            tools.FlexBasis = columns ? Length(0): Length.Auto
            tools.Width = columns ? Length.Auto: Percent(100)
            tools.MinWidth = columns ? 350: 0
            tools.Accessibility = Accessibility{Role: AccessibilityRole.Group, Name: "Coding tool settings"}
            tools.Children.Add(Heading("Coding tool", 28))
            tools.Children.Add(HarnessCards())
            if profiles.ValueKind == JsonValueKind.Object {
                let buttons = List[Blob]()
                for item in profiles.EnumerateObject() {
                    let name = item.Name
                    let value = item.Value
                    buttons.Add(
                        Action(
                            "Use " + name,
                            () -> {
                                profile = name
                                UseSelection(value)
                            }
                        )
                    )
                }
                tools.Children.Add(Row(buttons.ToArray()))
            }
            if profile != "" {
                tools.Children.Add(ReviewDetail("Profile", profile))
            }
            if harness == "codex" {
                tools.Children.Add(
                    Row(
                        []Blob{
                            Dropdown(
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
                            Dropdown(
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
                    Row(
                        []Blob{
                            Entry(
                                "Model",
                                model,
                                value -> {
                                    model = value
                                    profile = ""
                                },
                                "Exact model ID",
                                230
                            ),
                            Entry(
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
                    Entry(
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
            let time = DonatePanel()
            time.FlexGrow = columns ? 1: 0
            time.FlexBasis = columns ? Length(0): Length.Auto
            time.Width = columns ? Length.Auto: Percent(100)
            time.MinWidth = columns ? 350: 0
            time.Accessibility = Accessibility{Role: AccessibilityRole.Group, Name: "Time limit settings"}
            time.Children.Add(Row([]Blob{MaterialIcons.Create("schedule", 25, Accent()), Heading("Time limits", 28)}))
            let presets = Row([]Blob{})
            let maximum = Number(policy, "max_seconds")
            let reserve = int32.TryParse(verification, out var reserveMinutes) ? Math.Max(0, reserveMinutes): 0
            for minutes in[]string{"15", "30", "60"} {
                let chosen = minutes
                let total = (int32.Parse(minutes) + reserve) * 60
                presets.Children.Add(
                    Action(
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
                    Label("Coding + verification limit: " + (maximum / 60).ToString() + " minutes.", 16, true)
                )
            }
            if AllowsUnlimited() {
                time.Children.Add(
                    Check(
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
                    Entry(
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
                Entry(
                    "Verification minutes",
                    verification,
                    value -> {
                        verification = value
                    },
                    width: 195
                )
            )
            time.Children.Add(Row(budgets.ToArray()))
            time.Children.Add(Rule())
            time.Children.Add(
                Check(
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
                Row(
                    []Blob{
                        Action(
                            "Back",
                            () -> {
                                step = 0
                                message = ""
                            }
                        ),
                        Action("Check selection & review", () -> ReviewDonation(), true)
                    }
                )
            )
        } else {
            let agreement = DonatePanel()
            agreement.Children.Add(
                Container{
                    Gap: 16,
                    Heading("#" + issue + "  " + issueTitle, 27),
                    Label(selectedRepository, 17, true),
                    Rule(),
                    Row(
                        []Blob{
                            SummaryTile("Coding time", unlimited ? "Unlimited": coding + " minutes", "schedule"),
                            SummaryTile("Verification", verification + " minutes", "verified"),
                        }
                    ),
                    ReviewDetail("Account", account),
                    ReviewDetail("Coding tool", harness),
                    ReviewDetail("Model", model + " / " + effort),
                    ReviewDetail("Project network", network ? "Allowed": "Offline"),
                }
            )
            body.Children.Add(agreement)
            body.Children.Add(
                Row(
                    []Blob{
                        Action(
                            "Change details",
                            () -> {
                                step = 1
                            }
                        ),
                        Action("Reserve contribution", () -> Reserve(), true)
                    }
                )
            )
        }
        return body
    }
}
