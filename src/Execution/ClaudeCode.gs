package Tokate

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class ClaudeCode {
    shared {
        internal let Model string = "claude-opus-4-6"
        internal let Effort string = "high"

        internal func Choice(model string, effort string) {
            if model != Model || effort != Effort {
                throw Exception(
                    "Claude capability checks require explicit claude-opus-4-6/high; xhigh maps to high and is unsupported. No inference started."
                )
            }
        }

        internal func ManagedPolicy() {
            let status = [256]byte
            if RuntimeMetadataStat(-100, "/etc/claude-code", 256, 1, status) == 0 {
                throw Exception(
                    "Claude managed-policy presence is unsupported; no policy contents were read and no profile was exposed."
                )
            }
            if Marshal.GetLastPInvokeError() != 2 {
                throw Exception("Cannot inspect Claude managed-policy metadata; no profile was exposed.")
            }
        }

        private func EnvironmentProfile() {
            for key in Environment.GetEnvironmentVariables().Keys {
                let name = key.ToString() ?? ""
                if name.StartsWith("ANTHROPIC_") || name.StartsWith("CLAUDE_CODE_USE_") ||
                    name == "CLAUDE_CODE_OAUTH_TOKEN" ||
                    name == "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ||
                    name == "CLAUDE_CONFIG_DIR" ||
                    name.StartsWith("AWS_") || name.StartsWith("GOOGLE_") || name.StartsWith("AZURE_") {
                    throw Exception(
                        "API, environment-token, cloud and mixed Claude profiles are unsupported. Use a sole-use native-login profile in a clean environment."
                    )
                }
            }
        }

        private func Profile(path string) string {
            let profile = LocalPaths.DirectoryPath(path)
            if (
                File.GetUnixFileMode(profile) & (
                    UnixFileMode.GroupRead | UnixFileMode.GroupWrite |
                    UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherWrite |
                    UnixFileMode.OtherExecute
                )
            ) != 0 {
                throw Exception("Claude requires a private sole-use native-login profile directory.")
            }
            var count int32
            for entry in Directory.EnumerateFileSystemEntries(profile) {
                count++
                let name = Path.GetFileName(entry)
                let status = [256]byte
                if count > 64 || RuntimeMetadataStat(-100, entry, 256, 1, status) != 0 {
                    throw Exception("Cannot inspect Claude profile metadata; no profile was exposed.")
                }
                let kind = BitConverter.ToUInt16(status, 28) & 61440
                if ((name == ".credentials.json" || name == ".claude.json") && kind == 32768) ||
                    ((name == "backups" || name == "debug") && kind == 16384) {
                    continue
                }
                throw Exception(
                    "Claude profile contains unsupported configuration or reuse metadata; settings and credential contents were not inspected."
                )
            }
            return profile
        }

        internal func Authentication(value JsonElement) JsonElement {
            if J.Get(value, "loggedIn").ValueKind != JsonValueKind.True || J.Text(value, "authMethod") != "claude.ai" ||
                J.Text(value, "apiProvider") != "firstParty" ||
                (J.Text(value, "subscriptionType") != "pro" && J.Text(value, "subscriptionType") != "max") {
                throw Exception(
                    "Claude requires loggedIn true, claude.ai, firstParty and personal pro or max status. No inference started."
                )
            }
            return J.Parse(J.Write(J.Select(value, "loggedIn,authMethod,apiProvider,subscriptionType")))
        }

        internal func EnvironmentControls() Dictionary[string, string] -> map[string, string]{
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1",
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
            "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
            "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1",
            "CLAUDE_CODE_DISABLE_FAST_MODE": "1",
            "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK": "1",
            "CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK": "1",
            "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
            "CLAUDE_CODE_MAX_RETRIES": "0",
            "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES": "0",
            "DISABLE_COMPACT": "1"
        }

        internal func Settings(network bool) JsonElement -> J.Parse(
            J.Write(
                map[string, Object?]{
                    "disableAllHooks": true,
                    "autoMemoryEnabled": false,
                    "fastMode": false,
                    "ultracode": false,
                    "switchModelsOnFlag": false,
                    "fallbackModel": []string{},
                    "modelOverrides": map[string, Object?]{},
                    "availableModels": []string{Model},
                    "sandbox": map[string, Object?]{
                        "enabled": true,
                        "failIfUnavailable": true,
                        "allowUnsandboxedCommands": false,
                        "autoAllowBashIfSandboxed": false,
                        "excludedCommands": []string{},
                        "filesystem": map[string, Object?]{
                            "denyRead": []string{"//tokate-profile", "//tokate-control", "//tmp/tokate-agent"},
                            "denyWrite": []string{"//tokate-profile", "//tokate-control", "//tmp/tokate-agent"}
                        },
                        "network": map[string, Object?]{
                            "allowedDomains": network ? []string{"*"}: []string{},
                            "strictAllowlist": true,
                            "allowLocalBinding": false,
                            "allowAllUnixSockets": false
                        }
                    }
                }
            )
        )

        internal func Invocation(model string, effort string, network bool)[]string {
            Choice(model, effort)
            return []string{
                "--restricted",
                "--safe-mode",
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
                "--disable-slash-commands",
                "--no-chrome",
                "--tools",
                "Read,Write,Edit,Bash",
                "--allowedTools",
                "Read,Write,Edit,Bash",
                "--permission-mode",
                "default",
                "--permission-prompts",
                "none",
                "--settings",
                Settings(network).GetRawText(),
                "--model",
                model,
                "--effort",
                effort,
                "--no-session-persistence",
                "--output-format",
                "stream-json",
                "--verbose",
                "--print"
            }
        }

        internal func Boundary(binary string, profile string, checkout string)[]string {
            ManagedPolicy()
            let repository = LocalPaths.DirectoryPath(checkout)
            for path in[]string{binary, profile} {
                if path == repository || path.StartsWith(repository + "/") || repository.StartsWith(path + "/") {
                    throw Exception("Claude runtime and profile must be outside the selected checkout.")
                }
            }
            let boundary = ClaudeBoundary.Start(true, "/tmp/tokate-agent", "/tmp/tokate-tools")
            for entry in EnvironmentControls() {
                boundary.AddRange([]string{"--setenv", entry.Key, entry.Value})
            }
            boundary.AddRange(
                []string{
                    "--setenv",
                    "CLAUDE_CONFIG_DIR",
                    "/tokate-profile",
                    "--ro-bind",
                    binary,
                    "/tokate-runtime/claude",
                    "--bind",
                    profile,
                    "/tokate-profile"
                }
            )
            ClaudeBoundary.Repository(boundary, repository)
            boundary.AddRange([]string{"--", "/tokate-runtime/claude"})
            return boundary.ToArray()
        }

        private func Native(binary string, profile string, args[]string, budget RuntimeBudget) CommandResult {
            ManagedPolicy()
            let boundary = ClaudeBoundary.Start(false, "/tmp/tokate-agent", "/tmp/tokate-tools")
            for entry in EnvironmentControls() {
                boundary.AddRange([]string{"--setenv", entry.Key, entry.Value})
            }
            boundary.AddRange(
                []string{
                    "--setenv",
                    "CLAUDE_CONFIG_DIR",
                    "/tokate-profile",
                    "--ro-bind",
                    binary,
                    "/tokate-runtime/claude",
                    "--bind",
                    profile,
                    "/tokate-profile",
                    "--dir",
                    "/tmp/standalone",
                    "--chdir",
                    "/tmp/standalone",
                    "--",
                    "/tokate-runtime/claude"
                }
            )
            boundary.AddRange(args)
            return Commands.Run(
                "/usr/bin/bwrap",
                boundary.ToArray(),
                seconds: 30,
                isolated: true,
                strictOutput: true,
                budget: budget,
                pidNamespace: true,
                cancellation: Gsharp.Concurrency.Chan[bool](1)
            )
        }

        internal func Reports(text string) JsonElement {
            let reports = map[string, Object?]{}
            for line in text.Split('\n') {
                if String.IsNullOrWhiteSpace(line) {
                    continue
                }
                let value = RequestData.Parse(line, 1024 * 1024)
                let type = J.Text(value, "type")
                if type == "system" && J.Text(value, "subtype") == "init" {
                    ReportField(reports, value, "model", Model)
                    ReportField(reports, value, "permissionMode", "default")
                    ReportField(reports, value, "effort", Effort)
                    ReportField(reports, value, "effortLevel", Effort)
                }
                if type == "assistant" {
                    ReportField(reports, J.Get(value, "message"), "model", Model)
                }
                if type == "result" {
                    ReportField(reports, value, "model", Model)
                    ReportField(reports, value, "effort", Effort)
                    ReportField(reports, value, "effortLevel", Effort)
                    let usage = J.Get(value, "usage")
                    if usage.ValueKind == JsonValueKind.Object {
                        reports["usage"] = NumericUsage(usage)
                    }
                    let models = J.Get(value, "modelUsage")
                    if models.ValueKind == JsonValueKind.Object {
                        for model in models.EnumerateObject() {
                            if model.Name != Model {
                                throw Exception(
                                    "Claude reported a conflicting usage model; no retry or fallback is allowed."
                                )
                            }
                            reports["model_usage"] = NumericUsage(model.Value)
                        }
                    }
                }
            }
            return J.Parse(J.Write(reports))
        }

        private func ReportField(reports Dictionary[string, Object?], value JsonElement, key string, expected string) {
            let field = J.Get(value, key)
            if field.ValueKind != JsonValueKind.Undefined {
                if field.ValueKind != JsonValueKind.String || field.GetString() != expected {
                    throw Exception("Claude reported conflicting " + key + "; no retry or fallback is allowed.")
                }
                reports[key] = expected
            }
        }

        private func NumericUsage(value JsonElement) JsonElement {
            let result = map[string, Object?]{}
            for key in[]string{
                "input_tokens",
                "output_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
                "costUSD"
            } {
                let field = J.Get(value, key)
                if field.ValueKind == JsonValueKind.Number && field.GetDouble() >= 0 {
                    result[key] = field
                }
            }
            return J.Parse(J.Write(result))
        }

        private func Report(path string, profile string) string {
            let full = Path.GetFullPath(path)
            LocalPaths.DirectoryPath(Path.GetDirectoryName(full) ?? "/")
            let metadata = [256]byte
            if full == profile || full.StartsWith(profile + "/") ||
                RuntimeMetadataStat(-100, full, 256, 1, metadata) != 0 ||
                (BitConverter.ToUInt16(metadata, 28) & 61440) != 32768 {
                throw Exception(
                    "Claude native report must be a regular unlinked file outside the native-login profile."
                )
            }
            let descriptor = RuntimeMetadataOpen(full, 131072 | 2048 | 524288)
            if descriptor < 0 {
                throw Exception("Cannot safely open Claude native report.")
            }
            using let handle = SafeFileHandle(IntPtr(descriptor), true)
            using let file = FileStream(handle, FileAccess.Read)
            if !file.CanSeek {
                throw Exception("Claude native report must be a regular file.")
            }
            using let reader = BinaryReader(file)
            let bytes = reader.ReadBytes(1024 * 1024 + 1)
            if bytes.Length > 1024 * 1024 {
                throw Exception("Claude native report exceeds 1 MiB.")
            }
            return UTF8Encoding(false, true).GetString(bytes)
        }

        internal func Gate(args Args) JsonElement {
            Choice(args.Need("model"), args.Need("effort"))
            ManagedPolicy()
            EnvironmentProfile()
            if args.Get("sole-use") != "true" {
                throw Exception(
                    "Confirm a clean sole-use native-login profile with --sole-use; mixed profile reuse is unsupported."
                )
            }
            if System
                .Runtime
                .InteropServices
                .RuntimeInformation
                .ProcessArchitecture != Architecture.X64 ||
                !File.Exists("/usr/bin/bwrap") || !File.Exists("/usr/bin/setsid") || !File.Exists("/usr/bin/socat") {
                throw Exception(
                    "Claude capability checks require Linux x64, bubblewrap, socat and setsid; no host fallback or installation."
                )
            }
            let binary = LocalPaths.CanonicalPath(args.Need("claude"))
            if !CodexRuntime.Native(binary) {
                throw Exception(
                    "Claude requires an installed unmodified native Linux x64 executable; launchers are unsupported."
                )
            }
            let profile = Profile(args.Need("claude-profile"))
            let budget = RuntimeBudget(System.Diagnostics.Stopwatch.StartNew(), 90)
            let version = Native(binary, profile, []string{"--restricted", "--safe-mode", "--version"}, budget)
            if version.Code != 0 || version.Truncated || version.ReadFailed || !Regex.IsMatch(
                version.Output.Trim(),
                "^[0-9]+\\.[0-9]+\\.[0-9]+ \\(Claude Code\\)\\z"
            ) {
                throw Exception("Claude native version interface failed; no inference started.")
            }
            let help = Native(binary, profile, []string{"--restricted", "--safe-mode", "--help"}, budget)
            let required = []string{
                "--restricted",
                "--safe-mode",
                "--setting-sources",
                "--strict-mcp-config",
                "--mcp-config",
                "--disable-slash-commands",
                "--no-chrome",
                "--tools",
                "--allowedTools",
                "--permission-mode",
                "--permission-prompts",
                "--settings",
                "--model",
                "--effort",
                "--no-session-persistence",
                "--output-format",
                "--verbose",
                "--print"
            }
            if help.Code != 0 || help.Truncated || help.ReadFailed {
                throw Exception("Claude native help interface failed; no inference started.")
            }
            for flag in required {
                if !Regex.IsMatch(help.Output, "(?m)^ {0,4}(?:-[A-Za-z], *)?" + Regex.Escape(flag) + "(?:[ ,<]|$)") {
                    throw Exception("Claude is missing required native control " + flag + "; no inference started.")
                }
            }
            let status = Native(
                binary,
                profile,
                []string{"--restricted", "--safe-mode", "auth", "status", "--json"},
                budget
            )
            if status.Code != 0 || status.Truncated || status.ReadFailed {
                throw Exception("Claude standalone restricted safe-mode auth status failed; no inference started.")
            }
            let authentication = Authentication(RequestData.Parse(status.Output, 16384))
            let environment = List[string]()
            for entry in EnvironmentControls() {
                environment.Add(entry.Key + "=" + entry.Value)
            }
            let result = map[string, Object?]{
                "version": version.Output.Trim(),
                "auth_status": authentication,
                "requested": map[string, Object?]{"model": Model, "effort": Effort},
                "invocation": Invocation(Model, Effort, args.Get("allow-network") == "true"),
                "environment_controls": environment,
                "required_interfaces": required,
                "managed_execution_enabled": false,
                "limitations": []string{
                    "Interfaces and local authentication schema only; remote entitlement, availability and effective controls are unproven.",
                    "Managed Claude execution remains disabled pending whole-process, credential and command-network evidence and the workflow adapter."
                }
            }
            if args.Get("path") != "" {
                result["configured_boundary"] = Boundary(binary, profile, args.Need("path"))
            }
            if args.Get("file") != "" {
                result["native_reports"] = Reports(Report(args.Need("file"), profile))
            }
            return J.Parse(J.Write(result))
        }
    }
}
