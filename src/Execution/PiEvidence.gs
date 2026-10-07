package Tokate

import Gsharp.Extensions.Json
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
                        return "Pi response reached its configured output length limit. Inspect private partial text and usage. This failed run cannot resume."
                    }
                    if J.Text(item, "reason") == "compaction" {
                        return "Pi context compaction failed; inspect private captured evidence. No retry or fallback"
                    }
                }
            } catch (error Exception) { }
            return "Pi did not complete; inspect private captured evidence. No retry or fallback"
        }

        internal func Completed(directory string, output string, model string, continuationLimit int32) Dictionary[
            string,
            Object?
        ] {
            var completed int32
            var started int32
            var continued int32
            var lastStop = ""
            var report = ""
            let usage = map[string, Object?]{}
            for line in output.Split('\n') {
                if String.IsNullOrWhiteSpace(line) {
                    continue
                }
                let item = RequestData.Parse(line, 4 * 1024 * 1024)
                let kind = J.Text(item, "type")
                if kind == "pi.started" && started == 0 && completed == 0 {
                    started++
                    if J.Text(item, "model") != model || J.Text(item, "provider") != "local-chat-completions" || J.Text(
                        item,
                        "effort"
                    ) != "absent" {
                        throw Exception("Pi invocation identity differs from exact selection")
                    }
                    if (item.GetInt32OrNil("length_continuation_limit") ?? -1) != continuationLimit {
                        throw Exception("Pi continuation allowance differs from donor authorization")
                    }
                } else if kind == "pi.event" && started == 1 && completed == 0 {
                    let event = J.Text(item, "event")
                    if event == "assistant_end" {
                        if lastStop == "length" {
                            throw Exception("Pi continued without explicit length authorization")
                        }
                        if J.Text(item, "model") != model || J.Text(item, "provider") != "tokate-local" {
                            throw Exception("Pi response identity differs from exact selection")
                        }
                        let responseModel = J.Get(item, "response_model")
                        if responseModel.ValueKind != JsonValueKind.Null &&
                            responseModel.ValueKind != JsonValueKind.Undefined &&
                            (responseModel.ValueKind != JsonValueKind.String || responseModel.GetString() != model) {
                            throw Exception("Pi response identity differs from exact selection")
                        }
                        lastStop = J.Text(item, "stop_reason")
                        if lastStop != "stop" && lastStop != "toolUse" && lastStop != "length" {
                            throw Exception("Pi reported a failed or incomplete response")
                        }
                        let reported = J.Get(item, "usage")
                        for key in[]string{"input", "cacheRead", "output"} {
                            let value = J.Get(reported, key)
                            var count int64
                            if value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out count) ||
                                count < 0 ||
                                count > 9007199254740991 {
                                throw Exception("Invalid harness-reported pi usage")
                            }
                        }
                    } else if event == "length_continuation" {
                        if continuationLimit != 1 ||
                            continued != 0 ||
                            lastStop != "length" ||
                            (item.GetInt32OrNil("count") ?? -1) != 1 ||
                            (item.GetInt32OrNil("limit") ?? -1) != continuationLimit {
                            throw Exception("Pi exceeded donor length continuation authorization")
                        }
                        continued++
                        lastStop = ""
                    }
                } else if kind == "pi.completed" && started == 1 && completed == 0 {
                    completed++
                    if J.Text(item, "model") != model || J.Text(item, "stop_reason") != "stop" || lastStop != "stop" {
                        throw Exception("Pi reported a failed or incomplete response")
                    }
                    if continued > continuationLimit ||
                        (item.GetInt32OrNil("length_continuations") ?? -1) != continued {
                        throw Exception("Pi continuation evidence differs from donor authorization")
                    }
                    report = J.Text(item, "report")
                    let reported = J.Get(item, "usage")
                    RequestData.Keys(reported, "input_tokens,cached_input_tokens,output_tokens")
                    for key in[]string{"input_tokens", "cached_input_tokens", "output_tokens"} {
                        let value = J.Get(reported, key)
                        var count int64
                        if value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out count) ||
                            count < 0 ||
                            count > 9007199254740991 {
                            throw Exception("Invalid harness-reported pi usage")
                        }
                        usage[key] = count
                    }
                } else {
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
