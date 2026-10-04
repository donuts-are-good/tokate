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

        internal func CanonicalPath(path string, depth int32 = 0) string {
            if depth > 40 {
                throw Exception("Too many executable path symlinks")
            }
            let absolute = Path.GetFullPath(path)
            var result = Path.GetPathRoot(absolute) ?? "/"
            for part in absolute.Substring(result.Length).Split(Path.DirectorySeparatorChar) {
                let candidate = Path.Combine(result, part)
                if let link = File.ResolveLinkTarget(candidate, true) {
                    result = CanonicalPath(link.FullName, depth + 1)
                } else {
                    result = candidate
                }
            }
            return result
        }

        internal func CodexPath() string {
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if !Path.IsPathFullyQualified(entry) {
                    continue
                }
                let path = Path.Combine(entry, "codex")
                if File.Exists(path) {
                    return CanonicalPath(path)
                }
            }
            throw Exception("Install the Codex CLI first")
        }

        internal func Run(
            directory string,
            args[]string,
            input string? = nil,
            seconds int32 = 60,
            capture bool = false,
            budget RuntimeBudget? = nil
        ) CommandResult {
            for path in[]string{
                directory,
                CodexPath(),
                Environment.GetEnvironmentVariable("HOME") ?? "",
                Environment.GetEnvironmentVariable("CODEX_HOME") ?? "",
                Environment.GetEnvironmentVariable("DOTNET_ROOT") ?? ""
            } {
                if path == "" || !Path.IsPathFullyQualified(path) {
                    continue
                }
                let canonical = CanonicalPath(path)
                if canonical == "/tmp" || canonical.StartsWith("/tmp/") {
                    throw CliFailure(
                        "verification_failed",
                        "Managed runs, harness homes, and tools must be outside /tmp. Move them before starting work."
                    )
                }
            }
            let wrapper = List[string]{
                "--die-with-parent",
                "--bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--dir",
                "/tmp/tokate-home"
            }
            wrapper.AddRange([]string{"--chdir", directory, "--", CodexPath()})
            wrapper.AddRange(args)
            let cancellation Chan[bool]? = capture ? Chan[bool](1): nil
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
                budget: budget
            )
        }

        internal func Filesystem(checkout string, gitRead bool = false) string {
            let gitMode = gitRead ? "read": "deny"
            return "{ \":root\" = \"deny\", \":minimal\" = \"read\", \"/tmp\" = \"write\", " + J.Write(checkout) +
                " = \"write\", " +
                J.Write(Path.Combine(checkout, ".git")) + " = " + J.Write(gitMode) + ", " + J.Write(CodexPath()) +
                " = \"read\" }"
        }

        internal func Probe(directory string, checkout string) {
            let sentinel = Path.Combine(directory, "private-probe")
            File.WriteAllText(sentinel, "private")
            let args = List[string]{"sandbox", "-P", "tokate", "--include-managed-config", "-C", checkout}
            Config(args, "permissions.tokate.filesystem", Filesystem(checkout))
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
                    "test ! -r \"$1\" && test ! -r .git/config && test \"$$HOME\" = /tmp/tokate-home && test \"$$TMPDIR\" = \"$$HOME\" && test ! -d \"$$HOME/.cache/browser\" && probe=$$(mktemp .tokate-probe.XXXXXX) && rm \"$$probe\" && touch /tmp/tokate-probe && mkdir -p \"$$HOME/.cache/browser\" && cache=$$(mktemp \"$$HOME/.cache/browser/tokate-cache.XXXXXX\") && test -z \"$$(find . -samefile \"$$cache\")\"",
                    "probe",
                    sentinel
                }
            )
            let result = Run(directory, args.ToArray())
            File.Delete(sentinel)
            if result.Code != 0 || result.Truncated || result.ReadFailed {
                throw CliFailure(
                    "verification_failed",
                    "Managed sandbox isolation probe failed. Check bubblewrap user namespace support and native Codex permission profiles. Tokate does not change security settings."
                )
            }
            if File.Exists(Path.Combine(checkout, "global.json")) {
                args[args.Count - 3] = "dotnet msbuild -nologo -version"
                args[args.Count - 2] = "toolchain"
                try {
                    let toolchain = Run(directory, args.ToArray())
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

        internal func Doctor() bool {
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
                Probe(root, checkout)
                return pinned
            } finally {
                Directory.Delete(root, true)
            }
        }

        internal func Execute(directory string, options Args) {
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            if run.Number("version") == 2 && run.Text("source") != "tokate" {
                throw Exception("External work uses external --run; inference is never launched")
            }
            if run.Text("state") != "claimed" {
                throw CliFailure(
                    "invalid_state",
                    "This claim has already run. Use publish to retry publication, or request fresh approval for a new attempt."
                )
            }
            Terminal.Step("Checking owner approval and donor login...")
            let selected = J.Get(run.Element(), "selection")
            if selected.ValueKind != System.Text.Json.JsonValueKind.Undefined {
                DonorSelection.Confirm(options, selected)
            }
            let record = Workflow.Recheck(run)
            if selected.ValueKind != System.Text.Json.JsonValueKind.Undefined {
                let policy = Policy(J.Write(J.Get(record, "policy")))
                policy.Digest = run.Text("policy_hash")
                DonorSelection.Revalidate(run, policy)
            }
            RuntimeBudget.Validate(run)
            let prompt = TaskContext.Build(run, record)
            let login = Commands.Run("codex", []string{"login", "status"}, harness: true)
            if login.Code != 0 || !(login.Output + login.Error).Contains("Logged in using ChatGPT") {
                throw CliFailure(
                    "authentication_required",
                    "Run codex login with your ChatGPT subscription first",
                    []string{"codex", "login"}
                )
            }
            let version = Commands.Checked("codex", []string{"--version"}, harness: true)
            if !version.StartsWith("codex-cli 0.") {
                throw Exception("A supported Codex CLI is required")
            }
            let checkout = Path.Combine(directory, "checkout")
            if Directory.Exists(checkout) {
                throw Exception(
                    "Checkout already exists. Inspect this interrupted run before requesting fresh approval."
                )
            }
            Terminal.Step("Preparing isolated checkout...")
            Commands.Git(
                directory,
                "clone",
                "--quiet",
                "--no-checkout",
                "--template=",
                "--",
                "https://github.com/" + run.Text("repo") + ".git",
                checkout
            )
            if J.Get(J.Get(record, "approval"), "authority_branch").ValueKind != JsonValueKind.Undefined {
                Commands.Git(
                    checkout,
                    "fetch",
                    "--quiet",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "origin",
                    run.Text("base")
                )
            }
            Commands.Git(checkout, "checkout", "--quiet", "--detach", run.Text("base"))
            Commands.Git(checkout, "remote", "remove", "origin")
            for file in Commands.Git(checkout, "ls-files").Split('\n') {
                if file.StartsWith(".codex/") || file.Contains("/.codex/") {
                    throw Exception("Repository Codex configuration is not supported in donor runs")
                }
            }
            Probe(directory, checkout)
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
            Config(args, "permissions.tokate.filesystem", Filesystem(checkout))
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
                let result = Run(directory, args.ToArray(), prompt, run.Number("seconds"), true, coding)
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
                let usage = CompletedUsage(directory, result.Output)
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
                if !run.Fields.ContainsKey("failure_reason") {
                    run.Fields["failure_reason"] = PublicOutput.FailureCode
                }
                run.Save(directory)
                throw error
            }
        }

        internal func CompletedUsage(directory string, output string) Dictionary[string, Object?] {
            var completed bool
            var completions int32
            let usage = Dictionary[string, Object?]()
            for line in output.Split('\n') {
                if String.IsNullOrWhiteSpace(line) {
                    continue
                }
                let item = J.Parse(line)
                if J.Text(item, "type") == "turn.started" {
                    completed = false
                }
                if J.Text(item, "type") == "turn.failed" {
                    throw CliFailure("inference_failed", "Codex reported a failed turn")
                }
                if J.Text(item, "type") == "turn.completed" {
                    completed = true
                    completions++
                    for field in J.Get(item, "usage").EnumerateObject() {
                        usage[field.Name] = field.Value.Clone()
                    }
                }
            }
            let report = File.ReadAllText(Path.Combine(directory, "report.md"))
            if !completed || completions != 1 || String.IsNullOrWhiteSpace(report) {
                throw CliFailure("inference_failed", "Codex did not produce a completed turn and report")
            }
            return usage
        }
    }
}
