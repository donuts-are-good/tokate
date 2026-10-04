package Tokate

import System
import System.Text.Json

internal class PrBody {
    shared {
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
