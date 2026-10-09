package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class PublicSummary {
    shared {
        internal let Artifact string = "tokate-public-summary.json"
        private let Unavailable string = "Change summary unavailable for this candidate; review the diff."
        private let Section string = "\nVerification:\n"
        private let CiNote string = "- GitHub CI: not assessed here; missing or pending checks are not success."
        private let Missing string = "PR report has no change summary for this candidate. Supply a current public summary and republish."
        private let Incomplete string = "PR report omits the public change or verification report region. Restore the Tokate report before acceptance."
        private let Altered string = "PR report differs from the authoritative public summary for this exact candidate. Restore it or amend with a current summary."

        internal func Validate(value JsonElement, head string = "") {
            let limit = J.Get(value, "head").ValueKind == JsonValueKind.Undefined ? 4046: 4096
            RequestData.Parse(J.Write(value), limit)
            RequestData.Keys(value, "head,changes,verification,limitations")
            if head != "" && J.Text(value, "head") != head {
                throw Exception("Public summary does not describe the current candidate")
            }
            if J.Get(value, "head").ValueKind != JsonValueKind.Undefined {
                RepositoryIdentity.CommitSha(J.Text(value, "head"))
            }
            for key in[]string{"changes", "verification", "limitations"} {
                let list = J.Get(value, key)
                if list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > (key == "limitations" ? 4: 8) ||
                    (key == "changes" && list.GetArrayLength() == 0) {
                    throw Exception("Public summary needs bounded changes, verification and limitations lists")
                }
                for item in list.EnumerateArray() {
                    if item.ValueKind != JsonValueKind.String || !Safe(item.GetString() ?? "") {
                        throw Exception("Public summary contains invalid public text")
                    }
                }
            }
        }

        private func Safe(text string) bool -> text.Length >= 3 && text.Length <= 200 && text == text.Trim() &&
            Regex.IsMatch(text, "^[A-Za-z0-9 .,;:!?()'+_-]+$") && !Regex.IsMatch(
            text,
            "(?i)(https?:|www\\.|\\b[A-Z]:|gh[pousr]_|github_pat_|sk-|bearer|password|api[ _-]?key|credential|secret|tokate-receipt|tokate-report|localhost:|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+|[a-z]+://|generated a patch|implemented acceptance criteria)"
        )

        internal func Identifier(text string, model bool = false) string {
            if text == "" && !model {
                return "unknown"
            }
            let pattern = model ? RequestData.ModelPattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"
            if !Regex.IsMatch(text, pattern) || text.Contains("://") || Regex.IsMatch(
                text,
                "(?i)(gh[pousr]_|github_pat_|sk-|secret|password)"
            ) {
                throw Exception("Tool declaration contains an invalid public identifier")
            }
            return text
        }

        internal func FileSummary(path string, head string) JsonElement {
            if path == "" {
                return JsonElement{}
            }
            if FileInfo(path).LinkTarget != nil {
                throw Exception("Public summary must not be a symbolic link")
            }
            let size = FileInfo(path).Length
            if size < 1 || size > 4096 {
                throw Exception("Public summary must contain 1 to 4096 bytes")
            }
            let value = RequestData.FileData(path, 4096)
            Validate(value, head)
            return value
        }

        internal func Capture(directory string, checkout string, run Data) {
            let path = Path.Combine(checkout, Artifact)
            if !File.Exists(path) && FileInfo(path).LinkTarget == nil {
                return
            }
            if Commands.Git(checkout, "ls-files", "--", Artifact) != "" {
                throw Exception("Public summary artifact conflicts with a repository-owned file")
            }
            let summary = FileSummary(path, "")
            if J.Get(summary, "head").ValueKind != JsonValueKind.Undefined {
                throw Exception("Managed public summary must omit head; Tokate binds the final patch")
            }
            run.Fields["public_summary"] = summary
            run.Fields.Remove("summary_patch_sha256")
            File.Delete(path)
            run.Save(directory)
        }

        internal func Bind(run Data, patch string) {
            let summary = J.Get(run.Element(), "public_summary")
            if summary.ValueKind == JsonValueKind.Undefined {
                return
            }
            Validate(summary)
            if run.Text("summary_patch_sha256") == "" {
                run.Fields["summary_patch_sha256"] = Data.Hash(patch)
            } else if run.Text("summary_patch_sha256") != Data.Hash(patch) {
                run.Fields.Remove("public_summary")
                run.Fields.Remove("summary_patch_sha256")
            }
        }

        internal func ForHead(run Data, head string) JsonElement {
            let summary = J.Get(run.Element(), "public_summary")
            if summary.ValueKind == JsonValueKind.Undefined {
                return summary
            }
            Validate(summary)
            if J.Text(summary, "head") != "" {
                Validate(summary, head)
                return summary
            }
            let fields = map[string, Object?]{"head": head}
            for field in summary.EnumerateObject() {
                fields[field.Name] = field.Value.Clone()
            }
            let bound = J.Parse(J.Write(fields))
            Validate(bound, head)
            return bound
        }

        internal func Attach(metadata Dictionary[string, Object?], summary JsonElement) Dictionary[string, Object?] {
            if summary.ValueKind != JsonValueKind.Undefined {
                metadata["summary"] = summary
            }
            return metadata
        }

        private func Changes(summary JsonElement) string {
            var result = ""
            for item in J.Items(J.Get(summary, "changes")) {
                result += "- " + (item.GetString() ?? "") + "\n"
            }
            return result
        }

        internal func Current(report string, summary JsonElement, head string, expected string = "") {
            if expected != "" && report != expected {
                throw CliFailure("invalid_state", Altered)
            }
            let split = report.IndexOf(Section, StringComparison.Ordinal)
            if report == "" || split < 0 || !report.Contains(CiNote) {
                throw CliFailure("invalid_state", Incomplete)
            }
            var useful bool
            for line in report.Substring(0, split).Split('\n') {
                if !line.StartsWith("- ") {
                    continue
                }
                if !Safe(line.Substring(2).Trim()) {
                    throw CliFailure("invalid_state", Incomplete)
                }
                useful = true
            }
            if !useful || report.Contains(Unavailable) {
                throw CliFailure("invalid_state", Missing)
            }
            if summary.ValueKind == JsonValueKind.Undefined {
                return
            }
            Validate(summary, head)
            if !report.Contains(Changes(summary)) {
                throw CliFailure("invalid_state", Altered)
            }
        }

        internal func Report(summary JsonElement, observed string) string {
            var result = ""
            if summary.ValueKind == JsonValueKind.Undefined {
                result = "- " + Unavailable + "\n"
            } else {
                Validate(summary)
                result = Changes(summary)
            }
            result += Section + "\n- " + observed + "\n"
            if summary.ValueKind != JsonValueKind.Undefined {
                for item in J.Items(J.Get(summary, "verification")) {
                    result += "- Donor-reported: " + (item.GetString() ?? "") + "\n"
                }
            }
            result += CiNote
            if summary.ValueKind != JsonValueKind.Undefined && J.Items(J.Get(summary, "limitations")).Count > 0 {
                result += "\n\nLimits:\n"
                for item in J.Items(J.Get(summary, "limitations")) {
                    result += "\n- " + (item.GetString() ?? "")
                }
            }
            return result
        }

        internal func Usage(value JsonElement) string {
            let counts = List[string]()
            for key in[]string{"input_tokens", "cached_input_tokens", "output_tokens"} {
                var count int64
                let item = J.Get(value, key)
                if item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out count) && count >= 0 {
                    counts.Add(key.Replace("_tokens", "").Replace('_', ' ') + ": " + count.ToString())
                }
            }
            return counts.Count == 0 ? "unknown": String.Join("; ", counts) + " tokens"
        }

        internal func Tools(tools JsonElement, label string) string {
            var result = "\n\n| " +
                label +
                " | Model / effort | Coding seconds | Reported usage |\n" +
                "| --- | --- | --- | --- |"
            if J.Items(tools).Count == 0 {
                return result + "\n| manual/unknown | unknown | unknown | unknown |"
            }
            for tool in J.Items(tools) {
                let cells = List[string]()
                for key in[]string{"harness", "provider", "model", "effort"} {
                    let token = J.Text(tool, key)
                    cells.Add(Identifier(token, model: key == "model"))
                }
                result += "\n| " +
                    cells[0] +
                    " / " +
                    cells[1] +
                    " | " +
                    cells[2] +
                    " / " +
                    cells[3] +
                    " | " +
                    (
                    J.Get(tool, "coding_seconds").ValueKind == JsonValueKind.Number ?
                    J.Number(tool, "coding_seconds").ToString(): "unknown"
                ) +
                    " | " +
                    Usage(J.Get(tool, "usage")) +
                    " |"
            }
            return result
        }
    }
}
