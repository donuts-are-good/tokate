package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.Text.Json

class IssuePage {
    shared {
        let Size int32 = 8

        func ApprovedIssue(issue JsonElement) bool {
            for label in Items(Field(issue, "labels")) {
                if TextOf(label, "name") == "tokate:approved" {
                    return true
                }
            }
            return false
        }
    }
    var Query string = ""
    var AppliedQuery string = ""
    var Filter string = "all"
    var Page int32 = 1
    var Total int32
    var Loaded bool
    var Incomplete bool
    let Rows List[JsonElement] = List[JsonElement]()
}

class IssueBrowser {
    private let app DesktopSession

    init(session DesktopSession) {
        app = session
    }

    func FindIssues(repo string, state IssuePage, page int32 = 1, search bool = false) {
        if search {
            if state.Query.Length > 200 {
                app.Message = "Keep the search under 200 characters."
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
            "per_page=" + IssuePage.Size.ToString(),
            "-f",
            "page=" + page.ToString(),
        }
        state.Rows.Clear()
        state.Loaded = true
        app.ActionName = "Search issues"
        app.Execute(
            args,
            result -> {
                state.Loaded = true
                state.Page = page
                if numbered && result.ExitCode != 0 {
                    state.Total = 0
                    app.Error(result)
                    return
                }
                if app.Error(result) {
                    return
                }
                let rows = numbered ? List[JsonElement]{result.Value}: Items(Field(result.Value, "items"))
                for item in rows {
                    if state.Rows.Count == IssuePage.Size {
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
                    let approved = IssuePage.ApprovedIssue(item)
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
}
