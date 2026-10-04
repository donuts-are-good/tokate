package TokateTests

import System
import System.Text.Json.Nodes

internal class Check {
    shared {
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
