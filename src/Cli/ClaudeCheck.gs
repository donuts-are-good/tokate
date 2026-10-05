package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO

internal class ClaudeCheck {
    shared {
        private func Probe(root string, binary string, args[]string, budget RuntimeBudget) CommandResult {
            let command = List[string]{"/opt/tokate-claude", "--restricted", "--safe-mode"}
            command.AddRange(args)
            return Verification.Run(root, command.ToArray(), false, 10, budget: budget, nativeExecutable: binary)
        }

        internal func Check(options Args) int32 {
            PublicOutput.ResultData = J.Map(
                "managed_execution_enabled",
                false,
                "requested",
                J.Map("model", options.Get("model"), "effort", options.Get("effort"))
            )
            ClaudeNative.Pair(options.Get("model"), options.Get("effort"))
            let binary = ClaudeNative.Binary(options.Get("binary", Startup.Find("claude")))
            ClaudeNative.ManagedPolicyAbsent()
            let root = Path.Combine(Path.GetTempPath(), "tokate-claude-check-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(
                Path.Combine(root, ".git"),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            let budget = RuntimeBudget(Stopwatch.StartNew(), 30)
            try {
                let version = Probe(root, binary, []string{"--version"}, budget)
                let help = Probe(root, binary, []string{"--help"}, budget)
                let auth = Probe(root, binary, []string{"auth", "status", "--json"}, budget)
                let result = ClaudeNative.Interfaces(version, help, auth)
                result["binary_sha256"] = ClaudeNative.Checksum
                result["observed_invocations"] = []([]string){
                    []string{"/opt/tokate-claude", "--restricted", "--safe-mode", "--version"},
                    []string{"/opt/tokate-claude", "--restricted", "--safe-mode", "--help"},
                    []string{"/opt/tokate-claude", "--restricted", "--safe-mode", "auth", "status", "--json"}
                }
                result["requested"] = J.Map("model", options.Get("model"), "effort", options.Get("effort"))
                result["configured_invocation"] = ClaudeNative.Invocation(
                    options.Get("model"),
                    options.Get("effort"),
                    false
                )
                result["managed_execution_enabled"] = false
                result["unproven"] = []string{
                    "sole-use native-login profile boundary",
                    "authenticated repository file tools and helpers",
                    "independent provider/command network boundary",
                    "effective model/effort and permission mode",
                    "native lifecycle and cleanup"
                }
                PublicOutput.ResultData = result
                if !PublicOutput.Enabled {
                    Terminal.Json(J.Parse(J.Write(result)), "Native Claude capabilities")
                }
                throw CliFailure(
                    "unsupported_capability",
                    "No-inference interfaces checked; managed Claude inference remains disabled because required runtime capabilities are unproven."
                )
            } finally {
                Directory.Delete(root, true)
            }
        }
    }
}
