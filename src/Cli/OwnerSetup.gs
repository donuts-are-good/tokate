package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

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
                    let models = J.Map()
                    while true {
                        let model = Answer("Model name (Enter finishes the list)").Trim()
                        if model == "" {
                            return J.Write(models)
                        }
                        if models.ContainsKey(model) {
                            throw Exception("Model already selected: " + model)
                        }
                        let efforts = Answer("Allowed efforts, separated by spaces (use absent for no effort control)")
                        models[model] = efforts.Replace(',', ' ').Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    }
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

        private func Answer(prompt string, fallback string = "") string {
            Console.Error.Write(
                Terminal.Clean(prompt) + (fallback == "" ? "": " [" + Terminal.Clean(fallback) + "]") + ": "
            )
            let answer = Console.ReadLine() ?? throw Exception("Setup cancelled")
            return answer == "" ? fallback: answer
        }

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
            let fields = J.Map()
            if before != "" {
                existing = Policy(before)
                for field in existing.Value.EnumerateObject() {
                    fields[field.Name] = field.Value
                }
            } else {
                fields["version"] = 2
                fields["approval_scope"] = "task"
                fields["eligibility"] = "trusted"
                fields["allowed_tools"] = []Object{J.Map("harness", "codex", "provider", "openai")}
                fields["max_seconds"] = 3600
                fields["allow_network"] = false
            }
            let interactive = !PublicOutput.Enabled && args.Get("non-interactive") != "true" &&
                !Console.IsInputRedirected
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
            if existing == nil || args.Get("model-policy") != "" || args.Get("upgrade") == "true" ||
                mode != existing?.ModelPolicy {
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
            if args.Get("upgrade") == "true" {
                fields["version"] = 2
                if !fields.ContainsKey("allowed_tools") {
                    fields["allowed_tools"] = []Object{J.Map("harness", "codex", "provider", "openai")}
                }
                fields["approval_scope"] = "task"
                if !fields.ContainsKey("eligibility") {
                    fields["eligibility"] = "trusted"
                }
            }
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
                let value = J.Parse(J.Write(fields))
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
                "Generated state: one tokate/access ref for numeric membership and one tokate/contributions/N ref per v2 issue; legacy approvals and explicit synchronization grant refs remain when present. Setup creates no refs; initialize access before task approval.",
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
            PublicOutput.ResultData = J.Map(
                "applied",
                apply,
                "file_count",
                File.Exists(template) ? 3: 2,
                "policy_changed",
                before != text,
                "workflow_changed",
                oldWorkflow == "",
                "model_policy",
                policy.ModelPolicy
            )
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
