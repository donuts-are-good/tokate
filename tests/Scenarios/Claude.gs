package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class ClaudeChecks {
    shared {
        internal func All(binary string) {
            using let data = Temp()
            data.Tool("claude")
            let profile = Path.Combine(data.Root, "profile")
            Directory.CreateDirectory(
                profile,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            let mode = Path.Combine(profile, ".claude.json")
            let statusPath = Path.Combine(profile, ".credentials.json")
            File.WriteAllText(mode, "normal")
            let status = Check.Map(
                "loggedIn",
                true,
                "authMethod",
                "claude.ai",
                "apiProvider",
                "firstParty",
                "subscriptionType",
                "pro",
                "orgId",
                "PRIVATE_ORG",
                "orgName",
                "PRIVATE_NAME"
            )
            let words = []string{
                "claude-capabilities",
                "--claude",
                Path.Combine(data.Root, "bin/claude"),
                "--claude-profile",
                profile,
                "--sole-use",
                "--model",
                "claude-opus-4-6",
                "--effort",
                "high",
                "--json"
            }
            for plan in[]string{"pro", "max"} {
                status["subscriptionType"] = JsonValue.Create(plan)
                File.WriteAllText(statusPath, status.ToJsonString())
                let result = TestProcess.Run(binary, words, data.Env)
                let value = Check.Envelope(result, "claude-capabilities", "ok")["data"] ??
                    throw Exception("Missing gate data")
                Check.That(
                    value["auth_status"]?.AsObject().Count == 4 && Check.Text(
                        value["auth_status"]?["subscriptionType"]
                    ) == plan,
                    "Auth status did not retain exactly the four approved fields"
                )
                Check.That(
                    !result.Output.Contains("PRIVATE_") && Check.Text(value["managed_execution_enabled"]) == "false",
                    "Gate leaked organization metadata or enabled inference"
                )
                Check.That(
                    Check.Text(value["version"]) == "100.0.0 (Claude Code)",
                    "Gate pinned an exact native version"
                )
                Check.Contains(value["invocation"]?.ToJsonString() ?? "", "claude-opus-4-6")
                Check.That(value["native_reports"] == nil, "Gate invented native reports")
            }
            for pair in[]string{
                "loggedIn=false",
                "loggedIn=true",
                "authMethod=oauth_token",
                "authMethod=api_key",
                "apiProvider=bedrock",
                "subscriptionType=team",
                "subscriptionType=enterprise",
                "subscriptionType=free"
            } {
                let rejected = status.DeepClone()
                let parts = pair.Split('=')
                rejected[parts[0]] = parts[1] == "false" ? JsonValue.Create(false): JsonValue.Create(parts[1])
                File.WriteAllText(statusPath, rejected.ToJsonString())
                let result = TestProcess.Run(binary, words, data.Env)
                Check.That(
                    result.Code == 1 && !result.Output.Contains("PRIVATE_"),
                    "Unsupported auth schema was accepted or leaked"
                )
            }
            File.WriteAllText(statusPath, status.ToJsonString())
            for effort in[]string{"xhigh", "medium", "max"} {
                let rejected = List[string](words)
                rejected[9] = effort
                let result = TestProcess.Run(binary, rejected.ToArray(), data.Env)
                Check.That(
                    result.Code == 1 && result.Output.Contains("explicit claude-opus-4-6/high"),
                    "Unsupported effort was launched"
                )
            }
            let alias = List[string](words)
            alias[7] = "opus"
            Check.That(
                TestProcess.Run(binary, alias.ToArray(), data.Env).Output.Contains("explicit claude-opus-4-6/high"),
                "Model alias was not refused before native launch"
            )
            File.WriteAllText(mode, "missing")
            Check.That(
                TestProcess.Run(binary, words, data.Env).Code == 1,
                "Missing permission-prompts control was accepted"
            )
            File.WriteAllText(mode, "normal")
            File.WriteAllText(Path.Combine(profile, "settings.json"), "{}")
            Check.That(TestProcess.Run(binary, words, data.Env).Code == 1, "Mixed settings profile was accepted")
            File.Delete(Path.Combine(profile, "settings.json"))
            data.Env["ANTHROPIC_API_KEY"] = "synthetic-only"
            Check.That(TestProcess.Run(binary, words, data.Env).Code == 1, "Environment-token profile was accepted")
            data.Env.Remove("ANTHROPIC_API_KEY")
            let report = Path.Combine(data.Root, "report.jsonl")
            let withReport = List[string](words)
            withReport.AddRange([]string{"--file", report})
            let profileReport = List[string](withReport)
            profileReport[profileReport.Count - 1] = statusPath
            Check.That(
                TestProcess
                    .Run(binary, profileReport.ToArray(), data.Env)
                    .Output
                    .Contains("outside the native-login profile"),
                "Gate opened profile contents as a native report"
            )
            File.WriteAllText(
                report,
                "{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-opus-4-6\",\"permissionMode\":\"default\"}\n{\"type\":\"result\",\"usage\":{\"input_tokens\":12}}\n"
            )
            let parsed = Check
                .Envelope(TestProcess.Run(binary, withReport.ToArray(), data.Env), "claude-capabilities", "ok")[
                "data"
            ]?["native_reports"]
            Check.That(
                parsed?["effort"] == nil && Check.Text(parsed?["usage"]?["input_tokens"]) == "12",
                "Reports invented effort or lost native usage"
            )
            for field in[]string{
                "\"model\":\"claude-sonnet-4-6\"",
                "\"effort\":\"low\"",
                "\"permissionMode\":\"dontAsk\"",
                "\"modelUsage\":{\"claude-haiku-4-5\":{}}"
            } {
                File.WriteAllText(
                    report,
                    "{\"type\":\"system\",\"subtype\":\"init\"," + field + "}\n{\"type\":\"result\"," + field + "}\n"
                )
                Check.That(
                    TestProcess.Run(binary, withReport.ToArray(), data.Env).Code == 1,
                    "Conflicting native report was accepted"
                )
            }
            Console.WriteLine(
                "PASS Claude gate native interfaces, auth schema, metadata refusal, exact choices and report conflicts"
            )
        }
    }
}
