package TokateDesktop

import Goo
import System
import System.Text.Json

partial class ThemedControls {
    func IssueSearch(state IssuePage, search Action, owner bool = false) Blob {
        let body = Container{Gap: 12}
        let controls = Row(
            []Blob{
                Entry(
                    "Search issues",
                    state.Query,
                    value -> {
                        state.Query = value
                    },
                    "Title keywords or #number",
                    480,
                    search
                ),
                Action("Search issues", search, true),
            }
        )
        controls.AlignItems = AlignItems.FlexEnd
        body.Children.Add(controls)
        if owner {
            let filters = Row([]Blob{})
            for filter in[]string{"all", "approved", "unapproved"} {
                let selected = filter
                filters.Children.Add(
                    Action(
                        filter == "all" ? "All open": filter == "approved" ? "Approved": "Needs approval",
                        () -> {
                            state.Filter = selected
                            search()
                        },
                        state.Filter == filter
                    )
                )
            }
            body.Children.Add(filters)
        }
        if state.Total > 1000 || state.Incomplete {
            body.Children.Add(Label("Refine your search to see all matching issues.", 17))
        }
        return body
    }

    func TablePanel() Container {
        let panel = Panel()
        panel.Padding = 8
        panel.Gap = 0
        panel.FlexGrow = Short() ? 0: 1
        panel.FlexShrink = Short() ? 0: 1
        panel.FlexBasis = Short() ? Length.Auto: Length(0)
        panel.MinHeight = 0
        panel.OverflowY = Short() ? Overflow.Visible: Overflow.Scroll
        return panel
    }

    func IssueRows(state IssuePage, choose Action[JsonElement]) Blob {
        let panel = TablePanel()
        for issue in state.Rows {
            let selected = issue
            let title = TextOf(issue, "title")
            let number = TextOf(issue, "number")
            let caption = Heading(title, 24)
            caption.TextMaxLines = 2
            panel.Children.Add(
                Keyboard(
                    Button{
                        Key: number,
                        MinHeight: 64,
                        Padding: 12,
                        FlexDirection: FlexDirection.Row,
                        AlignItems: AlignItems.Center,
                        Gap: 14,
                        BorderWidth: Edges{Bottom: 1},
                        BorderColor: Line(),
                        BackgroundColor: Color.Transparent,
                        Hover: Style{BackgroundColor: Paper()},
                        Focus: FocusStyle(),
                        Focusable: true,
                        Disabled: Busy,
                        Accessibility: Accessibility{
                            Role: AccessibilityRole.Button,
                            Name: "Issue #" + number + ": " + title
                        },
                        OnClick: () -> choose(selected),
                        Container{Width: 65, FlexShrink: 0, Label("#" + number, 18, true)},
                        Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, caption},
                        Label(IssuePage.ApprovedIssue(issue) ? "Approved": "Open", 16, true),
                    }
                )
            )
        }
        if state.Loaded && state.Rows.Count == 0 && !Busy {
            panel.Children.Add(Label("No matching issues", 24))
        }
        return panel
    }

    func IssuePagination(state IssuePage, change Action[int32]) Blob ->
    PageNavigation(state.Page, Math.Min(1000, state.Total), state.Total.ToString() + " issues", change)

    func PageNavigation(page int32, total int32, summary string, change Action[int32]) Blob {
        let last = Math.Max(1, (total + IssuePage.Size - 1) / IssuePage.Size)
        let buttons = Row(
            []Blob{
                Action("Previous page", () -> change(page - 1), disabled: page <= 1),
                Action("Next page", () -> change(page + 1), disabled: page >= last),
            }
        )
        buttons.JustifyContent = JustifyContent.FlexEnd
        let pager = Container{
            FlexDirection: ContentWidth < 540 ? FlexDirection.Column: FlexDirection.Row,
            AlignItems: ContentWidth < 540 ? AlignItems.Stretch: AlignItems.Center,
            Gap: 12,
            Label("Page " + page.ToString() + " of " + last.ToString() + "  ·  " + summary, 17),
            buttons,
        }
        buttons.FlexGrow = ContentWidth < 540 ? 0: 1
        return pager
    }
}
