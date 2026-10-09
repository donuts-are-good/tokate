package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class DonorSelection {
    shared {
        internal func Interactive(args Args) bool -> !PublicOutput.Enabled && args.Get("non-interactive") != "true" &&
            !Console.IsInputRedirected &&
            !Console.IsOutputRedirected &&
            !Console.IsErrorRedirected

        internal func Supported(value JsonElement) bool ->
        (J.Text(value, "harness") == "codex" && J.Text(value, "provider") == "openai") ||
            (J.Text(value, "harness") == "pi" && J.Text(value, "provider") == "local-chat-completions")

        internal func ApplyDefaults(args Args) {
            if args.Get("run") != "" || args.Get("source") == "external" ||
                (
                args.Command != "select" &&
                    args.Command != "claim" &&
                    args.Command != "work" &&
                    (args.Command != "prepare" || args.Get("source") != "tokate")
            ) {
                return
            }
            let profile = args.Get("profile")
            var saved JsonElement
            try {
                saved = DonorDefaults.Read(profile)
            } catch (error Exception) {
                if profile != "" {
                    throw Exception(
                        "Named donor profile is invalid, missing or inaccessible; use defaults read --profile NAME. No inference started."
                    )
                }
                return
            }
            args.SavedDefaults = saved
            let harness = J.Text(saved, "harness")
            let provider = J.Text(saved, "provider")
            let compatible = (args.Get("harness") == "" || args.Get("harness") == harness) &&
                (args.Get("provider") == "" || args.Get("provider") == provider)
            if compatible && harness != "" && J.Text(saved, "model") == "" && !Supported(saved) {
                throw Exception(
                    "The selected " +
                        harness +
                        " profile uses external work. Use that harness for external work or override --harness with a managed tool. No inference started."
                )
            }
            if !Supported(saved) || !compatible {
                if profile != "" {
                    throw Exception(
                        "Named donor profile conflicts with the selected managed harness/provider. No inference started."
                    )
                }
                return
            }
            for key in[]string{"harness", "provider", "endpoint", "pi-root", "node", "harness-path"} {
                if args.Get(key) == "" && J.Text(saved, key) != "" {
                    args.Values["--" + key] = J.Text(saved, key)
                }
            }
        }

        internal func Resolve(args Args, policy Policy) JsonElement {
            DonorDefaults.NormalizePair(args)
            let harness = args.Get("harness", "codex")
            let provider = args.Get("provider", "openai")
            if args.Get("continue-truncated") == "true" && harness != "pi" {
                throw Exception("--continue-truncated requires managed Pi. No inference started.")
            }
            if harness != "pi" && (args.Get("endpoint") != "" || args.Get("pi-root") != "" || args.Get("node") != "") {
                throw Exception("Pi runtime options require the pi harness")
            }
            if harness != "pi" && (harness != "codex" || provider != "openai") {
                throw Exception(
                    "Unsupported managed harness/provider: choose codex/openai explicitly. No inference started."
                )
            }
            if harness != "pi" && !policy.AllowsTool(harness, provider) {
                throw Exception(
                    "No eligible pair: codex/openai is rejected by current exact owner tool restrictions. No inference started."
                )
            }
            let saved = args.SavedDefaults
            var reason = "No usable saved default."
            let compatible = J.Text(saved, "harness") == harness && J.Text(saved, "provider") == provider
            var model = args.Get("model", compatible ? J.Text(saved, "model"): "")
            var effort = args.Get("effort", compatible ? J.Text(saved, "effort"): "")
            let explicitPair = args.Get("model") != "" || args.Get("effort") != ""
            var overridden = explicitPair
            for key in[]string{"endpoint", "pi-root", "node", "harness-path"} {
                overridden = overridden || (args.Get(key) != "" && args.Get(key) != J.Text(saved, key))
            }
            var source = args.Get("profile") != "" ? "saved donor profile " + args.Get("profile") +
                (overridden ? " with explicit overrides": ""): (
                explicitPair ? "explicit invocation": "saved donor default"
            )
            if harness == "pi" {
                if model != "" {
                    args.Values["--model"] = model
                }
                if effort != "" {
                    args.Values["--effort"] = effort
                }
                return PiHarness.Select(args, policy, source)
            }
            let capabilities = CodexRuntime.Capabilities(args.Get("harness-path"))
            var availability = args.Get("availability", "unknown")
            let unavailable = availability == "unavailable" ? model: ""
            let choices = SortedDictionary[string, JsonElement](StringComparer.Ordinal)
            for entry in capabilities {
                if entry.Key == unavailable {
                    continue
                }
                for candidateEffort in entry.Value {
                    if policy.Allows(entry.Key, candidateEffort) && policy.ManagedPair(entry.Key, candidateEffort) {
                        choices[entry.Key + " / " + candidateEffort] = J.Parse(
                            J.Write(map[string, Object?]{"model": entry.Key, "effort": candidateEffort})
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
                    var supported HashSet[string]
                    if !policy.ManagedPair(model, effort) {
                        rejection = "Tokate-managed execution requires a known model and supported effort control."
                    } else if !policy.Allows(model, effort) {
                        rejection = "Model/effort pair is not allowed by the repository policy."
                    } else if !capabilities.TryGetValue(model, out supported) || !supported.Contains(effort) {
                        rejection = "Model/effort capability is not advertised by the offline native Codex catalog; availability is unknown."
                    } else {
                        rejection = "Model is donor-reported unavailable."
                    }
                }
                if (explicitPair || args.Get("profile") != "") && model != "" && effort != "" {
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
                    map[string, Object?]{
                        "harness": harness,
                        "provider": provider,
                        "model": model,
                        "effort": effort,
                        "source": source,
                        "policy_hash": policy.Digest,
                        "policy_eligible": true,
                        "capability": "compatible: native Codex explicit controls and offline bundled model/effort catalog",
                        "availability": availability == "unknown" ? "unknown": "donor-reported " + availability,
                        "availability_evidence": "No account availability probe; catalog presence, PATH and login do not prove availability"
                    }
                )
            )
        }

        internal func Confirm(args Args, selection JsonElement) {
            if args.Guided && args.Get("yes") != "true" {
                Terminal.Heading(args.Command == "claim" ? "Confirm reservation request": "Confirm donation")
                Terminal.Row("Task", args.Need("repo") + " #" + args.Need("issue"))
                Terminal.Row("Tool", J.Text(selection, "harness") + " / " + J.Text(selection, "provider"))
                Terminal.Row("Model", J.Text(selection, "model") + " / " + J.Text(selection, "effort"))
                Terminal.Row(
                    "Budget",
                    (
                        args.Get("unlimited") == "true" ? "Unlimited coding; ": args.Need("seconds") +
                            " seconds total; "
                    ) +
                        args.Get("verification-reserve", "0") + " reserved for verification"
                )
                Terminal.Row("Command network", args.Get("allow-network") == "true" ? "allowed": "denied")
                Terminal.Row("Availability", J.Text(selection, "availability"))
                Console.Error.Write(
                    args.Command == "claim" ? "Post this claim without inference? [y/N] ": "Post this claim and start this donation when accepted? [y/N] "
                )
                if !String.Equals(Console.ReadLine(), "y", StringComparison.OrdinalIgnoreCase) {
                    throw Exception("Donation was not confirmed. No claim or inference was started.")
                }
                if args.Command == "work" {
                    args.Values["--yes"] = "true"
                }
                return
            }
            let source = J.Text(selection, "source")
            if args.Get("yes") == "true" ||
                source == "explicit invocation" ||
                source == "saved donor default" ||
                source.StartsWith("saved donor profile ") {
                return
            }
            let pair = J.Text(selection, "model") + " / " + J.Text(selection, "effort")
            if !Interactive(args) {
                throw Exception(
                    "Inference confirmation required for " + pair + ": pass --yes explicitly. No inference started."
                )
            }
            Console.Error.Write(
                "Use your Codex allowance with " + J.Text(selection, "harness") + "/" + J.Text(selection, "provider") +
                    ": " +
                    pair +
                    " (" +
                    J.Text(selection, "availability") + ")? [y/N] "
            )
            if !String.Equals(Console.ReadLine(), "y", StringComparison.OrdinalIgnoreCase) {
                throw Exception("Inference was not confirmed. No inference started.")
            }
            args.Values["--yes"] = "true"
        }

        internal func Revalidate(run Data, policy Policy) {
            let selected = J.Get(run.Element(), "selection")
            if selected.ValueKind != JsonValueKind.Object {
                throw Exception("Managed runs require saved selection metadata; start a fresh claim")
            }
            let harness = J.Text(selected, "harness")
            let provider = J.Text(selected, "provider")
            let failure = "Saved selection differs from run or policy; no model substitution is allowed"
            if J.Text(selected, "model") != run.Text("model") || J.Text(selected, "effort") != run.Text("effort") {
                throw Exception(failure)
            }
            if harness != run.Text("harness") || provider != run.Text("provider") {
                throw Exception(failure)
            }
            if harness == "pi" {
                if run.Number("version") != 2 || provider != "local-chat-completions" || J.Text(
                    selected,
                    "policy_hash"
                ) != policy.Digest {
                    throw Exception(failure)
                }
                PiHarness.ValidateSaved(run, policy)
                return
            }
            if J.Text(selected, "policy_hash") != policy.Digest ||
                harness != "codex" ||
                provider != "openai" ||
                (!policy.AllowsTool(harness, provider)) {
                throw Exception(failure)
            }
            policy.Validate(run.Text("model"), run.Text("effort"), run.Number("seconds"), run.Flag("network"))
            let capabilities = CodexRuntime.Capabilities(run.Text("harness_path"))
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
