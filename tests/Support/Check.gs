package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Json.Nodes

internal class Check {
    shared {
        internal func Hash(path string) string -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
            .ToLowerInvariant()

        internal func TextHash(text string) string -> Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))
            .ToLowerInvariant()

        // For constructing legacy/corrupt authority fixtures, never for validating a CLI result.
        internal func FixtureDigest(value JsonNode) string -> TextHash(Ordered(value)?.ToJsonString() ?? "null")

        private func Ordered(value JsonNode?) JsonNode? {
            if value is JsonObject fields {
                let sorted = SortedDictionary[string, JsonNode?](StringComparer.Ordinal)
                for field in fields {
                    sorted.Add(field.Key, Ordered(field.Value))
                }
                let result = JsonObject()
                for field in sorted {
                    result.Add(field.Key, field.Value)
                }
                return result
            }
            if value is JsonArray items {
                let result = JsonArray()
                for item in items {
                    result.Add(Ordered(item))
                }
                return result
            }
            return value?.DeepClone()
        }

        internal func Envelope(result Result, command string, status string, error string = "") JsonNode {
            let value = Check.Json(result.Output)
            Check.That(value.AsObject().Count == 8, "Unexpected public envelope fields")
            Check.That(Check.Text(value["schema_version"]) == "1", "Missing output schema version")
            Check.That(Check.Text(value["command"]) == command, "Wrong result command")
            Check.That(Check.Text(value["status"]) == status, "Wrong result status")
            Check.That(Check.Text(value["exit_code"]) == result.Code.ToString(), "Envelope exit differs from process")
            Check.That(Encoding.UTF8.GetByteCount(result.Output) <= 65536, "Unbounded public output")
            Check.That(!result.Output.Contains('\u001b'), "JSON contains terminal styling")
            Check.That(
                Check.Text(value["error"]?["code"]) == error,
                "Wrong stable error identifier: expected " + error + ", got " + Check.Text(value["error"]?["code"]) +
                    "\n" +
                    result.Output +
                    result.Error
            )
            return value
        }

        internal func That(value bool, message string) {
            if !value {
                throw Exception(message)
            }
        }

        internal func Contains(text string, expected string) -> That(
            text.Contains(expected),
            "Missing: " + expected + "\n" + text
        )

        internal func Json(text string) JsonNode -> JsonNode.Parse(text) ?? throw Exception("Missing JSON")

        internal func Text(value JsonNode?) string -> value?.ToString() ?? ""

        internal func Map(values ...Object?) JsonNode {
            let result = JsonObject()
            for i in 0 ... values.Length / 2 {
                let key = values[i * 2]?.ToString() ?? ""
                switch values[i * 2 + 1] {
                    case text is string {
                        result[key] = JsonValue.Create(text)
                    }
                    case flag is bool {
                        result[key] = JsonValue.Create(flag)
                    }
                    case number is int32 {
                        result[key] = JsonValue.Create(number)
                    }
                    case node is JsonNode {
                        result[key] = node.DeepClone()
                    }
                    case nil {
                        result[key] = nil
                    }
                    default {
                        throw Exception("Unsupported fixture JSON value")
                    }
                }
            }
            return result
        }

        internal func Success(result Result) string {
            That(result.Code == 0, result.Output + result.Error)
            return result.Output.Trim()
        }

        internal func PostedRequest(state JsonNode) JsonNode -> Json(
            Text(state["posted_request"]?["body"]).Substring(8)
        )
    }
}
