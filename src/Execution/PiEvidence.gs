package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class PiEvidence {
    shared {
        internal func Failure(output string) string {
            try {
                let lines = output.Trim().Split('\n')
                let item = RequestData.Parse(lines[lines.Length - 1], 1024)
                if J.Text(item, "type") == "pi.failed" {
                    if J.Text(item, "reason") == "length" {
                        return "Pi response reached its length limit; inspect the model settings in Pi and the private evidence. No retry or fallback"
                    }
                    if J.Text(item, "reason") == "compaction" {
                        return "Pi context compaction failed; inspect private captured evidence. No retry or fallback"
                    }
                }
            } catch (error Exception) { }
            return "Pi did not complete; inspect private captured evidence. No retry or fallback"
        }

        internal func Completed(directory string, output string, model string) Dictionary[string, Object?] {
            var completed int32
            var started int32
            var report = ""
            let usage = J.Map()
            for line in output.Split('\n') {
                if String.IsNullOrWhiteSpace(line) {
                    continue
                }
                let item = RequestData.Parse(line, 4 * 1024 * 1024)
                let kind = J.Text(item, "type")
                if kind == "pi.started" && completed == 0 {
                    started++
                    if J.Text(item, "model") != model || J.Text(item, "provider") != "local-chat-completions" || J.Text(
                        item,
                        "effort"
                    ) != "absent" {
                        throw Exception("Pi invocation identity differs from exact selection")
                    }
                } else if kind == "pi.completed" && started == 1 {
                    completed++
                    if J.Text(item, "model") != model || J.Text(item, "stop_reason") != "stop" {
                        throw Exception("Pi reported a failed or incomplete response")
                    }
                    report = J.Text(item, "report")
                    let reported = J.Get(item, "usage")
                    RequestData.Keys(reported, "input_tokens,cached_input_tokens,output_tokens")
                    for field in reported.EnumerateObject() {
                        var count int64
                        if !field.Value.TryGetInt64(out count) || count < 0 {
                            throw Exception("Invalid harness-reported pi usage")
                        }
                        usage[field.Name] = count
                    }
                } else if kind != "pi.event" || started != 1 || completed != 0 {
                    throw Exception("Malformed or failed pi completion evidence")
                }
            }
            if started != 1 || completed != 1 || String.IsNullOrWhiteSpace(report) {
                throw Exception("Pi did not return exactly one completed turn and report")
            }
            File.WriteAllText(Path.Combine(directory, "report.md"), report)
            return usage
        }
    }
}
