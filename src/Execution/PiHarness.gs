package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text.Json
import System.Text.RegularExpressions

internal class PiHarness {
    shared {
        private func Activity(line string) {
            let value = J.Parse(line)
            if J.Text(value, "type") != "pi.event" {
                return
            }
            let event = J.Text(value, "event")
            if event == "assistant_end" && J.Text(value, "text") != "" {
                DonationView.Append("Assistant: " + J.Text(value, "text"))
            } else if event == "tool_execution_start" {
                let args = J.Get(value, "args")
                let detail = J.Text(args, "command") == "" ? J.Text(args, "path"): J.Text(args, "command")
                DonationView.Append(J.Text(value, "tool") + ": " + detail)
            } else if event == "tool_execution_end" {
                for item in J.Items(J.Get(J.Get(value, "result"), "content")) {
                    if J.Text(item, "type") == "text" {
                        DonationView.Append(J.Text(item, "text"))
                    }
                }
                if J.Bool(value, "is_error") {
                    DonationView.Append("Tool failed: " + J.Text(value, "tool"))
                }
            } else if event == "compaction_end" || event == "length_continuation" {
                DonationView.Append(event == "compaction_end" ? "Context compacted": "Continuing truncated response")
            }
        }

        private func ManagedRuntime(cli string, args Args) string {
            let agent = Directory.GetParent(cli)?.Parent?.FullName ?? ""
            let markerPath = Path.Combine(agent, "install/managed-install.json")
            if cli != Path.Combine(agent, "bin/pi") ||
                (!File.Exists(markerPath) && FileInfo(markerPath).LinkTarget == nil) {
                let npm = LocalPaths.Find("npm")
                if npm != "" {
                    let result = Commands.Run(npm, []string{"root", "--global"}, seconds: 5)
                    let root = result.Output.Trim()
                    if result.Code == 0 && !result.Truncated && Path.IsPathFullyQualified(root) && File.Exists(
                        Path.Combine(root, "@earendil-works/pi-coding-agent/package.json")
                    ) {
                        return root
                    }
                }
                throw Exception(
                    "Cannot locate the Pi SDK from this launcher. Select its installed node_modules directory with --pi-root."
                )
            }
            let install = LocalPaths.DirectoryPath(Path.Combine(agent, "install"))
            let versionPath = Path.Combine(install, "current-version")
            if FileInfo(markerPath).LinkTarget != nil || FileInfo(versionPath).LinkTarget != nil {
                throw Exception("Pi installation metadata must be regular files")
            }
            let marker = RequestData.FileData(markerPath, 16384)
            let entrypoint = J.Get(marker, "entrypoint")
            let entryPath = J.Text(entrypoint, "path")
            if J.Text(marker, "kind") != "pi-managed-install" || J.Number(marker, "schemaVersion") != 1 || J.Text(
                marker,
                "layout"
            ) != "releases-v1" ||
                (J.Text(entrypoint, "type") != "script" && J.Text(entrypoint, "type") != "symlink") ||
                !Path.IsPathFullyQualified(entryPath) || LocalPaths.CanonicalPath(entryPath) != cli {
                throw Exception("Unsupported Pi installation metadata; provide --pi-root and --node explicitly")
            }
            if FileInfo(versionPath).Length < 1 || FileInfo(versionPath).Length > 128 {
                throw Exception("Invalid managed Pi version file")
            }
            let version = File.ReadAllText(versionPath)
            if !Regex.IsMatch(version, "^[A-Za-z0-9._+-]+\\r?\\n?\\z") || version.Trim() == "." ||
                version.Trim() == ".." {
                throw Exception("Invalid managed Pi version file")
            }
            if args.Get("node") == "" {
                var data = Environment.GetEnvironmentVariable("XDG_DATA_HOME") ?? ""
                if data == "" {
                    data = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        ".local/share"
                    )
                }
                let node = Path.Combine(data, "pi-node/current/bin/node")
                if Path.IsPathFullyQualified(data) && LocalPaths.Executable(node) {
                    args.Values["--node"] = node
                }
            }
            return Path.Combine(install, "releases", version.Trim(), "node_modules")
        }

        internal func Runtime(args Args) {
            if !OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.X64 || !File.Exists(
                "/usr/bin/bwrap"
            ) {
                throw Exception("Managed pi requires verified Linux x64 bubblewrap isolation; no host fallback")
            }
            if args.Get("harness-path") != "" && !LocalPaths.Executable(
                LocalPaths.RuntimePath(args.Need("harness-path"))
            ) {
                throw Exception("The selected Pi executable is missing or not executable; check --harness-path")
            }
            var root = args.Get("pi-root")
            if root == "" {
                let executable = LocalPaths.Harness("pi", args.Get("harness-path"))
                if executable == "" {
                    throw Exception("Install pi or supply --pi-root pointing to its existing node_modules directory")
                }
                if !LocalPaths.Executable(executable) {
                    throw Exception("The selected Pi executable is missing or not executable; check --harness-path")
                }
                let cli = LocalPaths.CanonicalPath(executable)
                let installedPackage = Directory.GetParent(cli)?.Parent?.Parent?.FullName ?? ""
                root = cli == Path.Combine(installedPackage, "dist/bundle/cli.js") && Path.GetFileName(
                    installedPackage
                ) == "pi-coding-agent" &&
                    Path.GetFileName(Path.GetDirectoryName(installedPackage) ?? "") == "@earendil-works" ?
                Path.GetDirectoryName(Path.GetDirectoryName(installedPackage) ?? "") ?? "":
                ManagedRuntime(cli, args)
            }
            root = LocalPaths.DirectoryPath(root)
            if Path.GetFileName(root) != "node_modules" {
                throw Exception("--pi-root must be an existing node_modules directory, not donor settings")
            }
            let packagePath = Path.Combine(root, "@earendil-works/pi-coding-agent")
            LocalPaths.DirectoryPath(packagePath)
            let metadata = RequestData.FileData(Path.Combine(packagePath, "package.json"), 128 * 1024)
            if J.Text(metadata, "name") != "@earendil-works/pi-coding-agent" || J.Text(metadata, "version") == "" ||
                !File
                .Exists(Path.Combine(packagePath, "dist/index.js")) {
                throw Exception("The installed pi SDK package layout is required")
            }
            let node = LocalPaths.CanonicalPath(args.Get("node") == "" ? LocalPaths.Find("node"): args.Need("node"))
            if !File.Exists(node) || !Path.IsPathFullyQualified(node) {
                throw Exception("An existing Node runtime is required; Tokate never installs one")
            }
            args.Values["--pi-root"] = root
            args.Values["--node"] = node
        }

        internal func Select(args Args, policy Policy, source string) JsonElement {
            if args.Need("provider") != "local-chat-completions" {
                throw Exception("Unsupported pi provider; only local-chat-completions is managed")
            }
            let model = RequestData.ModelIdentifier(args.Need("model"))
            let effort = args.Need("effort")
            policy.ValidatePi(model, effort, 1, false)
            let endpoint = PiBoundary.Endpoint(args.Need("endpoint"))
            if args.Get("availability") == "unavailable" {
                throw Exception("Selected model is donor-reported unavailable; no retry or fallback")
            }
            Runtime(args)
            PiBoundary.Probe(args.Need("pi-root"), args.Need("node"))
            let limits = PiBoundary.ModelSettings(args.Need("pi-root"), args.Need("node"), model, endpoint)
            PiBoundary.CheckEffort(limits, effort)
            let catalog = PiCatalog.Read(args.Need("node"), model, endpoint)
            return J.Parse(
                J.Write(
                    map[string, Object?]{
                        "harness": "pi",
                        "provider": "local-chat-completions",
                        "model": model,
                        "effort": effort,
                        "source": source,
                        "policy_hash": policy.Digest,
                        "policy_eligible": true,
                        "capability": "pi SDK model capabilities and isolated noninteractive session probe",
                        "availability": "advertised",
                        "availability_evidence": "Selected endpoint advertises the exact model ID; weights and coding capability are unverified",
                        "endpoint_catalog": catalog,
                        "context_window": J.Number(limits, "contextWindow"),
                        "max_tokens": J.Number(limits, "maxTokens")
                    }
                )
            )
        }

        internal func ValidateSaved(run Data, policy Policy) {
            policy.ValidatePi(run.Text("model"), run.Text("effort"), run.Number("seconds"), run.Flag("network"))
            PiBoundary.Endpoint(run.Text("pi_endpoint"))
            let args = Args(
                []string{"work", "--harness", "pi", "--pi-root", run.Text("pi_root"), "--node", run.Text("pi_node")}
            )
            Runtime(args)
            if args.Need("pi-root") != run.Text("pi_root") || args.Need("node") != run.Text("pi_node") {
                throw Exception("Saved pi runtime changed; no substitution")
            }
        }

        internal func Execute(directory string, run Data, record JsonElement, prompt string, continueTruncated bool) {
            if run.Number("version") != 2 || run.Text("source") != "tokate" || run.Number("preparation_version") != 1 {
                throw Exception("Managed pi requires a prepared version-2 contribution")
            }
            let continuationLimit = continueTruncated ? 1: 0
            let timer = Stopwatch.StartNew()
            let coding = RuntimeBudget(timer, run.Number("seconds") - run.Number("verification_reserve"))
            WorkspacePreparation.Ready(directory, run)
            let runtime = PiBoundary.Probe(run.Text("pi_root"), run.Text("pi_node"), coding)
            let endpoint = PiBoundary.Endpoint(run.Text("pi_endpoint"))
            let limits = PiBoundary.ModelSettings(
                run.Text("pi_root"),
                run.Text("pi_node"),
                run.Text("model"),
                endpoint,
                coding
            )
            PiBoundary.CheckEffort(limits, run.Text("effort"))
            let checkout = Path.Combine(directory, "checkout")
            let control = Path.Combine(directory, "pi-control-" + Guid.NewGuid().ToString("N"))
            try {
                PiBoundary.Control(control, run.Text("model"), endpoint, limits)
                let args = PiBoundary.Boundary(checkout, run.Text("pi_root"), run.Text("pi_node"), control, true)
                args.AddRange(
                    []string{
                        "/tokate-node",
                        "/tokate-control/bridge.mjs",
                        "run",
                        checkout,
                        run.Text("model"),
                        run.Flag("network") ? "true": "false",
                        "",
                        continueTruncated ? "true": "false",
                        run.Text("effort")
                    }
                )
                ContributionClaim.Recheck(run)
                WorkspacePreparation.Ready(directory, run)
                try {
                    run.Fields["failure_stage"] = "endpoint_check"
                    run.Fields["failure_reason"] = "endpoint_unavailable"
                    run.Fields["endpoint_catalog"] = PiCatalog.Read(
                        run.Text("pi_node"),
                        run.Text("model"),
                        endpoint,
                        coding
                    )
                    run.Fields["state"] = "running"
                    run.Fields["failure_stage"] = "inference"
                    run.Fields["failure_reason"] = "inference_failed"
                    run.Fields["pi_version"] = J.Text(runtime, "version")
                    run.Fields["observed_invocation"] = map[string, Object?]{
                        "harness": "pi",
                        "sdk_version": J.Text(runtime, "version"),
                        "node_version": J.Text(runtime, "node"),
                        "provider": "local-chat-completions",
                        "model": run.Text("model"),
                        "effort": run.Text("effort"),
                        "context_window": J.Number(limits, "contextWindow"),
                        "max_tokens": J.Number(limits, "maxTokens"),
                        "length_continuation_limit": continuationLimit
                    }
                    run.Save(directory)
                    if continueTruncated {
                        Terminal.Step("Pi may continue one truncated response within the original coding budget.")
                    }
                    PublicOutput.FailureCode = "inference_failed"
                    var result CommandResult
                    {
                        using let progress = TerminalProgress(
                            "Pi inference",
                            coding,
                            RuntimeBudget(timer, run.Flag("unlimited") ? 0: run.Number("seconds"))
                        )
                        var activity Action[string]? = nil
                        if DonationView.Active() {
                            activity = line -> Activity(line)
                        }
                        result = Commands.Run(
                            "/usr/bin/bwrap",
                            args.ToArray(),
                            checkout,
                            prompt,
                            run.Flag("unlimited") ? 0: run.Number("seconds"),
                            isolated: true,
                            cancellation: Chan[bool](1),
                            strictOutput: true,
                            outputPath: Path.Combine(directory, "events.jsonl"),
                            errorPath: Path.Combine(directory, "stderr.log"),
                            budget: coding,
                            pidNamespace: true,
                            outputLine: activity
                        )
                    }
                    run.Fields["output_truncated"] = result.OutputTruncated
                    run.Fields["error_truncated"] = result.ErrorTruncated
                    run.Fields["inference_exit_code"] = result.Code
                    if result.Code != 0 || result.Truncated || result.ReadFailed {
                        throw Exception(PiEvidence.Failure(result.Output))
                    }
                    let usage = PiEvidence.Completed(
                        directory,
                        result.Output,
                        run.Text("model"),
                        run.Text("effort"),
                        continuationLimit
                    )
                    run.Fields["turn_completed"] = true
                    run.Fields["usage"] = usage
                    run.Fields[
                        "usage_provenance"
                    ] = "harness-reported; server identity, resources and billing are not independently proven"
                    run.Fields["execution_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
                    run.Save(directory)
                    PublicOutput.FailureCode = "invalid_state"
                    Contribution.Finish(
                        directory,
                        run,
                        record,
                        usage,
                        timer,
                        run.Number("seconds"),
                        run.Number("verification_reserve")
                    )
                } catch (error Exception) {
                    if run.Text("failure_stage") == "inference" {
                        if let result = Commands.InterruptedResult(error) {
                            run.Fields["failure_reason"] = "inference_interrupted"
                            run.Fields["output_truncated"] = result.OutputTruncated
                            run.Fields["error_truncated"] = result.ErrorTruncated
                        }
                    }
                    run.Fields["state"] = "failed"
                    run.Fields["error"] = error.Message
                    run.Save(directory)
                    throw error
                }
            } finally {
                if Directory.Exists(control) {
                    Directory.Delete(control, true)
                }
            }
        }
    }
}
