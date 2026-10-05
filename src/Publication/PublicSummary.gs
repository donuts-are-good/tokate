package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

// Only this dedicated public artifact is read. Private reports and logs are never summary inputs.
internal class PublicSummary {
    shared {
        internal let Artifact string = "tokate-public-summary.json"

        internal func Validate(value JsonElement, head string = "") {
            RequestData.Parse(J.Write(value), 4096)
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
                    if key == "changes" && !Regex.IsMatch(
                        item.GetString() ?? "",
                        "^(Add(s|ed)?|Update(s|d)?|Remove(s|d)?|Fix(es|ed)?|Allow(s|ed)?|Prevent(s|ed)?|Preserve(s|d)?|Replace(s|d)?|Reject(s|ed)?|Show(s|ed)?|Keep(s)?|Support(s|ed)?|Make(s)?|Refresh(es|ed)?|Validate(s|d)?|Render(s|ed)?) [A-Za-z0-9]+ .+"
                    ) {
                        throw Exception("Public changes must describe concrete final behavior")
                    }
                }
            }
        }

        private func Safe(text string) bool -> text.Length >= 3 && text.Length <= 200 && text == text.Trim() &&
            Regex.IsMatch(text, "^[A-Za-z0-9 .,;:!?()'+_-]+$") && !Regex.IsMatch(
            text,
            "(?i)(https?:|www\\.|\\b[A-Z]:|gh[pousr]_|github_pat_|sk-|bearer|password|api[ _-]?key|credential|secret|tokate-receipt|tokate-report|localhost:|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+|[a-z]+://|generated a patch|implemented acceptance criteria)"
        )

        internal func Identifier(text string) string {
            if text == "" {
                return "unknown"
            }
            if !Regex.IsMatch(text, "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") || Regex.IsMatch(
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
            let fields = J.Map("head", head)
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

        internal func Report(summary JsonElement, observed string) string {
            var result = ""
            if summary.ValueKind == JsonValueKind.Undefined {
                result = "- Change summary unavailable for this candidate; review the diff.\n"
            } else {
                Validate(summary)
                for item in J.Items(J.Get(summary, "changes")) {
                    result += "- " + (item.GetString() ?? "") + "\n"
                }
            }
            result += "\nVerification:\n\n- " + observed + "\n"
            if summary.ValueKind != JsonValueKind.Undefined {
                for item in J.Items(J.Get(summary, "verification")) {
                    result += "- Donor-reported: " + (item.GetString() ?? "") + "\n"
                }
            }
            result += "- GitHub CI: not assessed here; missing or pending checks are not success."
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
                    cells.Add(Identifier(token))
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
