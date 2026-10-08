package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class Worker {
    shared {
        internal func Config(args List[string], key string, value string) {
            args.Add("-c")
            args.Add(key + "=" + value)
        }

        internal func CodexPath(path string = "") string -> CodexRuntime.Resolve(path)

        internal func Run(
            directory string,
            args[]string,
            input string? = nil,
            seconds int32 = 60,
            capture bool = false,
            budget RuntimeBudget? = nil,
            harnessPath string = ""
        ) CommandResult {
            let codex = CodexPath(harnessPath)
            for path in[]string{
                directory,
                codex,
                Environment.GetEnvironmentVariable("HOME") ?? "",
                Environment.GetEnvironmentVariable("CODEX_HOME") ?? "",
                Environment.GetEnvironmentVariable("DOTNET_ROOT") ?? ""
            } {
                if path == "" || !Path.IsPathFullyQualified(path) {
                    continue
                }
                let canonical = path == codex ? codex: LocalPaths.CanonicalPath(path)
                if canonical == "/tmp" || canonical.StartsWith("/tmp/") {
                    throw CliFailure(
                        "verification_failed",
                        "Managed runs, harness homes, and tools must be outside /tmp. Move them before starting work."
                    )
                }
            }
            let wrapper = List[string]{
                "--die-with-parent",
                "--unshare-pid",
                "--bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--dir",
                "/tmp/tokate-home"
            }
            wrapper.AddRange([]string{"--chdir", directory, "--", codex})
            wrapper.AddRange(args)
            let cancellation Chan[bool]? = capture ? Chan[bool](1): nil
            var activity Action[string]? = nil
            if capture && DonationView.Active() {
                activity = line -> Activity(line)
            }
            return Commands.Run(
                "bwrap",
                wrapper.ToArray(),
                directory,
                input,
                seconds,
                true,
                cancellation: cancellation,
                outputPath: capture ? Path.Combine(directory, "events.jsonl"): "",
                errorPath: capture ? Path.Combine(directory, "stderr.log"): "",
                budget: budget,
                pidNamespace: true,
                outputLine: activity
            )
        }

        private func Activity(line string) {
            let value = J.Parse(line)
            let type = J.Text(value, "type")
            let item = J.Get(value, "item")
            let kind = J.Text(item, "type")
            if type == "item.completed" && kind == "agent_message" {
                DonationView.Append("Assistant: " + J.Text(item, "text"))
            } else if type == "item.started" && kind == "command_execution" {
                DonationView.Append("Run: " + J.Text(item, "command"))
            } else if type == "item.completed" && kind == "command_execution" {
                DonationView.Append(J.Text(item, "aggregated_output"))
                DonationView.Append(
                    "Command " + J.Text(item, "status") + " (exit " + J.Get(item, "exit_code").ToString() + ")"
                )
            } else if type == "item.completed" && kind == "file_change" {
                for change in J.Items(J.Get(item, "changes")) {
                    DonationView.Append(J.Text(change, "kind") + ": " + J.Text(change, "path"))
                }
            } else if type == "error" || type == "turn.failed" {
                DonationView.Append(
                    "Harness error: " + J.Text(value, "message") + J.Text(J.Get(value, "error"), "message")
                )
            }
        }

        internal func Filesystem(checkout string, gitRead bool = false, harnessPath string = "") string {
            let gitMode = gitRead ? "read": "deny"
            return "{ \":root\" = \"deny\", \":minimal\" = \"read\", \"/tmp\" = \"write\", " + J.Write(checkout) +
                " = \"write\", " +
                J.Write(Path.Combine(checkout, ".git")) + " = " + J.Write(gitMode) + ", " + J.Write(
                CodexPath(harnessPath)
            ) +
                " = \"read\" }"
        }

        internal func Probe(directory string, checkout string, harnessPath string = "") {
            let sentinel = Path.Combine(directory, "private-probe")
            let args = List[string]{"sandbox", "-P", "tokate", "--include-managed-config", "-C", checkout}
            var failure Exception? = nil
            try {
                File.WriteAllText(sentinel, "private")
                Config(args, "permissions.tokate.filesystem", Filesystem(checkout, harnessPath: harnessPath))
                Config(args, "permissions.tokate.network.enabled", "false")
                args.AddRange(
                    []string{
                        "--",
                        "/usr/bin/env",
                        "-i",
                        "PATH=/usr/local/bin:/usr/bin:/bin",
                        "HOME=/tmp/tokate-home",
                        "TMPDIR=/tmp/tokate-home",
                        "/bin/sh",
                        "-c",
                        "test ! -r \"$1\" && test ! -r .git/config && test \"$$HOME\" = /tmp/tokate-home && test \"$$TMPDIR\" = \"$$HOME\" && test ! -d \"$$HOME/.cache/browser\" && probe=$$(mktemp .tokate-probe.XXXXXX) && rm \"$$probe\" && touch /tmp/tokate-probe && mkdir -p \"$$HOME/.cache/browser\" && cache=$$(mktemp \"$$HOME/.cache/browser/tokate-cache.XXXXXX\") && test -z \"$$(find . -samefile \"$$cache\")\" && \"$2\" --version >/dev/null",
                        "probe",
                        sentinel,
                        CodexPath(harnessPath)
                    }
                )
                let result = Run(directory, args.ToArray(), harnessPath: harnessPath)
                if result.Code != 0 || result.Truncated || result.ReadFailed {
                    throw CliFailure(
                        "verification_failed",
                        "Managed sandbox isolation probe failed. Check bubblewrap user namespace support and native Codex permission profiles. Tokate does not change security settings."
                    )
                }
            } catch (error Exception) {
                failure = error
            }
            try {
                File.Delete(sentinel)
            } catch (error Exception) {
                if failure == nil {
                    failure = error
                }
            }
            if let error = failure {
                throw error
            }
            if File.Exists(Path.Combine(checkout, "global.json")) {
                args[args.Count - 4] = "dotnet msbuild -nologo -version"
                args[args.Count - 3] = "toolchain"
                try {
                    let toolchain = Run(directory, args.ToArray(), harnessPath: harnessPath)
                    if toolchain.Code != 0 || toolchain.Truncated || toolchain.ReadFailed {
                        throw Exception("Pinned SDK startup failed")
                    }
                } catch (error Exception) {
                    throw CliFailure(
                        "missing_tools",
                        "Pinned SDK/MSBuild startup failed. Install the global.json SDK in a standard system path; home-directory tools are unavailable."
                    )
                }
            }
        }

        internal func Doctor(harnessPath string = "") bool {
            let root = Path.Combine("/var/tmp", "tokate-doctor-" + Guid.NewGuid().ToString("N"))
            try {
                Directory.CreateDirectory(
                    root,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                )
            } catch (error Exception) {
                throw CliFailure(
                    "verification_failed",
                    "Cannot prepare the sandbox probe. Ensure /var/tmp exists and is writable."
                )
            }
            let checkout = Path.Combine(root, "checkout")
            try {
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                File.WriteAllText(Path.Combine(checkout, ".git", "config"), "private")
                let global = Path.Combine(Directory.GetCurrentDirectory(), "global.json")
                if FileInfo(global).LinkTarget != nil {
                    throw CliFailure(
                        "verification_failed",
                        "Repository global.json must be a regular file, not a symbolic link."
                    )
                }
                let pinned = File.Exists(global)
                if pinned {
                    File.Copy(global, Path.Combine(checkout, "global.json"))
                }
                Probe(root, checkout, harnessPath)
                return pinned
            } finally {
                Directory.Delete(root, true)
            }
        }

        internal func Execute(directory string, options Args) {
            using let lease = RunStorage.Lease(directory)
            let run = Data.Load(directory)
            if run.Number("version") != 2 || run.Text("source") != "tokate" {
                throw Exception("External work uses external --run; inference is never launched")
            }
            if run.Text("state") != "claimed" {
                throw CliFailure(
                    "invalid_state",
                    "This claim has already run. Use submit for publication, or request a new coding attempt."
                )
            }
            if (
                run.Fields.ContainsKey("codex_version") || run.Fields.ContainsKey("pi_version") || File.Exists(
                    Path.Combine(directory, "events.jsonl")
                ) ||
                    File.Exists(Path.Combine(directory, "report.md"))
            ) {
                throw Exception("This destination attempt already started execution; no second inference is allowed")
            }
            if options.Get("continue-truncated") == "true" && run.Text("harness") != "pi" {
                throw Exception("--continue-truncated requires managed Pi. No inference started.")
            }
            Terminal.Step("Checking owner approval and donor login...")
            let selected = J.Get(run.Element(), "selection")
            if selected.ValueKind != System.Text.Json.JsonValueKind.Undefined {
                if AttemptContinuation.Has(run) {
                    AttemptContinuation.Confirm(options, selected)
                } else {
                    DonorSelection.Confirm(options, selected)
                }
            }
            let record = ContributionClaim.Recheck(run)
            if selected.ValueKind != System.Text.Json.JsonValueKind.Undefined {
                let policy = Policy(J.Write(J.Get(record, "policy")))
                policy.Digest = run.Text("policy_hash")
                DonorSelection.Revalidate(run, policy)
            }
            RuntimeBudget.Validate(run)
            let prompt = TaskContext.Build(run, record)
            if run.Text("harness") == "pi" {
                PiHarness.Execute(directory, run, record, prompt, options.Get("continue-truncated") == "true")
                return
            }
            let harnessPath = run.Text("harness_path")
            if options.Get("harness-path") != "" && options.Get("harness-path") != harnessPath {
                throw Exception("The saved run fixes its harness path; use that path or start a fresh claim")
            }
            let login = Commands.Run(CodexPath(harnessPath), []string{"login", "status"}, harness: true)
            if login.Code != 0 || !(login.Output + login.Error).Contains("Logged in using ChatGPT") {
                throw CliFailure(
                    "authentication_required",
                    "Run codex login with your ChatGPT subscription first",
                    []string{"codex", "login"}
                )
            }
            let version = Commands.Checked(CodexPath(harnessPath), []string{"--version"}, harness: true)
            if !version.StartsWith("codex-cli ") {
                throw Exception("A supported Codex CLI is required")
            }
            let checkout = Path.Combine(directory, "checkout")
            WorkspacePreparation.Ready(directory, run)
            Probe(directory, checkout, harnessPath)
            let args = List[string]{
                "exec",
                "--strict-config",
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "--json",
                "--color",
                "never",
                "--cd",
                checkout,
                "--model",
                run.Text("model"),
                "--output-last-message",
                Path.Combine(directory, "report.md")
            }
            Config(args, "model_reasoning_effort", J.Write(run.Text("effort")))
            if selected.ValueKind != System.Text.Json.JsonValueKind.Undefined {
                Config(args, "model_provider", J.Write(J.Text(selected, "provider")))
            }
            Config(args, "approval_policy", "\"never\"")
            Config(args, "web_search", "\"disabled\"")
            Config(args, "allow_login_shell", "false")
            Config(args, "default_permissions", "\"tokate\"")
            Config(args, "permissions.tokate.filesystem", Filesystem(checkout, harnessPath: harnessPath))
            Config(args, "permissions.tokate.network.enabled", run.Flag("network") ? "true": "false")
            Config(args, "shell_environment_policy.inherit", "\"none\"")
            Config(
                args,
                "shell_environment_policy.set",
                "{ PATH = \"/usr/local/bin:/usr/bin:/bin\", HOME = \"/tmp/tokate-home\", TMPDIR = \"/tmp/tokate-home\" }"
            )
            Config(args, "skills.include_instructions", "false")
            Config(args, "features.skip_host_skill_discovery", "true")
            for feature in[]string{
                "apps",
                "plugins",
                "hooks",
                "codex_hooks",
                "plugin_hooks",
                "multi_agent",
                "multi_agent_v2",
                "shell_snapshot",
                "shell_snapshot_v2"
            } {
                Config(args, "features." + feature, "false")
            }
            args.Add("-")
            ContributionClaim.Recheck(run)
            WorkspacePreparation.Ready(directory, run)
            run.Fields["state"] = "running"
            run.Fields["failure_stage"] = "inference"
            run.Fields["failure_reason"] = "inference_failed"
            run.Fields["codex_version"] = version
            run.Save(directory)
            Terminal.Step(
                "Running " + run.Text("model") + " / " + run.Text("effort") + ": " + RuntimeBudget.Description(run) +
                    "..."
            )
            let timer = Stopwatch.StartNew()
            try {
                PublicOutput.FailureCode = "inference_failed"
                let coding = RuntimeBudget(timer, run.Number("seconds") - run.Number("verification_reserve"))
                var result CommandResult
                {
                    using let progress = TerminalProgress(
                        "Inference",
                        coding,
                        RuntimeBudget(timer, run.Flag("unlimited") ? 0: run.Number("seconds"))
                    )
                    result = Run(
                        directory,
                        args.ToArray(),
                        prompt,
                        run.Flag("unlimited") ? 0: run.Number("seconds"),
                        true,
                        coding,
                        harnessPath
                    )
                }
                run.Fields["output_truncated"] = result.OutputTruncated
                run.Fields["error_truncated"] = result.ErrorTruncated
                run.Fields["inference_exit_code"] = result.Code
                if result.Code != 0 {
                    run.Fields["failure_reason"] = "inference_failed"
                    run.Fields["failure_stage"] = "inference"
                    throw CliFailure("inference_failed", "Codex failed. Inspect the private stderr.log artifact.")
                }
                run.Fields["failure_reason"] = "incomplete_turn"
                run.Fields["failure_stage"] = "inference"
                if result.Truncated {
                    throw Exception("Codex output was truncated; no complete turn evidence")
                }
                let usage = CodexEvidence.CompletedUsage(directory, result.Output)
                run.Fields["turn_completed"] = true
                run.Fields["usage"] = usage
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
                if !run.Fields.ContainsKey("failure_reason") {
                    run.Fields["failure_reason"] = PublicOutput.FailureCode
                }
                run.Save(directory)
                throw error
            }
        }
    }
}
