package Tokate

import System
import System.Collections.Generic
import System.IO

internal class CodexEvidence {
    shared {
        internal func CompletedUsage(directory string, output string) Dictionary[string, Object?] {
            var completed bool
            var completions int32
            let usage = Dictionary[string, Object?]()
            let events = output.AsSpan()
            for bounds in events.Split('\n') {
                let line = events[bounds]
                if line.IsWhiteSpace() {
                    continue
                }
                let item = J.Parse(line.ToString())
                if J.Text(item, "type") == "turn.started" {
                    completed = false
                }
                if J.Text(item, "type") == "turn.failed" {
                    throw CliFailure("inference_failed", "Codex reported a failed turn")
                }
                if J.Text(item, "type") == "turn.completed" {
                    completed = true
                    completions++
                    for field in J.Get(item, "usage").EnumerateObject() {
                        usage[field.Name] = field.Value.Clone()
                    }
                }
            }
            let report = File.ReadAllText(Path.Combine(directory, "report.md"))
            if !completed || completions != 1 || String.IsNullOrWhiteSpace(report) {
                throw CliFailure("inference_failed", "Codex did not produce a completed turn and report")
            }
            return usage
        }
    }
}
