package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.Text.Json

class IssuePage {
    var Query string = ""
    var AppliedQuery string = ""
    var Filter string = "all"
    var Page int32 = 1
    var Total int32
    var Loaded bool
    var Incomplete bool
    let Rows List[JsonElement] = List[JsonElement]()
}

partial class Desktop {
    private let PageSize int32 = 8

    private func ApprovedIssue(issue JsonElement) bool {
        for label in Items(Field(issue, "labels")) {
            if TextOf(label, "name") == "tokate:approved" {
                return true
            }
        }
        return false
    }

    private func FindIssues(repo string, state IssuePage, page int32 = 1, search bool = false) {
        if search {
            if state.Query.Length > 200 {
                message = "Keep the search under 200 characters."
                return
            }
            state.AppliedQuery = state.Query.Trim()
        }
        let value = state.AppliedQuery.TrimStart('#')
        let numbered = int32.TryParse(value, out var number) && number > 0
        let query = List[string]{"repo:" + repo, "is:issue", "is:open"}
        if state.Filter != "all" {
            query.Add((state.Filter == "approved" ? "": "-") + "label:tokate:approved")
        }
        if state.AppliedQuery != "" && !numbered {
            query.Add("in:title")
            for term in state.AppliedQuery.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries) {
                let word = term.Replace("\"", "").Replace("\\", "")
                if word != "" {
                    query.Add("\"" + word + "\"")
                }
            }
        }
        let args = numbered ? []string{"api", "repos/" + repo + "/issues/" + number.ToString()}: []string{
            "api",
            "search/issues",
            "--method",
            "GET",
            "-f",
            "q=" + String.Join(" ", query),
            "-f",
            "sort=updated",
            "-f",
            "order=desc",
            "-f",
            "per_page=" + PageSize.ToString(),
            "-f",
            "page=" + page.ToString(),
        }
        state.Rows.Clear()
        state.Loaded = true
        activityAction = "Search issues"
        Execute(
            args,
            result -> {
                state.Loaded = true
                state.Page = page
                if numbered && result.ExitCode != 0 {
                    state.Total = 0
                    Error(result)
                    return
                }
                if Error(result) {
                    return
                }
                let rows = numbered ? List[JsonElement]{result.Value}: Items(Field(result.Value, "items"))
                for item in rows {
                    if state.Rows.Count == PageSize {
                        break
                    }
                    if TextOf(item, "state") != "open" || Field(
                        item,
                        "pull_request"
                    ).ValueKind != JsonValueKind.Undefined {
                        continue
                    }
                    let url = TextOf(item, "html_url")
                    if !url.StartsWith("https://github.com/" + repo + "/issues/", StringComparison.OrdinalIgnoreCase) {
                        continue
                    }
                    let approved = ApprovedIssue(item)
                    if (state.Filter == "approved" && !approved) || (state.Filter == "unapproved" && approved) {
                        continue
                    }
                    state.Rows.Add(item)
                }
                state.Total = numbered ? state.Rows.Count: Number(result.Value, "total_count")
                state.Incomplete = Field(result.Value, "incomplete_results").ValueKind == JsonValueKind.True
            },
            "gh"
        )
    }

    private func IssueSearch(state IssuePage, search Action, owner bool = false) Blob {
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

    private func TablePanel() Container {
        let panel = DonatePanel()
        panel.Padding = 8
        panel.Gap = 0
        panel.FlexGrow = 1
        panel.FlexShrink = 1
        panel.FlexBasis = 0
        panel.MinHeight = 0
        panel.OverflowY = Overflow.Scroll
        return panel
    }

    private func IssueRows(state IssuePage, choose Action[JsonElement]) Blob {
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
                        Disabled: busy,
                        Accessibility: Accessibility{
                            Role: AccessibilityRole.Button,
                            Name: "Issue #" + number + ": " + title
                        },
                        OnClick: () -> choose(selected),
                        Container{Width: 65, FlexShrink: 0, Label("#" + number, 18, true)},
                        Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, caption},
                        Label(ApprovedIssue(issue) ? "Approved": "Open", 16, true),
                    }
                )
            )
        }
        if state.Loaded && state.Rows.Count == 0 && !busy {
            panel.Children.Add(Label("No matching issues", 24))
        }
        return panel
    }

    private func IssuePagination(state IssuePage, change Action[int32]) Blob ->
    PageNavigation(state.Page, Math.Min(1000, state.Total), state.Total.ToString() + " issues", change)

    private func PageNavigation(page int32, total int32, summary string, change Action[int32]) Blob {
        let last = Math.Max(1, (total + PageSize - 1) / PageSize)
        let pager = Row(
            []Blob{
                Label("Page " + page.ToString() + " of " + last.ToString() + "  ·  " + summary, 17),
                Container{FlexGrow: 1},
                Action("Previous page", () -> change(page - 1), disabled: page <= 1),
                Action("Next page", () -> change(page + 1), disabled: page >= last),
            }
        )
        pager.FlexWrap = FlexWrap.NoWrap
        return pager
    }
}
