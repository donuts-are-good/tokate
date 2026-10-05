package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Net
import System.Net.Sockets
import System.Text
import Tokate

internal class ClaudeChecks {
    shared {
        private func Refused(action() -> void, code string = "unsupported_capability") {
            var refused bool
            try {
                action()
            } catch (error CliFailure) {
                Check.That(error.Code == code, "Unexpected Claude refusal: " + error.Message)
                refused = true
            }
            Check.That(refused, "Unsupported Claude input was accepted")
        }

        internal func All(binary string, boundary bool = true) {
            using let temp = Temp()
            let missing = TestProcess.Run(
                binary,
                []string{"claude-check", "--model", ClaudeNative.Model, "--effort", "high", "--json"},
                temp.Env
            )
            let missingRecord = Check.Envelope(missing, "claude-check", "error", "missing_tools")
            Check.That(
                Check.Text(missingRecord["data"]?["managed_execution_enabled"]) == "false",
                "Missing Claude binary did not report disabled execution"
            )
            let fake = Path.Combine(temp.Root, "bin/claude")
            let marker = Path.Combine(temp.Root, "started")
            File.WriteAllText(fake, "#!/bin/sh\ntouch '" + marker + "'\n")
            File.SetUnixFileMode(fake, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            for effort in[]string{"low", "medium", "xhigh", "max", "ultra"} {
                let result = TestProcess.Run(
                    binary,
                    []string{"claude-check", "--model", ClaudeNative.Model, "--effort", effort, "--json"},
                    temp.Env
                )
                Check.Envelope(result, "claude-check", "error", "unsupported_capability")
            }
            let changed = TestProcess.Run(
                binary,
                []string{"claude-check", "--model", ClaudeNative.Model, "--effort", "high", "--binary", fake, "--json"},
                temp.Env
            )
            Check.Envelope(changed, "claude-check", "error", "unsupported_capability")
            let resized = File.OpenWrite(fake)
            try {
                resized.SetLength(215473560)
            } finally {
                resized.Dispose()
            }
            let altered = TestProcess.Run(
                binary,
                []string{"claude-check", "--model", ClaudeNative.Model, "--effort", "high", "--binary", fake, "--json"},
                temp.Env
            )
            Check.Envelope(altered, "claude-check", "error", "unsupported_capability")
            Check.That(!File.Exists(marker), "Rejected binary or effort was launched")
            Refused(() -> ClaudeNative.Pair("opus", "high"))
            Refused(() -> ClaudeNative.Pair("claude-opus-4-7", "high"))
            let policy = Path.Combine(temp.Root, "claude-code")
            ClaudeNative.ManagedPolicyAbsent(policy)
            Directory.CreateDirectory(policy)
            File.WriteAllText(Path.Combine(policy, "managed-settings.json"), "synthetic unsupported metadata")
            Refused(() -> ClaudeNative.ManagedPolicyAbsent(policy))
            Directory.Delete(policy, true)
            File.CreateSymbolicLink(policy, Path.Combine(temp.Root, "absent"))
            Refused(() -> ClaudeNative.ManagedPolicyAbsent(policy))
            Refused(() -> ClaudeNative.ManagedPolicyAbsent(Path.Combine(temp.Root, "missing-parent/claude-code")))
            Console.WriteLine("PASS Claude CLI pin/pair and metadata refusals before execution")
            for plan in[]string{"pro", "max"} {
                let fields = ClaudeNative.Authentication(
                    J.Parse(
                        J.Write(
                            J.Map(
                                "loggedIn",
                                true,
                                "authMethod",
                                "claude.ai",
                                "apiProvider",
                                "firstParty",
                                "subscriptionType",
                                plan,
                                "organizationId",
                                "synthetic-org",
                                "organizationName",
                                "synthetic-personal-org",
                                "email",
                                "synthetic@example.invalid"
                            )
                        )
                    )
                )
                Check.That(
                    fields.Count == 4 && !J.Write(fields).Contains("synthetic"),
                    "Claude retained optional account fields"
                )
            }
            for payload in[]string{
                "{}",
                "[]",
                "{\"loggedIn\":\"true\",\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"pro\"}",
                "{\"loggedIn\":true,\"authMethod\":\"oauth_token\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}",
                "{\"loggedIn\":true,\"authMethod\":\"api_key\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"pro\"}",
                "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"bedrock\",\"subscriptionType\":\"pro\"}",
                "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"team\"}",
                "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"enterprise\"}",
                "{\"loggedIn\":true,\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"pro\"}"
            } {
                Refused(
                    () -> {
                        ClaudeNative.Authentication(J.Parse(payload))
                    },
                    "authentication_required"
                )
            }
            let output = "{\"type\":\"system\",\"model\":\"claude-opus-4-6\",\"effortLevel\":\"high\",\"permissionMode\":\"acceptEdits\"}\n{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-6\",\"usage\":{\"input_tokens\":7},\"content\":\"not retained\"}}\n{\"type\":\"result\",\"modelUsage\":{\"claude-opus-4-6\":{\"outputTokens\":3}}}"
            let reports = J.Write(ClaudeNative.Reports(output, ClaudeNative.Model, "high"))
            Check.That(
                !reports.Contains("not retained") && reports.Contains("input_tokens"),
                "Claude report retention differs from native evidence"
            )
            Check.That(
                J.Write(ClaudeNative.Reports("{\"type\":\"result\"}", ClaudeNative.Model, "high")) == "[]",
                "Missing Claude reports were inferred"
            )
            for conflict in[]string{
                "{\"model\":\"opus\"}",
                "{\"effort\":\"medium\"}",
                "{\"effortLevel\":\"xhigh\"}",
                "{\"permissionMode\":\"default\"}",
                "{\"message\":{\"model\":\"claude-haiku-4-5\"}}",
                "{\"modelUsage\":{\"claude-haiku-4-5\":{}}}",
                "{\"model\":\"opus\",\"model\":\"claude-opus-4-6\"}"
            } {
                Refused(
                    () -> {
                        ClaudeNative.Reports(conflict, ClaudeNative.Model, "high")
                    }
                )
            }
            let invocation = ClaudeNative.Invocation(ClaudeNative.Model, "high", false)
            let version = CommandResult{Code: 0, Output: ClaudeNative.Version}
            let help = CommandResult{Code: 0, Output: String.Join(" ", invocation)}
            let status = CommandResult{Code: 1, Output: "{\"loggedIn\":false,\"authMethod\":\"none\"}"}
            ClaudeNative.Interfaces(version, help, status)
            Refused(
                () -> {
                    ClaudeNative.Interfaces(CommandResult{Code: 0, Output: "2.1.259 (Claude Code)"}, help, status)
                }
            )
            Refused(
                () -> {
                    ClaudeNative.Interfaces(version, CommandResult{Code: 0, Output: "--bare"}, status)
                }
            )
            Refused(
                () -> {
                    ClaudeNative.Interfaces(version, help, CommandResult{Code: 0, Output: "{\"loggedIn\":true}"})
                }
            )
            Console.WriteLine("PASS Claude synthetic authentication minimization and native report conflicts/absence")
            if boundary {
                Boundary()
            }
        }

        internal func Boundary() {
            using let temp = Temp()
            let checkout = Path.Combine(temp.Root, "checkout")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            File.WriteAllText(Path.Combine(checkout, "input.txt"), "synthetic-owned")
            let fixture = Path.Combine(temp.Root, "native-fixture")
            File.WriteAllText(
                fixture,
                "#!/usr/bin/python3\nimport json,os,subprocess,sys\na=sys.argv[1:]\n" +
                    "assert '--restricted' in a and '--safe-mode' in a\n" +
                    "assert os.environ['HOME']=='/tmp/tokate-home'\n" +
                    "assert os.environ['CLAUDE_CODE_MAX_RETRIES']=='0'\n" +
                    "assert 'ANTHROPIC_API_KEY' not in os.environ\n" +
                    "if '--version' in a: print('2.1.258 (Claude Code)'); sys.exit(0)\n" +
                    "if '--help' in a: print('" +
                    String
                    .Join(
                    " ",
                    []string{
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
                    }
                ) +
                    "'); sys.exit(0)\n" +
                    "if 'auth' in a: print(json.dumps({'loggedIn':False,'authMethod':'none'})); sys.exit(1)\n" +
                    "assert a[a.index('--model')+1]=='claude-opus-4-6'\n" +
                    "assert a[a.index('--effort')+1]=='high'\n" +
                    "assert '--bare' not in a and '--permission-prompts' not in a\n" +
                    "assert a[a.index('--setting-sources')+1]==''\n" +
                    "prompt=json.load(sys.stdin); assert prompt['message']['content']=='synthetic fixture only'\n" +
                    "s=json.loads(a[a.index('--settings')+1]); assert s['sandbox']['allowUnsandboxedCommands']==False\n" +
                    "open('observed.json','w').write(json.dumps(a))\n" +
                    "open('output.txt','w').write(open('input.txt').read())\n" +
                    "subprocess.run(['/bin/sh','-c','printf synthetic-progress > progress.txt'],check=True)\n" +
                    "print(json.dumps({'model':'claude-opus-4-6','effort':'high','permissionMode':'acceptEdits','usage':{'input_tokens':7}}))\n"
            )
            File.SetUnixFileMode(fixture, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            let version = Probe(checkout, fixture, []string{"--restricted", "--safe-mode", "--version"})
            let help = Probe(checkout, fixture, []string{"--restricted", "--safe-mode", "--help"})
            let auth = Probe(checkout, fixture, []string{"--restricted", "--safe-mode", "auth", "status", "--json"})
            ClaudeNative.Interfaces(version, help, auth)
            let args = ClaudeNative.Invocation(ClaudeNative.Model, "high", false)
            let result = Probe(
                checkout,
                fixture,
                args,
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"synthetic fixture only\"}}\n"
            )
            Check.That(result.Code == 0 && !result.Truncated, "Scripted Claude invocation failed: " + result.Error)
            Check.That(
                J.Write(J.Parse(File.ReadAllText(Path.Combine(checkout, "observed.json")))) == J.Write(args),
                "Observed invocation differs from configured arguments"
            )
            Check.That(
                File.ReadAllText(Path.Combine(checkout, "output.txt")) == "synthetic-owned" && File.ReadAllText(
                    Path.Combine(checkout, "progress.txt")
                ) == "synthetic-progress",
                "Fixture checkout progress was lost"
            )
            ClaudeNative.Reports(result.Output, ClaudeNative.Model, "high")
            Console.WriteLine(
                "PASS scripted CLI invocation and ordinary file/command progress in shared boundary; not native Claude evidence"
            )
            Network(checkout)
            var interrupted bool
            try {
                Verification.Run(
                    checkout,
                    []string{"/bin/sh", "-c", "printf saved > lifecycle.txt; exec sleep 30"},
                    false,
                    1
                )
            } catch (error CommandInterrupted) {
                interrupted = true
            }
            Check.That(interrupted, "Fixture deadline did not interrupt")
            Check.That(
                File.ReadAllText(Path.Combine(checkout, "lifecycle.txt")) == "saved",
                "Deadline lost checkout progress"
            )
            let cancellation = Chan[bool](1)
            go CancelWhenReady(checkout, cancellation)
            interrupted = false
            try {
                Verification.Run(
                    checkout,
                    []string{
                        "/bin/sh",
                        "-c",
                        "printf saved > cancel.txt; (while true; do printf x >> heartbeat.txt; sleep 0.02; done) & wait"
                    },
                    false,
                    5,
                    cancellation: cancellation
                )
            } catch (error CommandInterrupted) {
                interrupted = true
            }
            Check.That(interrupted, "Fixture cancellation did not interrupt")
            Check.That(
                File.ReadAllText(Path.Combine(checkout, "cancel.txt")) == "saved",
                "Cancellation lost checkout progress"
            )
            let heartbeat = Path.Combine(checkout, "heartbeat.txt")
            let length = FileInfo(heartbeat).Length
            select {
                case <- after(TimeSpan.FromMilliseconds(100.0)) { }
            }
            Check.That(FileInfo(heartbeat).Length == length, "Ordinary child continued after cancellation")
            var exhausted bool
            try {
                Verification.Run(
                    checkout,
                    []string{"/bin/sh", "-c", "touch budget-started"},
                    false,
                    5,
                    budget: RuntimeBudget(Stopwatch.StartNew(), 0)
                )
            } catch (error Exception) {
                exhausted = true
            }
            Check.That(
                exhausted && !File.Exists(Path.Combine(checkout, "budget-started")),
                "Exhausted allowance launched repository work"
            )
            Console.WriteLine(
                "PASS shared boundary deadline, cancellation, ordinary child cleanup, budget refusal and checkout preservation"
            )
        }

        private func CancelWhenReady(checkout string, signal Chan[bool]) {
            let clock = Stopwatch.StartNew()
            while !File.Exists(Path.Combine(checkout, "heartbeat.txt")) && clock.ElapsedMilliseconds < 2000 {
                select {
                    case <- after(TimeSpan.FromMilliseconds(5.0)) { }
                }
            }
            signal <- true
        }

        private func Probe(checkout string, fixture string, args[]string, input string? = nil) CommandResult {
            let command = List[string]{"/opt/tokate-claude"}
            command.AddRange(args)
            return Verification.Run(checkout, command.ToArray(), false, 10, nativeExecutable: fixture, input: input)
        }

        private func Network(checkout string) {
            let listener = TcpListener(IPAddress.Loopback, 0)
            listener.Start()
            let completed = Chan[bool](1)
            go Respond(listener, completed)
            try {
                let port = (listener.LocalEndpoint as IPEndPoint)?.Port ?? throw Exception("Missing fixture endpoint")
                let command = []string{
                    "/usr/bin/curl",
                    "--fail",
                    "--silent",
                    "--max-time",
                    "2",
                    "http://127.0.0.1:" + port.ToString() + "/fixture"
                }
                let denied = Verification.Run(checkout, command, false, 5)
                Check.That(denied.Code != 0, "Denied command network reached the fixture")
                let allowed = Verification.Run(checkout, command, true, 5)
                Check.That(
                    allowed.Code == 0 && allowed.Output == "synthetic",
                    "Permitted command network failed against the local fixture: " + allowed.Error
                )
                Check.That(<-completed, "Local fixture did not serve permitted command")
            } finally {
                listener.Stop()
            }
            Console.WriteLine(
                "PASS permitted/denied ordinary command networking against a local endpoint; no provider contact"
            )
        }

        private func Respond(listener TcpListener, completed Chan[bool]) {
            try {
                using let client = listener.AcceptTcpClient()
                using let stream = client.GetStream()
                stream.ReadTimeout = 2000
                using let reader = StreamReader(stream, Encoding.ASCII, false, 1024, true)
                if reader.ReadLine() != "GET /fixture HTTP/1.1" {
                    throw Exception("Unexpected local fixture request")
                }
                var headers int32
                while reader.ReadLine() != "" {
                    headers++
                    if headers > 32 {
                        throw Exception("Unbounded local fixture headers")
                    }
                }
                let bytes = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nsynthetic"
                )
                stream.Write(bytes)
                completed <- true
            } catch (error Exception) {
                completed <- false
            }
        }
    }
}
