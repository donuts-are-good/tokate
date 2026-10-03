package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class RequestData {
    shared {
        internal func Parse(text string, limit int32 = 8192) JsonElement {
            if Encoding.UTF8.GetByteCount(text) > limit {
                throw Exception("Coordination data exceeds its byte limit")
            }
            using let document = JsonDocument.Parse(text, JsonDocumentOptions{MaxDepth: 32})
            let value = document.RootElement.Clone()
            Unique(value)
            return value
        }

        internal func FileData(path string, limit int32) JsonElement {
            using let file = File.OpenRead(path)
            using let bytes = MemoryStream()
            let buffer = [8192]byte
            var count int32
            while (
                count = file.Read(buffer, 0, Math.Min(buffer.Length, limit + 1 - Convert.ToInt32(bytes.Length)))
            ) > 0 {
                bytes.Write(buffer, 0, count)
                if bytes.Length > limit {
                    throw Exception("Coordination data exceeds its byte limit")
                }
            }
            return Parse(Encoding.UTF8.GetString(bytes.ToArray()), limit)
        }

        private func Unique(value JsonElement) {
            if value.ValueKind == JsonValueKind.Object {
                let names = HashSet[string](StringComparer.Ordinal)
                for field in value.EnumerateObject() {
                    if !names.Add(field.Name) {
                        throw Exception("Duplicate JSON key")
                    }
                    Unique(field.Value)
                }
            } else if value.ValueKind == JsonValueKind.Array {
                for item in value.EnumerateArray() {
                    Unique(item)
                }
            }
        }

        internal func Keys(value JsonElement, names string) {
            if value.ValueKind != JsonValueKind.Object {
                throw Exception("Expected one strict JSON object")
            }
            let allowed = HashSet[string](names.Split(','), StringComparer.Ordinal)
            for field in value.EnumerateObject() {
                if field.Name == "" || !allowed.Contains(field.Name) {
                    throw Exception("Unknown or authority-granting request field")
                }
            }
        }

        internal func Canonical(value JsonElement) string {
            if value.ValueKind == JsonValueKind.Object {
                let sorted = SortedDictionary[string, JsonElement](StringComparer.Ordinal)
                for field in value.EnumerateObject() {
                    sorted.Add(field.Name, field.Value)
                }
                let fields = List[string]()
                for field in sorted {
                    fields.Add(J.Write(field.Key) + ":" + Canonical(field.Value))
                }
                return "{" + String.Join(",", fields) + "}"
            }
            if value.ValueKind == JsonValueKind.Array {
                let items = List[string]()
                for item in value.EnumerateArray() {
                    items.Add(Canonical(item))
                }
                return "[" + String.Join(",", items) + "]"
            }
            if value.ValueKind == JsonValueKind.String {
                return J.Write(value.GetString() ?? "")
            }
            if value.ValueKind == JsonValueKind.Number {
                var integer int64
                if !value.TryGetInt64(out integer) {
                    throw Exception("Only integer metadata is supported")
                }
                return integer.ToString(System.Globalization.CultureInfo.InvariantCulture)
            }
            return value.GetRawText()
        }

        internal func Token(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
                throw Exception("Invalid tool identifier")
            }
            return value
        }

        internal func Tools(value JsonElement) {
            let items = J.Items(value)
            if value.ValueKind != JsonValueKind.Array || items.Count < 1 || items.Count > 16 {
                throw Exception("Declare 1 to 16 tools, including every tool used")
            }
            for tool in items {
                Keys(tool, "harness,provider,model,effort,usage,coding_seconds")
                for name in[]string{"harness", "provider", "model", "effort"} {
                    Token(J.Text(tool, name))
                }
                for name in[]string{"coding_seconds"} {
                    let number = J.Get(tool, name)
                    var count int64
                    if number.ValueKind != JsonValueKind.Undefined &&
                        number.ValueKind != JsonValueKind.Null &&
                        (!number.TryGetInt64(out count) || count < 0 || count > 86400 * 365) {
                        throw Exception("Invalid donor-reported coding time")
                    }
                }
                let usage = J.Get(tool, "usage")
                if usage.ValueKind != JsonValueKind.Undefined && usage.ValueKind != JsonValueKind.Null {
                    Keys(usage, "input_tokens,cached_input_tokens,output_tokens")
                    for field in usage.EnumerateObject() {
                        var count int64
                        if !field.Value.TryGetInt64(out count) || count < 0 {
                            throw Exception("Usage must be a nonnegative donor-reported count")
                        }
                    }
                }
            }
        }

        internal func Correction(value JsonElement, head string, policy JsonElement) {
            Keys(value, "uuid,head,tree,patch_sha256,seconds,tools,verification")
            if System.Text.Encoding.UTF8.GetByteCount(Canonical(value)) > 6144 {
                throw Exception("Correction provenance exceeds its byte limit")
            }
            var uuid Guid
            if !Guid.TryParseExact(J.Text(value, "uuid"), "D", out uuid) || uuid.ToString("D") != J.Text(
                value,
                "uuid"
            ) ||
                J.Text(value, "head") != head || !Regex.IsMatch(J.Text(value, "patch_sha256"), "^[0-9a-f]{64}$") ||
                J.Number(value, "seconds") < 1 || J.Number(value, "seconds") > 86400 || J.Text(
                value,
                "verification"
            ) != "tokate-observed-locally-exact-commit" {
                throw Exception("Invalid bounded correction provenance")
            }
            Data.CommitSha(head)
            Data.CommitSha(J.Text(value, "tree"))
            let tools = J.Get(value, "tools")
            if tools.ValueKind != JsonValueKind.Array {
                throw Exception("Correction tools must be an array; [] declares manual editing")
            }
            if J.Items(tools).Count > 0 {
                Tools(tools)
            }
            if policy.ValueKind != JsonValueKind.Undefined {
                if J.Number(value, "seconds") > J.Number(policy, "max_seconds") {
                    throw Exception("Correction budget exceeds original owner policy")
                }
                Tokate.Correction.ToolsFromValue(tools, policy)
            }
        }

        internal func Request(value JsonElement) {
            Keys(value, "uuid,expected,approval,action,metadata")
            var uuid Guid
            if !Guid.TryParseExact(J.Text(value, "uuid"), "D", out uuid) || uuid.ToString("D") != J.Text(
                value,
                "uuid"
            ) ||
                !Regex
                .IsMatch(J.Text(value, "approval"), "^[0-9a-f]{64}$") {
                throw Exception("Request needs a canonical UUID and approval identity")
            }
            Data.CommitSha(J.Text(value, "expected"))
            let metadata = J.Get(value, "metadata")
            if J.Text(value, "action") == "claim" {
                Keys(metadata, "")
            } else if J.Text(value, "action") == "publish" {
                Keys(metadata, "fork,branch,head,source,tools,verification,correction")
                Data.Repo(J.Text(metadata, "fork"))
                Data.CommitSha(J.Text(metadata, "head"))
                if !Regex.IsMatch(J.Text(metadata, "branch"), "^tokate/v2-[0-9a-f-]{36}$") ||
                    (J.Text(metadata, "source") != "external" && J.Text(metadata, "source") != "tokate") ||
                    J.Text(metadata, "verification") != "donor-reported-pass" {
                    throw Exception("Invalid contribution declaration")
                }
                Tools(J.Get(metadata, "tools"))
                let correction = J.Get(metadata, "correction")
                if correction.ValueKind != JsonValueKind.Undefined {
                    if J.Text(metadata, "source") != "tokate" {
                        throw Exception("Correction provenance requires managed original work")
                    }
                    Correction(correction, J.Text(metadata, "head"), JsonElement{})
                }
            } else if J.Text(value, "action") == "amend" {
                Keys(metadata, "fork,branch,previous,head,pr,seconds,tools,verification,sync")
                Data.Repo(J.Text(metadata, "fork"))
                Data.CommitSha(J.Text(metadata, "head"))
                Data.CommitSha(J.Text(metadata, "previous"))
                if J.Get(metadata, "sync").ValueKind != JsonValueKind.Undefined {
                    Data.CommitSha(J.Text(metadata, "sync"))
                }
                if !Regex.IsMatch(J.Text(metadata, "branch"), "^tokate/v2-[0-9a-f-]{36}$") || J.Number(
                    metadata,
                    "pr"
                ) < 1 ||
                    J.Number(metadata, "seconds") < 1 || J.Text(metadata, "verification") != "donor-reported-pass" {
                    throw Exception("Invalid amendment declaration")
                }
                let tools = J.Get(metadata, "tools")
                if tools.ValueKind != JsonValueKind.Array {
                    throw Exception("Amendment tools must be an array")
                }
                if J.Items(tools).Count > 0 {
                    Tools(tools)
                }
            } else {
                throw Exception("Only claim, publish and amend are donor request operations")
            }
        }
    }
}
