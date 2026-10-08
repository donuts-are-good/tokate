package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text.Json

internal class PiHarness {
    shared {
        internal func Runtime(args Args) {
            if !OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.X64 || !File.Exists(
                "/usr/bin/bwrap"
            ) {
                throw Exception("Managed pi requires verified Linux x64 bubblewrap isolation; no host fallback")
            }
            var root = args.Get("pi-root")
            if root == "" {
                let executable = Startup.Find("pi")
                if executable == "" {
                    throw Exception("Install pi or supply --pi-root pointing to its existing node_modules directory")
                }
                let cli = LocalPaths.CanonicalPath(executable)
                let installedPackage = Directory.GetParent(cli)?.Parent?.Parent?.FullName ?? ""
                if cli != Path.Combine(installedPackage, "dist/bundle/cli.js") || Path.GetFileName(
                    installedPackage
                ) != "pi-coding-agent" ||
                    Path.GetFileName(Path.GetDirectoryName(installedPackage) ?? "") != "@earendil-works" {
                    throw Exception(
                        "Unsupported pi executable layout; provide the installed node_modules directory explicitly"
                    )
                }
                root = Path.GetDirectoryName(Path.GetDirectoryName(installedPackage) ?? "") ?? ""
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
            let node = LocalPaths.CanonicalPath(args.Get("node") == "" ? Startup.Find("node"): args.Need("node"))
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
            let limits = PiBoundary.ModelLimits(args.Need("pi-root"), args.Need("node"), model, endpoint)
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
                        "capability": "pi SDK import and isolated noninteractive session probe; absent effort only",
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
            Preparation.Ready(directory, run)
            let runtime = PiBoundary.Probe(run.Text("pi_root"), run.Text("pi_node"), coding)
            let endpoint = PiBoundary.Endpoint(run.Text("pi_endpoint"))
            let limits = PiBoundary.ModelLimits(
                run.Text("pi_root"),
                run.Text("pi_node"),
                run.Text("model"),
                endpoint,
                coding
            )
            let checkout = Path.Combine(directory, "checkout")
            let control = Path.Combine(directory, "pi-control-" + Guid.NewGuid().ToString("N"))
            try {
                PiBoundary.Control(
                    control,
                    run.Text("model"),
                    endpoint,
                    J.Number(limits, "contextWindow"),
                    J.Number(limits, "maxTokens")
                )
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
                        continueTruncated ? "true": "false"
                    }
                )
                ContributionClaim.Recheck(run)
                Preparation.Ready(directory, run)
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
                        "effort": "absent",
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
                            RuntimeBudget(timer, run.Number("seconds"))
                        )
                        result = Commands.Run(
                            "/usr/bin/bwrap",
                            args.ToArray(),
                            checkout,
                            prompt,
                            run.Number("seconds"),
                            isolated: true,
                            cancellation: Chan[bool](1),
                            strictOutput: true,
                            outputPath: Path.Combine(directory, "events.jsonl"),
                            errorPath: Path.Combine(directory, "stderr.log"),
                            budget: coding,
                            pidNamespace: true
                        )
                    }
                    run.Fields["output_truncated"] = result.OutputTruncated
                    run.Fields["error_truncated"] = result.ErrorTruncated
                    run.Fields["inference_exit_code"] = result.Code
                    if result.Code != 0 || result.Truncated || result.ReadFailed {
                        throw Exception(PiEvidence.Failure(result.Output))
                    }
                    let usage = PiEvidence.Completed(directory, result.Output, run.Text("model"), continuationLimit)
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
                        if error is CommandInterrupted interrupted {
                            run.Fields["failure_reason"] = "inference_interrupted"
                            run.Fields["output_truncated"] = interrupted.Result.OutputTruncated
                            run.Fields["error_truncated"] = interrupted.Result.ErrorTruncated
                        }
                        if error is CommandInputInterrupted interruptedInput {
                            run.Fields["failure_reason"] = "inference_interrupted"
                            run.Fields["output_truncated"] = interruptedInput.Result.OutputTruncated
                            run.Fields["error_truncated"] = interruptedInput.Result.ErrorTruncated
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
