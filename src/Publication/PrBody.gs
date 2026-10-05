package Tokate

import System
import System.Collections.Generic
import System.Text.Json
import System.Text.RegularExpressions

internal class PrBody {
    shared {
        internal func Render(template string, values Dictionary[string, string]) string ->
        Regex.Replace(template, "\\{\\{([a-z_]+)\\}\\}", (match Match) -> values[match.Groups[1].Value])

        internal func OriginalReport(metadata JsonElement) string {
            var report = "Donor-declared contribution source: " + J.Text(metadata, "source") +
                ". The coordinator did not observe coding execution. Local verification pass is donor-reported to the coordinator. Owner CI and review must validate this exact commit."
            let correction = J.Get(metadata, "correction")
            if correction.ValueKind != JsonValueKind.Undefined {
                let tools = J.Get(correction, "tools")
                let editing = J.Items(tools).Count == 0 ? "manual/unknown editing": "donor-reported tools " + J.Write(
                    tools
                )
                let seconds = J.Number(correction, "seconds").ToString()
                report += " Explicit correction " + J.Text(correction, "uuid") +
                    ": " +
                    editing +
                    ". Original source/tools, model and usage declarations describe the original completed turn only. Correction editing is separate. " +
                    "Exact-commit local verification is reported by the donor; the coordinator did not observe it. Separate verification budget: " +
                    seconds +
                    " seconds."
            }
            return report
        }

        internal func VerificationReport(run Data, record JsonElement) string {
            let count = Verification.Results(run, record)
            let recovery = run.Flag(
                "recovered"
            ) ? "The original run failed independent verification. Explicit verification-only recovery passed all original checks without new inference. Original total runtime was not recorded.\n\n": ""
            return recovery +
                "Generated a patch for the approved issue. Independent owner verification: " +
                count.ToString() + "/" + count.ToString() +
                " checks passed.\n\nReview the changes against the issue's acceptance criteria and limitations."
        }

        internal func ManagedReport(run Data, record JsonElement) string {
            let count = Verification.Results(run, record)
            return PublicSummary.Report(
                PublicSummary.ForHead(run, run.Text("commit")),
                "Tokate observed locally: " + count.ToString() + "/" + count.ToString() +
                    " checks passed on this candidate."
            ) +
                (
                run.Flag("recovered") ?
                "\n- Recovery: original verification failed; verification-only recovery passed without new inference.": ""
            )
        }

        internal func CoordinatedReport(metadata JsonElement) string {
            let summary = J.Get(metadata, "summary")
            if summary.ValueKind != JsonValueKind.Undefined {
                PublicSummary.Validate(summary, J.Text(metadata, "head"))
            }
            var report = PublicSummary.Report(
                summary,
                "Donor-reported: original owner checks passed locally on this candidate; coordinator did not observe execution."
            )
            return report + OriginalProvenance(metadata)
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
            return report
        }

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

        internal func ReportText(body string, legacy string) string {
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            if !body.Contains(prefix) {
                Unique(body, legacy)
                return legacy
            }
            let start = Unique(body, prefix) + prefix.Length
            let end = Unique(body, suffix)
            if end < start {
                throw Exception("Malformed Tokate report region")
            }
            return body.Substring(start, end - start).Trim()
        }

        internal func Owned(body string, legacy string) string -> ReportText(body, legacy) +
            "\n" +
            RequestData.Canonical(Receipt(body))

        internal func ReplaceBody(body string, oldReport string, report string, receipt JsonElement) string {
            let prefix = "<!-- tokate-report:start -->"
            let suffix = "<!-- tokate-report:end -->"
            var start int32
            var length int32
            if body.Contains(prefix) {
                start = Unique(body, prefix)
                let end = Unique(body, suffix)
                if end <= start {
                    throw Exception("Malformed Tokate report region")
                }
                length = end + suffix.Length - start
            } else {
                start = Unique(body, oldReport)
                length = oldReport.Length
            }
            let updated = body.Remove(start, length).Insert(start, Report(report))
            start = Unique(updated, "<!-- tokate-receipt:")
            let end = updated.IndexOf(" -->", start, StringComparison.Ordinal)
            if end < 0 {
                throw Exception("Malformed Tokate receipt")
            }
            return updated.Remove(start, end + 4 - start).Insert(
                start,
                "<!-- tokate-receipt:" + J.Write(receipt) + " -->"
            )
        }
    }
}
