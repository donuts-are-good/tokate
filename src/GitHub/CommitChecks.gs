package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class CommitChecks {
    shared {
        internal func Read(repo string, head string, observed List[Object]? = nil) JsonElement {
            let rows = observed ?? List[Object]()
            let prefix = "repos/" + repo + "/commits/" + head
            for kind in[]string{"check-runs", "status"} {
                var page int32 = 1
                var inspected int32
                while page <= 10 {
                    let response = GitHub.Api(prefix + "/" + kind + "?per_page=100&page=" + page.ToString())
                    if kind == "status" && J.Get(response, "sha").ValueKind != JsonValueKind.Undefined && J.Text(
                        response,
                        "sha"
                    ) != head {
                        throw Exception("Commit status belongs to a different head")
                    }
                    let items = J.Get(response, kind == "check-runs" ? "check_runs": "statuses")
                    if items.ValueKind != JsonValueKind.Array {
                        throw Exception("Cannot read complete commit checks")
                    }
                    let count = items.GetArrayLength()
                    inspected += count
                    if count > 100 {
                        throw Exception("Cannot read complete commit checks")
                    }
                    if kind == "check-runs" {
                        var total int32
                        if !J.Get(response, "total_count").TryGetInt32(out total) ||
                            total < inspected ||
                            (count < 100 && total != inspected) {
                            throw Exception("Cannot read complete commit checks")
                        }
                    }
                    for check in items.EnumerateArray() {
                        if kind == "check-runs" && J.Get(check, "head_sha")
                            .ValueKind != JsonValueKind.Undefined &&
                            J.Text(check, "head_sha") != head {
                            throw Exception("Commit check belongs to a different head")
                        }
                        let state = kind == "check-runs" ? (
                            J.Text(check, "status") == "completed" ?
                            J.Text(check, "conclusion"): J.Text(check, "status")
                        ): J.Text(check, "state")
                        var bucket = "pending"
                        if state == "success" {
                            bucket = "pass"
                        } else if state == "failure" ||
                            state == "error" ||
                            state == "timed_out" ||
                            state == "action_required" ||
                            state == "startup_failure" {
                            bucket = "fail"
                        } else if state == "cancelled" {
                            bucket = "cancel"
                        } else if state == "skipped" || state == "neutral" {
                            bucket = "skipping"
                        }
                        rows.Add(
                            J.Map(
                                "name",
                                J.Text(check, kind == "check-runs" ? "name": "context"),
                                "state",
                                state.ToUpperInvariant(),
                                "bucket",
                                bucket,
                                "link",
                                J.Text(check, kind == "check-runs" ? "html_url": "target_url"),
                                "workflow",
                                ""
                            )
                        )
                    }
                    if count < 100 {
                        break
                    }
                    if page == 10 {
                        throw Exception("Commit check inspection exceeded its bounded history")
                    }
                    page++
                }
            }
            return J.Parse(J.Write(rows))
        }
    }
}
