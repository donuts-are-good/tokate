package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class DonorSelection {
    shared {
        internal func Capabilities() Dictionary[string, HashSet[string]] {
            let executable = Startup.Find("codex")
            if executable == "" {
                throw Exception("Install native Codex to verify model/effort capability; availability is unknown")
            }
            let home = Path.Combine(Path.GetTempPath(), "tokate-models-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(home, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            try {
                let prefix = List[string]{
                    "-i",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "HOME=" + home,
                    "CODEX_HOME=" + home,
                    executable
                }
                let help = List[string](prefix)
                help.AddRange([]string{"exec", "--help"})
                let controls = Commands.Run("/usr/bin/env", help.ToArray(), home, seconds: 10, isolated: true)
                for flag in[]string{"--model", "--config", "--ignore-user-config", "--strict-config"} {
                    if controls.Code != 0 || !controls.Output.Contains(flag) {
                        throw Exception(
                            "Native Codex does not expose the required explicit controls; no compatible pair"
                        )
                    }
                }
                let catalog = List[string](prefix)
                catalog.AddRange([]string{"debug", "models", "--bundled"})
                let result = Commands.Run("/usr/bin/env", catalog.ToArray(), home, seconds: 10, isolated: true)
                if result.Code != 0 {
                    throw Exception("Cannot verify offline Codex model/effort capabilities; availability is unknown")
                }
                let models = Dictionary[string, HashSet[string]](StringComparer.Ordinal)
                let value = RequestData.Parse(result.Output, 4 * 1024 * 1024)
                for model in J.Items(J.Get(value, "models")) {
                    let efforts = HashSet[string](StringComparer.Ordinal)
                    for level in J.Items(J.Get(model, "supported_reasoning_levels")) {
                        efforts.Add(J.Text(level, "effort"))
                    }
                    models[J.Text(model, "slug")] = efforts
                }
                return models
            } finally {
                Directory.Delete(home, true)
            }
        }

        private func ToolAllowed(policy Policy, harness string, provider string) bool {
            if harness != "codex" || provider != "openai" {
                return false
            }
            if J.Number(policy.Value, "version") == 1 {
                return true
            }
            for tool in J.Items(J.Get(policy.Value, "allowed_tools")) {
                if J.Text(tool, "harness") == harness && J.Text(tool, "provider") == provider {
                    return true
                }
            }
            return false
        }

        internal func Interactive(args Args) bool -> args.Get("non-interactive") != "true" &&
            !Console.IsInputRedirected &&
            !Console.IsOutputRedirected &&
            !Console.IsErrorRedirected

        internal func Resolve(args Args, policy Policy) JsonElement {
            let harness = args.Get("harness", "codex")
            let provider = args.Get("provider", "openai")
            if harness != "codex" || provider != "openai" {
                throw Exception(
                    "Unsupported managed harness/provider: choose codex/openai explicitly. No inference started."
                )
            }
            if !ToolAllowed(policy, harness, provider) {
                throw Exception(
                    "No eligible pair: codex/openai is rejected by current exact owner tool restrictions. No inference started."
                )
            }
            let capabilities = Capabilities()
            var saved = JsonElement{}
            var reason = "No saved default."
            if args.Get("model") == "" || args.Get("effort") == "" {
                try {
                    saved = DonorDefaults.Read()
                } catch (error Exception) {
                    reason = "Saved default is invalid or inaccessible."
                }
            }
            let compatible = J.Text(saved, "harness") == harness && J.Text(saved, "provider") == provider
            var model = args.Get("model", compatible ? J.Text(saved, "model"): "")
            var effort = args.Get("effort", compatible ? J.Text(saved, "effort"): "")
            let explicitPair = args.Get("model") != "" || args.Get("effort") != ""
            var source = explicitPair ? "explicit invocation": "saved donor default"
            var availability = args.Get("availability", "unknown")
            let unavailable = availability == "unavailable" ? model: ""
            let choices = SortedDictionary[string, JsonElement](StringComparer.Ordinal)
            for entry in J.Get(policy.Value, "models").EnumerateObject() {
                var supported HashSet[string]
                if entry.Name == unavailable || !capabilities.TryGetValue(entry.Name, out supported) {
                    continue
                }
                for level in J.Items(entry.Value) {
                    let candidateEffort = level.GetString() ?? ""
                    if supported.Contains(candidateEffort) {
                        choices[entry.Name + " / " + candidateEffort] = J.Parse(
                            J.Write(J.Map("model", entry.Name, "effort", candidateEffort))
                        )
                    }
                }
            }
            if choices.Count == 0 {
                throw Exception(
                    "No eligible pair: the intersection of exact owner policy and offline harness capabilities is empty after excluding donor-reported unavailable models. Other model availability is unknown. No inference started."
                )
            }
            if !choices.ContainsKey(model + " / " + effort) {
                var rejection = "Incomplete donor model/effort choice."
                if model != "" && effort != "" {
                    var policyEligible bool
                    for level in J.Items(J.Get(J.Get(policy.Value, "models"), model)) {
                        if level.GetString() == effort {
                            policyEligible = true
                        }
                    }
                    var supported HashSet[string]
                    rejection = !policyEligible ? "Model/effort pair is not allowed by the repository policy.":
                    (
                        !capabilities.TryGetValue(model, out supported) || !supported.Contains(effort) ?
                        "Model/effort capability is not advertised by the offline native Codex catalog; availability is unknown.":
                        "Model is donor-reported unavailable."
                    )
                }
                if explicitPair && model != "" && effort != "" {
                    throw Exception(
                        rejection +
                            " Explicit donor choice required: --model MODEL --effort EFFORT. Eligible pairs: " +
                            String.Join(", ", choices.Keys) + ". No inference started."
                    )
                }
                if saved.ValueKind != JsonValueKind.Undefined {
                    reason = compatible ? "Saved default rejected: " + rejection:
                    "Saved default harness/provider does not match the selected codex/openai harness."
                }
                if !Interactive(args) {
                    throw Exception(
                        reason +
                            " Explicit donor choice required: --model MODEL --effort EFFORT. Eligible pairs: " +
                            String.Join(", ", choices.Keys) + ". No inference started."
                    )
                }
                Terminal.Message(reason + " Choose an eligible pair (availability unknown):", "yellow", true)
                let eligible = List[JsonElement](choices.Values)
                var index int32 = 1
                for label in choices.Keys {
                    Terminal.Message(index.ToString() + ") " + label, error: true)
                    index++
                }
                Console.Error.Write("Choice number (no default; blank cancels): ")
                var selected int32
                if !int32.TryParse(Console.ReadLine(), out selected) || selected < 1 || selected > eligible.Count {
                    throw Exception("Explicit donor choice was not supplied. No inference started.")
                }
                model = J.Text(eligible[selected - 1], "model")
                effort = J.Text(eligible[selected - 1], "effort")
                source = "interactive donor choice"
                availability = "unknown"
            }
            policy.Validate(model, effort, 1, false)
            return J.Parse(
                J.Write(
                    J.Map(
                        "harness",
                        harness,
                        "provider",
                        provider,
                        "model",
                        model,
                        "effort",
                        effort,
                        "source",
                        source,
                        "policy_hash",
                        policy.Digest,
                        "policy_eligible",
                        true,
                        "capability",
                        "compatible: native Codex explicit controls and offline bundled model/effort catalog",
                        "availability",
                        availability == "unknown" ? "unknown": "donor-reported " + availability,
                        "availability_evidence",
                        "No account availability probe; catalog presence, PATH and login do not prove availability"
                    )
                )
            )
        }

        internal func Confirm(args Args, selection JsonElement) {
            let source = J.Text(selection, "source")
            if args.Get("yes") == "true" || source == "explicit invocation" || source == "saved donor default" {
                return
            }
            if !Interactive(args) {
                throw Exception(
                    "Inference confirmation required for " + J.Text(selection, "model") + " / " + J.Text(
                        selection,
                        "effort"
                    ) +
                        ": pass --yes explicitly. No inference started."
                )
            }
            Console.Error.Write(
                "Use your Codex allowance with " + J.Text(selection, "harness") + "/" + J.Text(selection, "provider") +
                    ": " +
                    J.Text(selection, "model") + " / " + J.Text(selection, "effort") + " (" + J.Text(
                    selection,
                    "availability"
                ) +
                    ")? [y/N] "
            )
            if !String.Equals(Console.ReadLine(), "y", StringComparison.OrdinalIgnoreCase) {
                throw Exception("Inference was not confirmed. No inference started.")
            }
            args.Values["--yes"] = "true"
        }

        internal func Revalidate(run Data, policy Policy) {
            let selected = J.Get(run.Element(), "selection")
            if selected.ValueKind == JsonValueKind.Undefined {
                return
            }
            if J.Text(selected, "model") != run.Text("model") || J.Text(selected, "effort") != run.Text("effort") ||
                J.Text(selected, "harness") != run.Text("harness") || J.Text(selected, "provider") != run.Text(
                "provider"
            ) ||
                J.Text(selected, "policy_hash") != policy.Digest ||
                !ToolAllowed(policy, J.Text(selected, "harness"), J.Text(selected, "provider")) {
                throw Exception("Saved selection differs from run or policy; no model substitution is allowed")
            }
            policy.Validate(run.Text("model"), run.Text("effort"), run.Number("seconds"), run.Flag("network"))
            let capabilities = Capabilities()
            var supported HashSet[string]
            if !capabilities.TryGetValue(run.Text("model"), out supported) || !supported.Contains(run.Text("effort")) {
                throw Exception("Saved model/effort is no longer compatible with native Codex. No retry or fallback.")
            }
            if J.Text(selected, "availability") == "donor-reported unavailable" {
                throw Exception("Selected model is donor-reported unavailable. No retry or fallback.")
            }
        }
    }
}
