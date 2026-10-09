package TokateDesktop

import Goo
import System
import System.Text.Json

partial class SavedWorkScreen {
    private func SavedDetails() Blob {
        let panel = ui.Panel()
        panel.Children.Add(ui.Heading(TextOf(run, "repo") + " #" + TextOf(run, "issue"), 28))
        panel.Children.Add(ui.ReviewDetail("Model", TextOf(run, "model") + " / " + TextOf(run, "effort")))
        let failure = TextOf(Field(run, "error"), "message")
        if failure != "" {
            panel.Children.Add(ui.Label(failure, 18))
        }
        let actions = ui.Row([]Blob{})
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
            actions.Children.Add(ui.Action(title, () -> RunAction(selected), command == "work" || command == "submit"))
        }
        if Number(run, "pr") > 0 {
            actions.Children.Add(
                ui.Action(
                    "Amend contribution",
                    () -> {
                        amendment = !amendment
                    }
                )
            )
            actions.Children.Add(ui.Action("Update workspace", () -> RunAction("reconcile")))
            actions.Children.Add(
                ui.Action(
                    "Open pull request",
                    () -> Browser.Open("https://github.com/" + TextOf(run, "repo") + "/pull/" + TextOf(run, "pr"))
                )
            )
        }
        actions.Children.Add(
            ui.Action(
                "Open issue",
                () -> Browser.Open("https://github.com/" + TextOf(run, "repo") + "/issues/" + TextOf(run, "issue"))
            )
        )
        panel.Children.Add(actions)
        if runActions.Contains("recover") || amendment {
            panel.Children.Add(
                ui.Entry(
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
                ui.Entry(
                    "Candidate commit",
                    amendmentCommit,
                    value -> {
                        amendmentCommit = value
                    },
                    width: 650
                )
            )
            panel.Children.Add(
                ui.Entry(
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
                ui.Entry(
                    "Tool declarations file",
                    amendmentTools,
                    value -> {
                        amendmentTools = value
                    },
                    "Optional path",
                    650
                )
            )
            panel.Children.Add(ui.Action("Verify and publish amendment", () -> RunAction("amend"), true))
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
        let title = ui.Heading(item.Title == "" ? identity: item.Title, 24)
        title.TextMaxLines = 2
        let copy = Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, Gap: 5}
        if item.Title != "" {
            copy.Children.Add(ui.Label(identity, 16, true))
        }
        copy.Children.Add(title)
        return ui.Keyboard(
            Button{
                Key: item.Path,
                MinHeight: 72,
                Padding: 12,
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.Center,
                Gap: 18,
                BorderWidth: Edges{Bottom: 1},
                BorderColor: ui.Line(),
                BackgroundColor: Color.Transparent,
                Hover: Style{BackgroundColor: ui.Paper()},
                Focus: ui.FocusStyle(),
                Focusable: true,
                Disabled: app.Busy || item.Data.ValueKind != JsonValueKind.Object || item.Error != "",
                Accessibility: Accessibility{
                    Role: AccessibilityRole.Button,
                    Name: "Saved " + identity,
                    Description: item.Error
                },
                OnClick: () -> SelectRun(item.Data, item.Actions, item.Path),
                copy,
                ui.StatusBadge(SavedStatus(item)),
            }
        )
    }

    func Build() Blob {
        let body = Container{Gap: 20}
        body.Children.Add(ui.Heading("Saved work", 38))
        body.Children.Add(
            ui.Row(
                []Blob{
                    ui.Action(
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
                    ui.Action(
                        "Open saved run",
                        () -> {
                            savedImport = !savedImport
                        }
                    ),
                }
            )
        )
        if savedImport {
            let opening = ui.Panel()
            opening.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Entry(
                            "Run directory",
                            runDirectory,
                            value -> {
                                runDirectory = value
                            },
                            "Path printed by Tokate",
                            560
                        ),
                        ui.Action("Open run", () -> LoadRun(), true, runDirectory == ""),
                    }
                )
            )
            body.Children.Add(opening)
        }
        if savedSelected {
            body.Children.Add(
                ui.Row(
                    []Blob{
                        ui.Action("Back to contributions", () -> LoadSavedPage(savedPage)),
                        ui.Action("Refresh status", () -> LoadRun()),
                    }
                )
            )
            body.Children.Add(SavedDetails())
        } else if savedLoaded {
            let table = ui.TablePanel()
            var visible = 0
            for index in 0 ... savedWork.Count {
                let item = savedWork[index]
                if SavedStatus(item) == "Merged" {
                    continue
                }
                visible++
                table.Children.Add(SavedRow(item, index + (savedPage - 1) * IssuePage.Size))
            }
            if visible == 0 && !savedReading {
                table.Children.Add(
                    ui.Label(
                        savedPaths.Count == 0 ? "No saved contributions": "No unmerged contributions on this page",
                        24
                    )
                )
            }
            body.Children.Add(table)
            body.Children.Add(
                ui.PageNavigation(
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
