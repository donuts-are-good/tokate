package Tokate

import System
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class Policy {
    internal var Value JsonElement
    internal var Digest string = ""
    internal var ModelPolicy string = "whitelist"
    internal var Eligibility string = ""
    internal init(text string) {
        Value = J.Parse(text)
        Digest = Data.Hash(text)
        let version = J.Number(Value, "version")
        if version != 1 && version != 2 {
            throw Exception("Policy version must be 1 or 2")
        }
        for key in[]string{"pr_text", "close_message", "target_branch"} {
            var occurrences int32
            for field in Value.EnumerateObject() {
                if field.Name == key {
                    occurrences++
                }
            }
            if occurrences > 1 {
                throw Exception("Duplicate policy field " + key)
            }
            let item = J.Get(Value, key)
            if item.ValueKind != JsonValueKind.Undefined {
                if item.ValueKind != JsonValueKind.String || Encoding.UTF8.GetByteCount(item.GetString() ?? "") > 4096 {
                    throw Exception(key + " must be bounded plain text")
                }
                let text = item.GetString() ?? ""
                for c in text {
                    if c == '\0' || (Char.IsControl(c) && c != '\n' && c != '\r' && c != '\t') {
                        throw Exception(key + " contains control characters")
                    }
                }
                if text.Contains("<!-- tokate") {
                    throw Exception(key + " cannot contain Tokate ownership markers")
                }
                if key == "target_branch" {
                    RepositoryIdentity.Branch(text)
                }
            }
        }
        ProtectedPaths.Validate(J.Get(Value, "protected_paths"))
        var eligibilityFields int32
        var scopeFields int32
        for field in Value.EnumerateObject() {
            if field.Name == "eligibility" {
                eligibilityFields++
            }
            if field.Name == "approval_scope" {
                scopeFields++
            }
        }
        if eligibilityFields > 0 || scopeFields > 0 {
            RequestData.Parse(text, 1024 * 1024)
            Eligibility = J.Text(Value, "eligibility")
            let approvalScope = J.Text(Value, "approval_scope")
            let eligible = Eligibility == "open" || Eligibility == "trusted" || Eligibility == "manual"
            if eligibilityFields != 1 || scopeFields != 1 || version != 2 || approvalScope != "task" || !eligible {
                throw Exception(
                    "Task eligibility requires version 2, approval_scope task, and eligibility open, trusted or manual"
                )
            }
        }
        var modes int32
        var modelMaps int32
        for field in Value.EnumerateObject() {
            if field.Name == "model_policy" {
                modes++
                let mode = field.Value
                if modes > 1 ||
                    mode.ValueKind != JsonValueKind.String ||
                    (mode.GetString() != "whitelist" && mode.GetString() != "unrestricted") {
                    throw Exception("model_policy must be exactly whitelist or unrestricted, without duplicates")
                }
                ModelPolicy = mode.GetString() ?? ""
            }
            if field.Name == "models" {
                modelMaps++
            }
        }
        let models = J.Get(Value, "models")
        if modes > 0 && modelMaps > 1 {
            throw Exception("Explicit model policy cannot contain duplicate models fields")
        }
        if ModelPolicy == "unrestricted" {
            if models.ValueKind != JsonValueKind.Undefined &&
                (models.ValueKind != JsonValueKind.Object || models.EnumerateObject().MoveNext()) {
                throw Exception("Unrestricted model policy requires omitted models or an empty object")
            }
        } else if models.ValueKind != JsonValueKind.Object {
            throw Exception("Policy models must map model names to effort arrays")
        }
        var count int32
        if models.ValueKind == JsonValueKind.Object {
            for model in models.EnumerateObject() {
                if !Regex.IsMatch(
                    model.Name,
                    J.Number(
                        Value,
                        "version"
                    ) == 2 ? "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$": "^[A-Za-z0-9][A-Za-z0-9._-]*$"
                ) {
                    throw Exception("Invalid model name")
                }
                let efforts = J.Items(model.Value)
                if efforts.Count == 0 {
                    throw Exception("Each model needs allowed efforts")
                }
                for effort in efforts {
                    if effort.ValueKind != JsonValueKind.String || !ValidEffort(effort.GetString() ?? "") {
                        throw Exception("Invalid reasoning effort")
                    }
                }
                count++
            }
        }
        let maxSeconds = J.Number(Value, "max_seconds")
        if (ModelPolicy == "whitelist" && count == 0) || maxSeconds < 1 || maxSeconds > 86400 {
            throw Exception("Set models and a max_seconds limit from 1 to 86400")
        }
        let networkKind = J.Get(Value, "allow_network").ValueKind
        if networkKind != JsonValueKind.True && networkKind != JsonValueKind.False {
            throw Exception("allow_network must be boolean")
        }
        let unlimited = J.Get(Value, "allow_unlimited").ValueKind
        if unlimited != JsonValueKind.Undefined && unlimited != JsonValueKind.True && unlimited != JsonValueKind.False {
            throw Exception("allow_unlimited must be boolean")
        }
        if unlimited != JsonValueKind.Undefined {
            RequestData.Parse(text, 1024 * 1024)
        }
        let commands = J.Items(J.Get(Value, "verification"))
        if commands.Count == 0 {
            throw Exception("At least one verification command is required")
        }
        for command in commands {
            let words = J.Items(command)
            if words.Count == 0 {
                throw Exception("Verification commands must be argv arrays")
            }
            for word in words {
                if word.ValueKind != JsonValueKind.String || String.IsNullOrWhiteSpace(word.GetString()) {
                    throw Exception("Invalid verification argument")
                }
            }
        }
        let checks = J.Items(J.Get(Value, "required_checks"))
        if checks.Count == 0 {
            throw Exception("At least one required check is needed")
        }
        for check in checks {
            if check.ValueKind != JsonValueKind.String || String.IsNullOrWhiteSpace(check.GetString()) {
                throw Exception("Invalid required check name")
            }
        }
        if version == 2 {
            let reservation = J.Get(Value, "reservation_seconds")
            if reservation.ValueKind != JsonValueKind.Undefined &&
                (J.Number(Value, "reservation_seconds") < 300 || J.Number(Value, "reservation_seconds") > 604800) {
                throw Exception("reservation_seconds must be from 300 to 604800 (default 86400)")
            }
            let allowedTools = J.Items(J.Get(Value, "allowed_tools"))
            if allowedTools.Count == 0 {
                throw Exception("Version 2 requires allowed_tools harness/provider pairs")
            }
            for tool in allowedTools {
                if J.Text(tool, "harness") == "" || J.Text(tool, "provider") == "" {
                    throw Exception("Each allowed tool needs harness and provider")
                }
            }
        }
    }

    private func ValidEffort(effort string) bool {
        if Array.IndexOf("minimal low medium high xhigh max ultra".Split(' '), effort) >= 0 {
            return true
        }
        if J.Number(Value, "version") != 2 {
            return false
        }
        if effort == "unknown" {
            return true
        }
        if effort != "absent" {
            return false
        }
        return J.Get(Value, "model_policy").ValueKind == JsonValueKind.String
    }

    internal func Allows(model string, effort string) bool {
        if ModelPolicy == "unrestricted" {
            return true
        }
        for item in J.Items(J.Get(J.Get(Value, "models"), model)) {
            if item.GetString() == effort {
                return true
            }
        }
        return false
    }

    internal func ManagedPair(model string, effort string) bool -> Regex.IsMatch(
        model,
        "^[A-Za-z0-9][A-Za-z0-9._-]*$"
    ) &&
        ValidEffort(effort) &&
        effort != "absent" &&
        (J.Number(Value, "version") != 2 || (model != "unknown" && effort != "unknown"))

    internal func Validate(model string, effort string, seconds int32, network bool, external bool = false) {
        if !Regex.IsMatch(
            model,
            external && J.Number(
                Value,
                "version"
            ) == 2 ? "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$": "^[A-Za-z0-9][A-Za-z0-9._-]*$"
        ) ||
            !ValidEffort(effort) {
            throw Exception("Invalid model name or reasoning effort")
        }
        if !external && !ManagedPair(model, effort) {
            throw Exception("Tokate-managed execution requires a known model and supported effort control")
        }
        if !Allows(model, effort) {
            throw Exception("Model/effort pair is not allowed by the repository policy")
        }
        ValidateBudget(seconds, network)
    }

    internal func ValidatePi(model string, effort string, seconds int32, network bool) {
        RequestData.ModelIdentifier(model)
        if J.Number(Value, "version") != 2 ||
            !AllowsTool("pi", "local-chat-completions") ||
            !ValidEffort(effort) ||
            effort == "unknown" ||
            effort == "ultra" ||
            model == "unknown" ||
            !Allows(model, effort) {
            throw Exception(
                "Managed pi requires version 2, exact pi/local-chat-completions permission, an exact model and allowed reasoning effort"
            )
        }
        ValidateBudget(seconds, network)
    }

    internal func ValidateBudget(seconds int32, network bool, unlimited bool = false) {
        if unlimited && (J.Number(Value, "version") != 2 || !J.Bool(Value, "allow_unlimited")) {
            throw Exception("Repository policy does not allow unlimited coding")
        }
        if seconds < 1 || seconds > J.Number(Value, "max_seconds") {
            throw Exception("Runtime exceeds repository policy")
        }
        if network && !J.Bool(Value, "allow_network") {
            throw Exception("Repository policy forbids command network access")
        }
    }

    internal func ValidateTools(tools JsonElement, source string = "external") {
        let declarations = J.Items(tools)
        if J.Number(Value, "version") != 2 || declarations.Count == 0 {
            throw Exception("Version 2 needs a nonempty tool declaration")
        }
        if source != "external" && source != "tokate" {
            throw Exception("Invalid contribution source")
        }
        if source == "tokate" {
            if declarations.Count != 1 ||
                !(
                (J.Text(declarations[0], "harness") == "codex" && J.Text(declarations[0], "provider") == "openai") ||
                    (
                    J.Text(declarations[0], "harness") == "pi" && J.Text(
                        declarations[0],
                        "provider"
                    ) == "local-chat-completions"
                )
            ) {
                throw Exception("Managed execution supports one codex/openai or pi/local-chat-completions declaration")
            }
        }
        for tool in declarations {
            if !AllowsTool(J.Text(tool, "harness"), J.Text(tool, "provider")) {
                throw Exception("Declared harness/provider is not allowed by owner policy")
            }
            if source == "tokate" && J.Text(tool, "harness") == "pi" {
                ValidatePi(J.Text(tool, "model"), J.Text(tool, "effort"), 1, false)
            } else {
                Validate(J.Text(tool, "model"), J.Text(tool, "effort"), 1, false, source == "external")
            }
        }
    }

    internal func AllowsTool(harness string, provider string) bool {
        for pair in J.Items(J.Get(Value, "allowed_tools")) {
            if J.Text(pair, "harness") == harness && J.Text(pair, "provider") == provider {
                return true
            }
        }
        return false
    }

    internal func ValidateEditingTools(tools JsonElement, failure string) {
        if J.Number(Value, "version") == 2 {
            ValidateTools(tools)
            return
        }
        for tool in J.Items(tools) {
            if J.Text(tool, "harness") != "codex" || J.Text(tool, "provider") != "openai" {
                throw Exception(failure)
            }
            Validate(J.Text(tool, "model"), J.Text(tool, "effort"), 1, false)
        }
    }

    shared {
        internal func CloseMessage(value JsonElement) string -> J.Get(value, "close_message")
            .ValueKind == JsonValueKind.Undefined ?
        "This pull request lacks current owner authorization. Please request owner approval.": J.Text(
            value,
            "close_message"
        )

        internal func Load(repo string, revision string) Policy -> Policy(
            GitHub.FileAt(repo, ".github/tokate.json", revision)
        )
    }
}
