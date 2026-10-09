package Tokate

import System
import System.Collections.Generic
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class PrBody {
    shared {
        internal func ValidateTemplate(text string) {
            for key in[]string{
                "issue",
                "report",
                "donor",
                "model",
                "effort",
                "seconds",
                "base",
                "policy",
                "usage",
                "receipt"
            } {
                if !text.Contains("{{" + key + "}}") {
                    throw Exception("PR template must contain {{" + key + "}}")
                }
            }
        }

        internal func Template(repo string, revision string, policy Policy) string {
            let custom = GitHub.Api(
                "repos/" + repo + "/contents/.github/tokate-pr.md?ref=" + Uri.EscapeDataString(revision),
                missing: true
            )
            var text = ApplicationInfo.Resource("tokate-pr.md")
            if custom.ValueKind != JsonValueKind.Undefined {
                if J.Text(custom, "encoding") != "base64" {
                    throw Exception("Expected a small repository PR template")
                }
                text = Encoding.UTF8.GetString(Convert.FromBase64String(J.Text(custom, "content")))
                ValidateTemplate(text)
            }
            return text + (J.Text(policy.Value, "pr_text") == "" ? "": "\n\n{{pr_text}}\n")
        }

        internal func Render(template string, values Dictionary[string, string], policy JsonElement) string {
            values["pr_text"] = J.Text(policy, "pr_text")
            return Regex.Replace(template, "\\{\\{([a-z_]+)\\}\\}", (match Match) -> values[match.Groups[1].Value])
        }

        internal func CoordinatedReport(metadata JsonElement) string {
            let summary = J.Get(metadata, "summary")
            if summary.ValueKind != JsonValueKind.Undefined {
                PublicSummary.Validate(summary, J.Text(metadata, "head"))
            }
            return PublicSummary.Report(
                summary,
                RequestData.Incomplete(
                    metadata
                ) ? "Incomplete draft: independent owner verification has not passed. This work is not ready for acceptance.": "Donor-reported: original owner checks passed locally on this candidate; coordinator did not observe execution."
            ) +
                OriginalProvenance(metadata)
        }

        internal func OriginalProvenance(metadata JsonElement) string {
            var report = "\n\n- Original source: " +
                (J.Text(metadata, "source") == "tokate" ? "managed Tokate": "external") +
                "; coding execution and usage are donor-reported to the coordinator." +
                PublicSummary.Tools(J.Get(metadata, "tools"), "Original donor-reported tools")
            let correction = J.Get(metadata, "correction")
            if correction.ValueKind != JsonValueKind.Undefined {
                report += "\n\n- Correction: separate " + J.Number(correction, "seconds").ToString() +
                    " second verification budget; original declarations cover only the original completed turn." +
                    PublicSummary.Tools(J.Get(correction, "tools"), "Donor-reported correction tools")
            }
            let prior = J.Get(metadata, "predecessor")
            return report + (prior.ValueKind == JsonValueKind.Undefined ? "": "\n\n" + ContinuationReport(prior).Trim())
        }

        internal func ContinuationReport(
            prior JsonElement
        ) string -> "Fresh attempt seeded from unpublished interrupted attempt " +
            J.Text(prior, "attempt") + " under predecessor approval " + J.Text(prior, "approval") +
            ". Preserved origin state: " +
            J.Text(prior, "state") + "; failure: " + J.Text(prior, "failure_reason") +
            ". Prior donor-reported tool: " +
            J.Text(prior, "harness") + "/" + J.Text(prior, "provider") + ", " + J.Text(prior, "model") + " / " + J.Text(
            prior,
            "effort"
        ) +
            ". The predecessor is not retroactively successful. Missing prior usage, reports and verification are not reconstructed. Usage and checks below describe the new attempt; all checks cover the complete final diff from the original approved base.\n\n"

        internal func Receipt(body string) JsonElement -> RequestData.Parse(ReceiptText(body))

        internal func ReceiptText(
            body string,
            ambiguity string = "Missing or ambiguous Tokate-owned report/receipt region",
            malformed string = "Malformed Tokate receipt"
        ) string {
            let prefix = "<!-- tokate-receipt:"
            let start = Unique(body, prefix, ambiguity)
            let end = body.IndexOf(" -->", start, StringComparison.Ordinal)
            if end < 0 {
                throw Exception(malformed)
            }
            return body.Substring(start + prefix.Length, end - start - prefix.Length)
        }

        private func Unique(
            body string,
            value string,
            failure string = "Missing or ambiguous Tokate-owned report/receipt region"
        ) int32 {
            let start = body.IndexOf(value, StringComparison.Ordinal)
            if start < 0 || body.IndexOf(value, start + value.Length, StringComparison.Ordinal) >= 0 {
                throw Exception(failure)
            }
            return start
        }

        internal func Report(text string) string -> "<!-- tokate-report:start -->\n" +
            text +
            "\n<!-- tokate-report:end -->"

        internal func ReportText(body string) string {
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            let start = Unique(body, prefix) + prefix.Length
            let end = Unique(body, suffix)
            if end < start {
                throw Exception("Malformed Tokate report region")
            }
            return body.Substring(start, end - start).Trim()
        }

        internal func Owned(body string) string -> ReportText(body) + "\n" + RequestData.Canonical(Receipt(body))

        internal func ReplaceBody(body string, report string, receipt JsonElement) string {
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            let start = Unique(body, prefix)
            let end = Unique(body, suffix)
            if end <= start {
                throw Exception("Malformed Tokate report region")
            }
            let length = end + suffix.Length - start
            let updated = body.Remove(start, length).Insert(start, Report(report))
            let receiptStart = Unique(updated, "<!-- tokate-receipt:")
            let receiptEnd = updated.IndexOf(" -->", receiptStart, StringComparison.Ordinal)
            if receiptEnd < 0 {
                throw Exception("Malformed Tokate receipt")
            }
            return updated.Remove(receiptStart, receiptEnd + 4 - receiptStart).Insert(
                receiptStart,
                "<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            )
        }
    }
}
