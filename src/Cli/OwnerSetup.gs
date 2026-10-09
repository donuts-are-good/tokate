package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class OwnerSetup {
    shared {
        internal func Preview(path string, before string, after string) {
            Console.Error.WriteLine(
                (before == "" ? "Add ": before == after ? "Keep ": "Update ") + Terminal.Clean(path)
            )
            if before != "" && before != after {
                Console.Error.WriteLine("Current complete file:")
                Console.Error.WriteLine(Terminal.Clean(before))
            }
            Console.Error.WriteLine("Proposed complete file:")
            Console.Error.WriteLine(Terminal.Clean(after))
        }

        internal func Confirm(args Args) bool {
            if args.Get("yes") == "true" {
                return true
            }
            if PublicOutput.Enabled || args.Get("non-interactive") == "true" || Console.IsInputRedirected {
                Terminal.Message("Preview only; use --yes to apply these changes.", "cyan", true)
                return false
            }
            Console.Error.Write("Apply these file changes? [y/N]: ")
            return String.Equals(Console.ReadLine(), "y", StringComparison.OrdinalIgnoreCase)
        }

        private func SetupAnswer(args Args, key string, prompt string, fallback string, interactive bool) string {
            if args.Get(key) != "" {
                return args.Get(key)
            }
            if !interactive {
                return fallback
            }
            if key == "models" || key == "verification" {
                if fallback != "" {
                    let keep = Answer(
                        "Keep the existing " + (key == "models" ? "model whitelist": "verification commands") + "?",
                        "yes"
                    )
                    if !String.Equals(keep, "no", StringComparison.OrdinalIgnoreCase) && !String.Equals(
                        keep,
                        "n",
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        return fallback
                    }
                }
                if key == "models" {
                    return ModelChecklist().Run()
                }
                let commands = List[Object]()
                while true {
                    let command = Answer("Shell command to verify the project (Enter finishes the list)")
                    if String.IsNullOrWhiteSpace(command) {
                        return J.Write(commands)
                    }
                    commands.Add([]string{"/bin/sh", "-c", command})
                }
            }
            if key == "required-checks" {
                let names = List[string]()
                if fallback != "" {
                    for item in J.Parse(fallback).EnumerateArray() {
                        names.Add(item.GetString() ?? "")
                    }
                }
                let answer = Answer("Required GitHub check names, separated by commas", String.Join(", ", names))
                names.Clear()
                for name in answer.Split(',') {
                    if name.Trim() != "" {
                        names.Add(name.Trim())
                    }
                }
                return J.Write(names)
            }
            if key == "close-message" {
                return fallback
            }
            return Answer(prompt, fallback)
        }

        private func Answer(prompt string, fallback string = "") string ->
        WizardScreen.Read("Project setup", "", prompt, fallback)

        private func SetupPath(root string, relative string) string {
            let path = Path.Combine(root, relative)
            var current = path
            while current != root {
                if FileInfo(current).LinkTarget != nil || DirectoryInfo(current).LinkTarget != nil {
                    throw Exception("Setup refuses linked configuration paths")
                }
                current = Path.GetDirectoryName(current) ?? root
            }
            if Directory.Exists(path) {
                throw Exception("Setup file path is a directory")
            }
            return path
        }

        private func Tools(args Args, fields map[string, Object?], interactive bool) {
            let value = J.Parse(J.Write(fields))
            var requested = args.Get("allowed-tools")
            if requested == "" && interactive {
                let current = List[string]()
                for tool in J.Items(J.Get(value, "allowed_tools")) {
                    current.Add(J.Text(tool, "harness") + "/" + J.Text(tool, "provider"))
                }
                Terminal.Message("Current allowed tools: " + String.Join(", ", current), error: true)
                requested = Answer(
                    "Managed tools: codex,pi keeps external permissions; use harness/provider pairs to replace all; Enter keeps current"
                )
            }
            if requested == "" {
                return
            }
            let selected = HashSet[string](StringComparer.Ordinal)
            let tools = List[Object]()
            if !requested.Contains('/') {
                for tool in J.Items(J.Get(value, "allowed_tools")) {
                    if !DonorSelection.Supported(tool) && selected.Add(
                        J.Text(tool, "harness") + "/" + J.Text(tool, "provider")
                    ) {
                        tools.Add(tool.Clone())
                    }
                }
            }
            for name in requested.Split(',') {
                let parts = name.Trim().Split('/')
                let harness = parts[0]
                let provider = parts.Length == 2 ? parts[1]: DonorDefaults.Provider(harness)
                if parts.Length > 2 || !Regex.IsMatch(harness, "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\\z") || !Regex.IsMatch(
                    provider,
                    "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\\z"
                ) {
                    throw Exception("Use codex, pi, or exact harness/provider pairs for allowed tools")
                }
                if selected.Add(harness + "/" + provider) {
                    tools.Add(map[string, Object?]{"harness": harness, "provider": provider})
                }
            }
            fields["allowed_tools"] = tools
        }

        private func Guide(args Args, fields map[string, Object?]) {
            let repo = args.Need("repo")
            let initial = J.Parse(J.Write(fields))
            if J.Text(initial, "approval_scope") == "task" {
                let modes = []string{"trusted", "open", "manual"}
                let current = Array.IndexOf(modes, J.Text(initial, "eligibility")) + 1
                fields["eligibility"] = modes[
                    WizardScreen.Choose(
                        "Who can contribute?",
                        repo + "\nApprove the task once. Choose who may claim it.",
                        []string{
                            "Trusted people   Newcomers request access first",
                            "Anyone eligible  Anyone meeting your policy may claim",
                            "Choose each time Approve each donor yourself"
                        },
                        "Every contribution still needs your review before merge.",
                        current
                    ) - 1
                ]
            }
            let restriction = WizardScreen.Choose(
                "Allowed models",
                "Choose how much control you want over the coding model.",
                []string{"Any supported model", "Choose allowed models"},
                "Existing restrictions remain unless you explicitly change them.",
                J.Text(initial, "model_policy") == "unrestricted" ? 1: J.Get(initial, "models")
                    .ValueKind == JsonValueKind.Object ? 2: 0
            )
            args.Values["--model-policy"] = restriction == 1 ? "unrestricted": "whitelist"
            if restriction == 2 && J.Get(initial, "models").ValueKind != JsonValueKind.Object {
                fields["models"] = RequestData.Parse(ModelChecklist().Run())
            }
            if !fields.ContainsKey("verification") {
                fields["verification"] = RequestData.Parse(SetupAnswer(args, "verification", "", "", true))
            }
            if !fields.ContainsKey("required_checks") {
                fields["required_checks"] = RequestData.Parse(SetupAnswer(args, "required-checks", "", "", true))
            }
            while true {
                let value = J.Parse(J.Write(fields))
                let checks = List[string]()
                for command in J.Items(J.Get(value, "verification")) {
                    checks.Add(Terminal.Command(command))
                }
                let models = List[string]()
                if J.Get(value, "models").ValueKind == JsonValueKind.Object {
                    for entry in J.Get(value, "models").EnumerateObject() {
                        let efforts = List[string]()
                        for effort in entry.Value.EnumerateArray() {
                            efforts.Add(effort.GetString() ?? "")
                        }
                        models.Add(entry.Name + " / " + String.Join(", ", efforts))
                    }
                }
                let tools = List[string]()
                for tool in J.Items(J.Get(value, "allowed_tools")) {
                    tools.Add(
                        J.Text(tool, "harness") == "pi" ? "Pi (Local)": J.Text(
                            tool,
                            "harness"
                        ) == "codex" ? "Codex (Subscription)": J.Text(tool, "harness")
                    )
                }
                let action = WizardScreen.Choose(
                    "Review project setup",
                    repo + "\n\nAccess   " + J.Text(value, "eligibility") + "\nModels   " + args.Need("model-policy") +
                        (
                        args.Need("model-policy") == "whitelist" ? "\n         " + String.Join(
                            "\n         ",
                            models
                        ): ""
                    ) +
                        "\nChecks   " +
                        (checks.Count == 0 ? "None configured": String.Join("\n         ", checks)) +
                        "\nGitHub   " +
                        Terminal.Command(J.Get(value, "required_checks")) +
                        "\nLimit    " +
                        (J.Number(value, "max_seconds") / 60.0).ToString("0.##") +
                        " minutes total" +
                        "\nNetwork  " +
                        (J.Bool(value, "allow_network") ? "Project commands allowed": "Project commands offline") +
                        "\nTools    " +
                        String.Join(", ", tools),
                    []string{
                        "Create policy files",
                        "Change checks or time limit",
                        "Review allowed models",
                        "Change tools or network",
                        "Back to home"
                    },
                    "Setup writes local configuration. Review and commit it before approving a task. Existing custom settings and workflow files are preserved."
                )
                if action == 1 {
                    args.Values["--yes"] = "true"
                    return
                }
                if action == 5 {
                    throw WizardHome()
                }
                if action == 2 {
                    let change = WizardScreen.Choose(
                        "Change project setup",
                        "Use checks that validate this project.",
                        []string{"Verification commands", "Time limit", "Required GitHub checks", "Back to review"}
                    )
                    if change == 1 {
                        fields["verification"] = RequestData.Parse(SetupAnswer(args, "verification", "", "", true))
                    }
                    if change == 2 {
                        fields["max_seconds"] = int32.Parse(
                            WizardScreen.Read(
                                "Project time limit",
                                "Total minutes for coding and verification.",
                                "Minutes",
                                (J.Number(value, "max_seconds") / 60).ToString()
                            )
                        ) * 60
                    }
                    if change == 3 {
                        fields["required_checks"] = RequestData.Parse(
                            SetupAnswer(args, "required-checks", "", J.Write(J.Get(value, "required_checks")), true)
                        )
                    }
                }
                if action == 3 {
                    let mode = WizardScreen.Choose(
                        "Allowed models",
                        "Choose your model policy.",
                        []string{"Any supported model", "Choose allowed models"}
                    )
                    args.Values["--model-policy"] = mode == 1 ? "unrestricted": "whitelist"
                    if mode == 2 {
                        fields["models"] = RequestData.Parse(ModelChecklist().Run())
                    }
                }
                if action == 4 {
                    let choice = WizardScreen.Choose(
                        "Allowed coding tools",
                        "Owners need neither tool installed.",
                        []string{
                            "Codex | Subscription",
                            "Pi | Local",
                            "Codex and Pi",
                            "Edit exact harness/provider pairs"
                        }
                    )
                    let pairs = List[string]()
                    for tool in J.Items(J.Get(value, "allowed_tools")) {
                        pairs.Add(J.Text(tool, "harness") + "/" + J.Text(tool, "provider"))
                    }
                    args.Values["--allowed-tools"] = choice == 4 ? Answer(
                        "Allowed harness/provider pairs",
                        String.Join(",", pairs)
                    ):
                    choice == 1 ? "codex": choice == 2 ? "pi": "codex,pi"
                    Tools(args, fields, false)
                    fields["allow_network"] = WizardScreen.Choose(
                        "Project network",
                        "Donors must also consent. Inference connectivity is separate.",
                        []string{"Keep project commands offline", "Allow project command network access"},
                        selected: J.Bool(value, "allow_network") ? 2: 1
                    ) == 2
                }
            }
        }

        internal func Run(args Args) {
            let root = Path.GetFullPath(args.Get("path", "."))
            let path = SetupPath(root, ".github/tokate.json")
            var workflow = SetupPath(root, ".github/workflows/tokate-coordinator.yml")
            let workflows = Path.Combine(root, ".github/workflows")
            if !File.Exists(workflow) && Directory.Exists(workflows) {
                let matches = List[string]()
                for file in Directory.EnumerateFiles(workflows) {
                    if (file.EndsWith(".yml") || file.EndsWith(".yaml")) && FileInfo(file).LinkTarget == nil &&
                        File
                        .ReadAllText(file).Contains("obselate/tokate/.github/workflows/tokate-shared.yml@") {
                        matches.Add(SetupPath(root, Path.GetRelativePath(root, file)))
                    }
                }
                if matches.Count > 1 {
                    throw Exception(
                        "Multiple owner Tokate workflow entries exist; select the existing wiring before setup"
                    )
                }
                if matches.Count == 1 {
                    workflow = matches[0]
                }
            }
            let template = SetupPath(root, ".github/tokate-pr.md")
            let before = File.Exists(path) ? File.ReadAllText(path): ""
            var existing Policy? = nil
            let fields = map[string, Object?]{}
            if before != "" {
                existing = Policy(before)
                for field in existing.Value.EnumerateObject() {
                    fields[field.Name] = field.Value
                }
            } else {
                fields["version"] = 2
                fields["approval_scope"] = "task"
                fields["eligibility"] = "trusted"
                fields["allowed_tools"] = []Object{map[string, Object?]{"harness": "codex", "provider": "openai"}}
                fields["max_seconds"] = 3600
                fields["allow_network"] = false
            }
            let foreground = !PublicOutput.Enabled && args.Get("non-interactive") != "true" &&
                !Console.IsInputRedirected
            if foreground && args.Guided {
                Guide(args, fields)
            }
            let interactive = foreground && !args.Guided
            let mode = SetupAnswer(
                args,
                "model-policy",
                "Models: unrestricted or whitelist (explicit choice required)",
                existing?.ModelPolicy ?? "",
                interactive
            )
            if mode != "unrestricted" && mode != "whitelist" {
                throw Exception(
                    "Choose --model-policy unrestricted or whitelist; no model restriction is selected silently"
                )
            }
            if existing == nil || args.Get("model-policy") != "" || mode != existing?.ModelPolicy {
                fields["model_policy"] = mode
            }
            if mode == "unrestricted" {
                if args.Get("models") != "" {
                    throw Exception("Unrestricted models excludes --models")
                }
                fields.Remove("models")
            } else {
                let models = SetupAnswer(
                    args,
                    "models",
                    "Allowed models and efforts as a JSON object; absent means no effort control",
                    fields.ContainsKey("models") ? J.Write(fields["models"] ?? ""): "",
                    interactive
                )
                if models == "" {
                    throw Exception("Whitelist setup requires --models JSON")
                }
                fields["models"] = RequestData.Parse(models)
            }
            Tools(args, fields, interactive)
            let value = J.Parse(J.Write(fields))
            for key in[]string{
                "eligibility",
                "base-branch",
                "network",
                "seconds",
                "reservation-seconds",
                "verification",
                "required-checks",
                "pr-text",
                "close-message"
            } {
                let field = key == "base-branch" ? "target_branch": key.Replace('-', '_')
                let present = J.Get(value, field)
                var fallback = present.ValueKind == JsonValueKind.Undefined ? "": present.ToString()
                if key == "network" {
                    fallback = J.Bool(value, "allow_network") ? "allow": "deny"
                }
                if key == "seconds" {
                    fallback = J.Number(value, "max_seconds").ToString()
                }
                let answer = SetupAnswer(
                    args,
                    key,
                    key +
                        (
                        key == "verification" ? " JSON argv arrays": key == "required-checks" ? " JSON check names": ""
                    ),
                    fallback,
                    interactive
                )
                if answer == "" {
                    continue
                }
                if key == "network" {
                    if answer != "allow" && answer != "deny" {
                        throw Exception("Network must be allow or deny")
                    }
                    fields["allow_network"] = answer == "allow"
                } else if key == "seconds" || key == "reservation-seconds" {
                    fields[key == "seconds" ? "max_seconds": field] = Int32.Parse(answer)
                } else if key == "verification" || key == "required-checks" {
                    fields[field] = RequestData.Parse(answer)
                } else {
                    fields[field] = answer
                }
            }
            let candidate = J.Write(fields)
            let policy = Policy(candidate)
            let text = before != "" && RequestData.Canonical(J.Parse(before)) == RequestData.Canonical(
                policy.Value
            ) ? before: Pretty(policy.Value)
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            RepositoryAccess.RequireOwner(repo)
            let oldWorkflow = File.Exists(workflow) ? File.ReadAllText(workflow): ""
            CoordinatorSetup.EventPolicy(repo, Path.GetRelativePath(root, workflow))
            let yaml = oldWorkflow == "" ? CoordinatorSetup.Resolve(): oldWorkflow
            WizardScreen.Close()
            Preview(path, before, text)
            Preview(workflow, oldWorkflow, yaml)
            if File.Exists(template) {
                Preview(template, File.ReadAllText(template), File.ReadAllText(template))
            }
            Terminal.Message(
                "Owner footprint: " +
                    (File.Exists(template) ? "3": "2") +
                    " files; no copied runtime code, dependency files or test scaffolding are generated.",
                "cyan",
                true
            )
            Terminal.Message(
                oldWorkflow == "" ? "Workflow permissions: contents write for coordination refs, issues read for canonical requests, pull-requests write for draft publication; no secrets inheritance or checkout.": "Existing owner workflow is preserved. Tokate wiring and permissions are not verified; review and complete owner installation before use.",
                "cyan",
                true
            )
            Terminal.Message(
                "Generated state: one tokate/access ref for numeric membership, one tokate/contributions/N ref per issue, and explicit synchronization grant refs. Setup creates no refs; initialize access before task approval.",
                "cyan",
                true
            )
            if before != "" && before != text {
                Terminal.Message(
                    "Policy changes stale all existing approvals and claims; the owner must approve again. Eligibility revocation separately blocks new work and publication immediately.",
                    "yellow",
                    true
                )
            }
            let apply = Confirm(args)
            if apply {
                SetupPath(root, ".github/tokate.json")
                SetupPath(root, Path.GetRelativePath(root, workflow))
                if (File.Exists(path) ? File.ReadAllText(path): "") != before ||
                    (File.Exists(workflow) ? File.ReadAllText(workflow): "") != oldWorkflow {
                    throw Exception("Owner configuration changed during preview; inspect it before repeating setup")
                }
                if before != text {
                    Directory.CreateDirectory(Path.GetDirectoryName(path) ?? root)
                    File.WriteAllText(path, text)
                }
                if oldWorkflow == "" {
                    Directory.CreateDirectory(Path.GetDirectoryName(workflow) ?? root)
                    File.WriteAllText(workflow, yaml)
                }
                Terminal.Message(
                    "Owner setup saved. Review and commit the policy and workflow before approving work; every PR still needs owner review."
                )
            }
            if apply && (File.ReadAllText(path) != text || File.ReadAllText(workflow) != yaml) {
                throw Exception("Setup output differs from the reviewed proposal")
            }
            PublicOutput.ResultData = map[string, Object?]{
                "applied": apply,
                "file_count": File.Exists(template) ? 3: 2,
                "policy_changed": before != text,
                "workflow_changed": oldWorkflow == "",
                "model_policy": policy.ModelPolicy
            }
        }

        private func Pretty(value JsonElement) string {
            using let bytes = MemoryStream()
            using let writer = Utf8JsonWriter(bytes, JsonWriterOptions{Indented: true})
            value.WriteTo(writer)
            writer.Flush()
            return System.Text.Encoding.UTF8.GetString(bytes.ToArray()) + "\n"
        }
    }
}
