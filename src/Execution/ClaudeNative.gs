package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text.Json

internal class ClaudeNative {
    shared {
        internal let Version string = "2.1.258 (Claude Code)"
        internal let Checksum string = "704f1334ac65d3e89e1c6c1d7663293ad786a6166afdb71b5075337df630f976"
        internal let Model string = "claude-opus-4-6"

        internal func Pair(model string, effort string) {
            if model != Model || effort != "high" {
                throw CliFailure(
                    "unsupported_capability",
                    "Claude requires explicit claude-opus-4-6/high; xhigh maps to high and is unsupported."
                )
            }
        }

        internal func ManagedPolicyAbsent(path string = "/etc/claude-code") {
            try {
                let parent = Path.GetDirectoryName(path) ?? "/"
                for entry in Directory.EnumerateFileSystemEntries(parent) {
                    if Path.GetFileName(entry) == Path.GetFileName(path) {
                        throw CliFailure(
                            "unsupported_capability",
                            "Claude managed-policy presence is unsupported; no policy contents were read."
                        )
                    }
                }
            } catch (error CliFailure) {
                rethrow
            } catch (error Exception) {
                throw CliFailure(
                    "unsupported_capability",
                    "Cannot establish Claude managed-policy absence using metadata; no profile was exposed."
                )
            }
        }

        internal func Binary(path string) string {
            if !OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.X64 {
                throw CliFailure("unsupported_capability", "Native Claude capability checks require Linux x64.")
            }
            if path == "" {
                throw CliFailure(
                    "missing_tools",
                    "Native Claude Code 2.1.258 is missing; install it explicitly before checking capabilities."
                )
            }
            try {
                let absolute = LocalPaths.CanonicalPath(path)
                using let source = File.OpenRead(absolute)
                if source.Length != 215473560 || Convert.ToHexString(SHA256.HashData(source))
                    .ToLowerInvariant() != Checksum {
                    throw CliFailure(
                        "unsupported_capability",
                        "Claude binary differs from the official 2.1.258 linux-x64 release manifest."
                    )
                }
                return absolute
            } catch (error CliFailure) {
                rethrow
            } catch (error Exception) {
                throw CliFailure("missing_tools", "Cannot inspect the installed native Claude executable.")
            }
        }

        internal func Environment() Dictionary[string, string] {
            let result = Dictionary[string, string]()
            result["CLAUDE_CONFIG_DIR"] = "/tmp/tokate-home/.claude"
            result["CLAUDE_CODE_SAFE_MODE"] = "1"
            result["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
            result["CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL"] = "1"
            result["CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP"] = "1"
            result["CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK"] = "1"
            result["CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK"] = "1"
            result["CLAUDE_CODE_MAX_RETRIES"] = "0"
            result["CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES"] = "0"
            result["DISABLE_UPDATES"] = "1"
            return result
        }

        internal func Invocation(model string, effort string, commandNetwork bool)[]string {
            Pair(model, effort)
            let settings = J.Map(
                "disableAllHooks",
                true,
                "fallbackModel",
                []string{},
                "fastMode",
                false,
                "switchModelsOnFlag",
                false,
                "sandbox",
                J.Map(
                    "enabled",
                    true,
                    "failIfUnavailable",
                    true,
                    "allowUnsandboxedCommands",
                    false,
                    "excludedCommands",
                    []string{},
                    "network",
                    J.Map(
                        "allowedDomains",
                        commandNetwork ? []string{"*"}: []string{},
                        "allowLocalBinding",
                        false,
                        "strictAllowlist",
                        true
                    )
                )
            )
            return []string{
                "--restricted",
                "--safe-mode",
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
                "--settings",
                J.Write(settings),
                "--tools",
                "Read,Write,Edit,Bash",
                "--permission-mode",
                "acceptEdits",
                "--model",
                model,
                "--effort",
                effort,
                "--no-session-persistence",
                "--print",
                "--verbose",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json"
            }
        }

        internal func Authentication(value JsonElement) Dictionary[string, Object?] {
            if value.ValueKind != JsonValueKind.Object {
                throw CliFailure("authentication_required", "Claude authentication status has an unsupported schema.")
            }
            let seen = HashSet[string](StringComparer.Ordinal)
            for field in value.EnumerateObject() {
                if !seen.Add(field.Name) {
                    throw CliFailure("authentication_required", "Claude authentication status has duplicate fields.")
                }
            }
            let subscription = J.Text(value, "subscriptionType")
            if !J.Bool(value, "loggedIn") || J.Text(value, "authMethod") != "claude.ai" || J.Text(
                value,
                "apiProvider"
            ) != "firstParty" ||
                (subscription != "pro" && subscription != "max") {
                throw CliFailure(
                    "authentication_required",
                    "Claude requires a personal native claude.ai firstParty Pro/Max login; no credentials were retained."
                )
            }
            return J.Map(
                "loggedIn",
                true,
                "authMethod",
                "claude.ai",
                "apiProvider",
                "firstParty",
                "subscriptionType",
                subscription
            )
        }

        internal func Reports(output string, model string, effort string) List[Object] {
            Pair(model, effort)
            let reports = List[Object]()
            for line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries) {
                let value = J.Parse(line)
                ObjectSchema(value)
                let report = J.Map()
                for key in[]string{"model", "effort", "effortLevel", "permissionMode"} {
                    let field = J.Get(value, key)
                    if field.ValueKind == JsonValueKind.Undefined {
                        continue
                    }
                    let expected = key == "model" ? model: (key == "permissionMode" ? "acceptEdits": effort)
                    if field.ValueKind != JsonValueKind.String || field.GetString() != expected {
                        throw CliFailure(
                            "unsupported_capability",
                            "Native Claude reported a conflicting " + key + "; no retry or substitution is permitted."
                        )
                    }
                    report[key] = field
                }
                let models = J.Get(value, "modelUsage")
                if models.ValueKind != JsonValueKind.Undefined {
                    if models.ValueKind != JsonValueKind.Object {
                        throw CliFailure("unsupported_capability", "Native Claude modelUsage schema is unsupported.")
                    }
                    for entry in models.EnumerateObject() {
                        if entry.Name != model {
                            throw CliFailure(
                                "unsupported_capability",
                                "Native Claude reported usage for another model; no retry is permitted."
                            )
                        }
                    }
                    report["modelUsage"] = models
                }
                let usage = J.Get(value, "usage")
                if usage.ValueKind != JsonValueKind.Undefined {
                    report["usage"] = usage
                }
                let message = J.Get(value, "message")
                if message.ValueKind == JsonValueKind.Object {
                    let nested = Reports(J.Write(message), model, effort)
                    if nested.Count > 0 {
                        report["message"] = nested
                    }
                }
                if report.Count > 0 {
                    reports.Add(report)
                }
            }
            return reports
        }

        private func ObjectSchema(value JsonElement) {
            if value.ValueKind != JsonValueKind.Object {
                throw CliFailure("unsupported_capability", "Native Claude report schema is unsupported.")
            }
            let seen = HashSet[string](StringComparer.Ordinal)
            for field in value.EnumerateObject() {
                if !seen.Add(field.Name) {
                    throw CliFailure("unsupported_capability", "Native Claude report contains duplicate fields.")
                }
            }
        }

        internal func Interfaces(version CommandResult, help CommandResult, status CommandResult) Dictionary[
            string,
            Object?
        ] {
            if version.Code != 0 || version.Truncated || version.ReadFailed || version.Output.Trim() != Version {
                throw CliFailure(
                    "unsupported_capability",
                    "Installed Claude version/startup does not match the native pin."
                )
            }
            if help.Code != 0 || help.Truncated || help.ReadFailed {
                throw CliFailure("unsupported_capability", "Native Claude help could not be checked.")
            }
            for flag in[]string{
                "--restricted",
                "--safe-mode",
                "--model",
                "--effort",
                "--settings",
                "--tools",
                "--permission-mode",
                "--setting-sources",
                "--strict-mcp-config",
                "--mcp-config",
                "--no-session-persistence",
                "--input-format",
                "--output-format"
            } {
                if !help.Output.Contains(flag) {
                    throw CliFailure(
                        "unsupported_capability",
                        "Pinned native Claude lacks required interface " + flag + "."
                    )
                }
            }
            if status.Code != 1 || status.Truncated || status.ReadFailed {
                throw CliFailure(
                    "unsupported_capability",
                    "Synthetic native Claude auth status did not report an unauthenticated profile."
                )
            }
            let auth = J.Parse(status.Output)
            ObjectSchema(auth)
            if J.Get(auth, "loggedIn").ValueKind != JsonValueKind.False || J.Text(auth, "authMethod") != "none" {
                throw CliFailure(
                    "unsupported_capability",
                    "Synthetic native Claude authentication schema is unsupported."
                )
            }
            return J.Map(
                "version",
                Version,
                "interfaces_checked",
                true,
                "synthetic_unauthenticated_status_checked",
                true
            )
        }
    }
}
