package TokateDesktop

import System
import System.Collections.Generic
import System.Text.Json

func Field(value JsonElement, key string) JsonElement {
    var result JsonElement
    if value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out result) {
        return result
    }
    return JsonElement{}
}

func TextOf(value JsonElement, key string) string {
    let item = Field(value, key)
    if item.ValueKind == JsonValueKind.String {
        return item.GetString() ?? ""
    }
    return item.ValueKind == JsonValueKind.Number ? item.ToString(): ""
}

func Number(value JsonElement, key string) int32 {
    let item = Field(value, key)
    var number int32
    return item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out number) ? number: 0
}

func Items(value JsonElement) List[JsonElement] {
    let result = List[JsonElement]()
    if value.ValueKind == JsonValueKind.Array {
        for item in value.EnumerateArray() {
            result.Add(item)
        }
    }
    return result
}

func Repository(value string) string {
    let trimmed = value.Trim().TrimEnd('/')
    let repo = trimmed.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase) ? trimmed.Substring(
        19
    ): trimmed
    let parts = repo.Split('/')
    if parts.Length != 2 && !(parts.Length == 4 && parts[2] == "issues") {
        throw Exception("Enter owner/repository or a GitHub issue URL.")
    }
    for part in[]string{parts[0], parts[1]} {
        if part.Length == 0 || part.StartsWith("-") || part == "." || part == ".." {
            throw Exception("Enter a valid GitHub repository.")
        }
        for c in part {
            if !Char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_' && c != '.' {
                throw Exception("Enter a valid GitHub repository.")
            }
        }
    }
    return parts[0] + "/" + parts[1]
}
