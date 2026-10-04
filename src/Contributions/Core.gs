package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Reflection
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class CliFailure : Exception {
    internal let Code string
    internal let Action[]string
    internal let Summary string
    internal init(code string, message string, action[]string = nil, summary string = "") : base(message) {
        Code = code
        Action = action ?? []string{}
        Summary = summary == "" ? message: summary
    }
}

internal class Args {
    internal let Values Dictionary[string, string] = Dictionary[string, string]()
    internal var Command string = "help"
    internal var Help bool = false
    internal var Subject string = ""
    internal var IssueUrl string = ""
    internal init(args[]string) {
        if args.Length == 0 {
            Help = true
            return
        }
        Command = args[0]
        if Command == "--help" || Command == "-h" {
            Command = "help"
        }
        Cli.Find(Command)
        var i int32 = 1
        while i < args.Length {
            let word = args[i]
            if Command == "help" && word == "--version" && Subject == "" {
                Subject = word
                i++
                continue
            }
            if !word.StartsWith("-") {
                if (Command == "help" || Command == "completion" || Command == "defaults") && Subject == "" {
                    Subject = word
                } else if Cli.Find(Command).Has("issue") && IssueUrl == "" && word.StartsWith("https://") {
                    IssueUrl = word
                } else {
                    throw Exception("Unexpected argument: " + word)
                }
                i++
                continue
            }
            let equal = word.IndexOf('=')
            let key = word == "-h" ? "--help": (equal < 0 ? word: word.Substring(0, equal))
            if !key.StartsWith("--") || Values.ContainsKey(key) {
                throw Exception("Invalid or duplicate option: " + key)
            }
            let option = Cli.OptionFor(Command, key.Substring(2))
            if option.Value == "" {
                if equal >= 0 {
                    throw Exception("Flag does not take a value: " + key)
                }
                Values.Add(key, "true")
            } else {
                var value = equal < 0 ? "": word.Substring(equal + 1)
                if equal < 0 {
                    i++
                    if i < args.Length && !args[i].StartsWith("-") {
                        value = args[i]
                    }
                }
                if String.IsNullOrWhiteSpace(value) {
                    throw Exception("Missing value for " + key)
                }
                Values.Add(key, value)
            }
            i++
        }
        if Command == "help" {
            if Subject != "" {
                Cli.Find(Subject)
            }
            Help = true
        } else {
            Help = Get("help") == "true"
        }
    }

    internal func Get(key string, fallback string = "") string {
        var value string
        return Values.TryGetValue("--" + key, out value) ? value: fallback
    }

    internal func Need(key string) string {
        let value = Get(key)
        if value == "" {
            throw Exception("Required: --" + key)
        }
        return value
    }

    internal func Number(key string, fallback string = "") int32 {
        let value = Get(key, fallback)
        var number int32
        if (key == "verification-reserve" && !Regex.IsMatch(value, "^[0-9]+\\z")) || !Int32.TryParse(
            value,
            out number
        ) ||
            number < 1 ||
            ((key == "seconds" || key == "timeout") && number > 86400) {
            throw Exception("Invalid positive number: --" + key)
        }
        return number
    }
}

internal class Data {
    internal let Fields Dictionary[string, Object?] = Dictionary[string, Object?]()
    internal func Text(key string) string -> J.Text(Element(), key)

    internal func Number(key string) int32 -> J.Number(Element(), key)

    internal func Flag(key string) bool -> J.Bool(Element(), key)

    internal func Element() JsonElement -> J.Parse(J.Write(Fields))

    internal func Save(directory string) {
        let path = Path.Combine(directory, "run.json")
        File.WriteAllText(path + ".tmp", J.Write(Fields) + "\n")
        File.Move(path + ".tmp", path, true)
    }
    shared {
        internal func Version() string -> Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "unknown"

        internal func Load(directory string) Data {
            let result = Data()
            for field in J.Parse(File.ReadAllText(Path.Combine(directory, "run.json"))).EnumerateObject() {
                result.Fields[field.Name] = field.Value.Clone()
            }
            return result
        }

        internal func Hash(text string) string -> Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))
            .ToLowerInvariant()

        internal func Resource(name string) string {
            using let stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Tokate.templates." + name) ??
                throw Exception("Missing embedded template " + name)
            using let reader = StreamReader(stream)
            return reader.ReadToEnd()
        }

        internal func Repo(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$") {
                throw Exception("Use OWNER/REPO")
            }
            return value
        }

        internal func CommitSha(value string) string {
            if value.Length != 40 || !Regex.IsMatch(value, "^[0-9a-f]{40}$") {
                throw Exception("Expected an exact 40-character Git commit SHA")
            }
            return value
        }

        internal func Branch(value string) string {
            if value == "" || value == "@" || value.StartsWith("-") || value.EndsWith(".") || value.Contains("..") ||
                value.Contains("@{") || Regex.IsMatch(value, "[\\x00-\\x20\\x7f~^:?*\\\\\\[]") {
                throw Exception("Expected a Git branch name")
            }
            for part in value.Split('/') {
                if part == "" || part.StartsWith(".") || part.EndsWith(".lock") {
                    throw Exception("Expected a Git branch name")
                }
            }
            return value
        }

        internal func Login(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9-]*$") {
                throw Exception("Invalid GitHub username")
            }
            return value
        }
    }
}

internal class GitHub {
    shared {
        internal func AutomationCommit(message string, tree string, parents IEnumerable[string]) Object {
            let identity = J.Map("name", "Tokate", "email", "tokate@users.noreply.github.com")
            return J.Map(
                "message",
                message,
                "tree",
                tree,
                "parents",
                parents,
                "author",
                identity,
                "committer",
                identity
            )
        }

        internal suspend func Api(
            path string,
            body Object? = nil,
            method string = "",
            missing bool = false,
            expires int64 = 0
        ) JsonElement -> ApiTransport.Request(path, body, method, missing, expires)

        internal func FileAt(repo string, path string, revision string) string {
            let result = Api("repos/" + repo + "/contents/" + path + "?ref=" + Uri.EscapeDataString(revision))
            if J.Text(result, "encoding") != "base64" {
                throw Exception("Expected a small repository configuration file")
            }
            return Encoding.UTF8.GetString(Convert.FromBase64String(J.Text(result, "content")))
        }

        internal func Branch(repo string, branch string) string -> Data.CommitSha(
            J.Text(
                J.Get(Api("repos/" + repo + "/git/ref/heads/" + Uri.EscapeDataString(Data.Branch(branch))), "object"),
                "sha"
            )
        )

        internal func Issue(repo string, number int32) JsonElement {
            let issue = Api("repos/" + repo + "/issues/" + number.ToString())
            if J.Text(issue, "state") != "open" || J.Get(issue, "pull_request").ValueKind != JsonValueKind.Undefined {
                throw Exception("Choose an open issue")
            }
            return issue
        }

        internal func HasLabel(issue JsonElement) bool {
            for label in J.Items(J.Get(issue, "labels")) {
                if J.Text(label, "name") == "tokate:approved" {
                    return true
                }
            }
            return false
        }

        internal func Assigned(issue JsonElement, donor string) bool {
            let people = J.Items(J.Get(issue, "assignees"))
            return people.Count == 1 && String.Equals(
                J.Text(people[0], "login"),
                donor,
                StringComparison.OrdinalIgnoreCase
            )
        }

        internal func Fingerprint(issue JsonElement) string -> Data.Hash(
            J.Write(J.Map("title", J.Text(issue, "title"), "body", J.Text(issue, "body")))
        )
    }
}

internal class Policy {
    internal var Value JsonElement
    internal var Digest string = ""
    internal var ModelPolicy string = "whitelist"
    internal var Eligibility string = ""
    internal init(text string) {
        Value = J.Parse(text)
        Digest = Data.Hash(text)
        if J.Number(Value, "version") != 1 && J.Number(Value, "version") != 2 {
            throw Exception("Policy version must be 1 or 2")
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
            if eligibilityFields != 1 || scopeFields != 1 || J.Number(Value, "version") != 2 || J.Text(
                Value,
                "approval_scope"
            ) != "task" ||
                (Eligibility != "open" && Eligibility != "trusted" && Eligibility != "manual") {
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
                if modes > 1 ||
                    field
                    .Value
                    .ValueKind != JsonValueKind.String ||
                    (field.Value.GetString() != "whitelist" && field.Value.GetString() != "unrestricted") {
                    throw Exception("model_policy must be exactly whitelist or unrestricted, without duplicates")
                }
                ModelPolicy = field.Value.GetString() ?? ""
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
                if !Regex.IsMatch(model.Name, "^[A-Za-z0-9][A-Za-z0-9._-]*$") {
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
        if (ModelPolicy == "whitelist" && count == 0) || J.Number(Value, "max_seconds") < 1 || J.Number(
            Value,
            "max_seconds"
        ) > 86400 {
            throw Exception("Set models and a max_seconds limit from 1 to 86400")
        }
        if J.Get(Value, "allow_network").ValueKind != JsonValueKind.True && J.Get(Value, "allow_network")
            .ValueKind != JsonValueKind.False {
            throw Exception("allow_network must be boolean")
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
        if J.Number(Value, "version") == 2 {
            let reservation = J.Get(Value, "reservation_seconds")
            if reservation.ValueKind != JsonValueKind.Undefined &&
                (J.Number(Value, "reservation_seconds") < 300 || J.Number(Value, "reservation_seconds") > 604800) {
                throw Exception("reservation_seconds must be from 300 to 604800 (default 86400)")
            }
            if J.Items(J.Get(Value, "allowed_tools")).Count == 0 {
                throw Exception("Version 2 requires allowed_tools harness/provider pairs")
            }
            for tool in J.Items(J.Get(Value, "allowed_tools")) {
                if J.Text(tool, "harness") == "" || J.Text(tool, "provider") == "" {
                    throw Exception("Each allowed tool needs harness and provider")
                }
            }
        }
    }

    private func ValidEffort(effort string) bool -> Array.IndexOf(
        "minimal low medium high xhigh max ultra".Split(' '),
        effort
    ) >= 0 ||
        (
        J.Number(Value, "version") == 2 &&
            (
            effort == "unknown" ||
                (effort == "absent" && J.Get(Value, "model_policy").ValueKind == JsonValueKind.String)
        )
    )

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
        if !Regex.IsMatch(model, "^[A-Za-z0-9][A-Za-z0-9._-]*$") || !ValidEffort(effort) {
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

    internal func ValidateBudget(seconds int32, network bool) {
        if seconds < 1 || seconds > J.Number(Value, "max_seconds") {
            throw Exception("Runtime exceeds repository policy")
        }
        if network && !J.Bool(Value, "allow_network") {
            throw Exception("Repository policy forbids command network access")
        }
    }

    internal func ValidateTools(tools JsonElement, source string = "external") {
        if J.Number(Value, "version") != 2 || J.Items(tools).Count == 0 {
            throw Exception("Version 2 needs a nonempty tool declaration")
        }
        if source != "external" && source != "tokate" {
            throw Exception("Invalid contribution source")
        }
        if source == "tokate" &&
            (
            J.Items(tools).Count != 1 || J.Text(J.Items(tools)[0], "harness") != "codex" || J.Text(
                J.Items(tools)[0],
                "provider"
            ) != "openai"
        ) {
            throw Exception(
                "Tokate-launched execution currently supports one codex/openai declaration; other harnesses use external"
            )
        }
        for tool in J.Items(tools) {
            var allowed bool
            for pair in J.Items(J.Get(Value, "allowed_tools")) {
                if J.Text(pair, "harness") == J.Text(tool, "harness") && J.Text(pair, "provider") == J.Text(
                    tool,
                    "provider"
                ) {
                    allowed = true
                }
            }
            if !allowed {
                throw Exception("Declared harness/provider is not allowed by owner policy")
            }
            Validate(J.Text(tool, "model"), J.Text(tool, "effort"), 1, false, source == "external")
        }
    }
    shared {
        internal func Load(repo string, revision string) Policy -> Policy(
            GitHub.FileAt(repo, ".github/tokate.json", revision)
        )
    }
}
