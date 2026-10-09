package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Net.Sockets
import System.Runtime.InteropServices
import System.Text
import System.Text.Json.Nodes

@DllImport("libc", EntryPoint: "getsockopt", SetLastError: true)
func DiscoveryPeer(socket int32, level int32, option int32, value[]byte, length[]uint32) int32;

internal class CliDiscovery {
    shared {
        private let Commands[]string = "claude-capabilities doctor update uninstall defaults select init coordinator-setup access coordination request prepare external reconcile authorize-sync revoke-sync amend submit coordinate admit policy approve revoke claim work recover status verify-pr overlaps checks completion help --version"
            .Split(' ')

        private func Address(root string) UnixDomainSocketEndPoint -> UnixDomainSocketEndPoint(
            "\0tokate-discovery-" + Check.TextHash(root)
        )

        internal func Holder() int32 {
            let root = Directory.GetCurrentDirectory()
            Console.Write("detached-prefix\n")
            Console.Out.Flush()
            Console.Error.Write("detached-error-prefix\n")
            Console.Error.Flush()
            using let socket = Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            socket.Connect(Address(root))
            socket.Send([]byte{1})
            let ack = [1]byte
            Check.That(socket.Receive(ack) == 1, "Missing detached-holder acknowledgement")
            File.WriteAllText(Path.Combine(root, "holder-ready"), "ready")
            select {
                case <- after(TimeSpan.FromSeconds(20.0)) { }
            }
            return 0
        }

        private func Observe(listener Socket, observed Chan[string]) {
            try {
                let clock = Stopwatch.StartNew()
                while !listener.Poll(0, SelectMode.SelectRead) {
                    Check.That(clock.Elapsed.TotalSeconds < 5, "Detached holder did not connect")
                    select {
                        case <- after(TimeSpan.FromMilliseconds(5.0)) { }
                    }
                }
                using let socket = listener.Accept()
                let credentials = [12]byte
                let length = []uint32{12}
                Check.That(
                    DiscoveryPeer(socket.SafeHandle.DangerousGetHandle().ToInt32(), 1, 17, credentials, length) == 0 &&
                        length[0] == 12,
                    "Cannot identify owned holder"
                )
                let pid = BitConverter.ToInt32(credentials, 0).ToString()
                let message = [1]byte
                Check.That(socket.Receive(message) == 1 && message[0] == 1, "Wrong holder readiness")
                let stat = TestProcess.Status("/proc/" + pid + "/stat") ?? throw Exception("Ready holder is absent")
                Check.That(TestProcess.Fields(stat)[3] == pid, "Pipe holder did not leave the original session")
                socket.Send([]byte{1})
                observed <- pid
            } catch (error Exception) {
                observed <- "error: " + error.Message
            }
        }

        private func Collected(pid string) {
            let clock = Stopwatch.StartNew()
            while TestProcess.Status("/proc/" + pid + "/stat") != nil && clock.Elapsed.TotalSeconds < 2 {
                select {
                    case <- after(TimeSpan.FromMilliseconds(5.0)) { }
                }
            }
            Check.That(
                TestProcess.Status("/proc/" + pid + "/stat") == nil,
                "Repository discovery left a detached holder"
            )
        }

        internal func Call(binary string, args[]string, temp Temp, code int32 = 0) Result {
            let result = TestProcess.Run(binary, args, temp.Env, cwd: temp.Root)
            Check.That(result.Code == code, result.Output + result.Error)
            Check.That(!result.Error.Contains("Missing tools"), "Prerequisites checked before validation")
            return result
        }

        internal func Setup(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.ReleaseReady(hosted: false)
            let root = Path.Combine(flow.Temp.Root, "adopter")
            let args = []string{
                "init",
                "--repo",
                "owner/project",
                "--path",
                root,
                "--model-policy",
                "unrestricted",
                "--verification",
                "[[\"bash\",\"scripts/verify.sh\"]]",
                "--required-checks",
                "[\"verify\"]",
                "--non-interactive",
                "--yes"
            }
            Check.Contains(
                flow.Call([]string{"init", "--repo", "owner/project", "--path", root}, 1, true).Error,
                "Choose --model-policy"
            )
            Check.Contains(flow.Call(args, 1, true).Error, "Bootstrap required")
            Check.That(!Directory.Exists(root), "Failed setup created adopter files")
            flow.Reload()
            flow.State["hosted_workflow"] = JsonValue.Create(true)
            flow.Save()
            let preview = List[string](args)
            preview.Remove("--yes")
            Check.Contains(flow.Call(preview.ToArray(), owner: true).Error, "Preview only")
            Check.That(!Directory.Exists(root), "Preview wrote adopter files")
            let created = flow.Call(args, owner: true)
            Check.Contains(created.Error, "Proposed complete file")
            Check.Contains(created.Error, "contents write")
            Check.Contains(created.Error, "tokate/contributions/N")
            let policyPath = Path.Combine(root, ".github/tokate.json")
            let workflowPath = Path.Combine(root, ".github/workflows/tokate-coordinator.yml")
            let original = File.ReadAllText(policyPath)
            var policy = Check.Json(original)
            Check.That(
                Check.Text(policy["eligibility"]) == "trusted" && Check.Text(policy["approval_scope"]) == "task",
                "New setup did not default to task-scoped trusted access"
            )
            Check.That(
                policy["models"] == nil && Check.Text(policy["model_policy"]) == "unrestricted",
                "Unrestricted setup silently restricted models"
            )
            Check.That(
                Directory.GetFiles(root, "*", SearchOption.AllDirectories).Length == 2,
                "New adopter footprint is not two files"
            )
            let yaml = File.ReadAllText(workflowPath)
            Check.That(
                !yaml.Contains("run:") && !yaml.Contains("checkout") && yaml.Split('\n').Length < 25,
                "Setup copied runtime code"
            )
            flow.Call(
                []string{"init", "--repo", "owner/project", "--path", root, "--non-interactive", "--yes"},
                owner: true
            )
            Check.That(
                File.ReadAllText(policyPath) == original && File.ReadAllText(workflowPath) == yaml,
                "Repeated setup changed owner files"
            )
            let renamed = Path.Combine(root, ".github/workflows/owner.yaml")
            File.Move(workflowPath, renamed)
            flow.Call(
                []string{"init", "--repo", "owner/project", "--path", root, "--non-interactive", "--yes"},
                owner: true
            )
            Check.That(
                !File.Exists(workflowPath) && File.ReadAllText(renamed) == yaml && Directory.GetFiles(
                    root,
                    "*",
                    SearchOption.AllDirectories
                )
                    .Length == 2,
                "Repeat duplicated renamed owner workflow"
            )
            File.Move(renamed, workflowPath)
            let escaped = "custom owner workflow\n# synthetic-preview-\x1b[31m\n"
            File.WriteAllText(workflowPath, escaped)
            let safePreview = flow.Call(
                []string{"init", "--repo", "owner/project", "--path", root, "--non-interactive", "--plain"},
                owner: true
            )
            Check.That(!safePreview.Error.Contains('\x1b'), "Owner preview emitted terminal control bytes")
            Check.Contains(safePreview.Error, "synthetic-preview-")
            Check.Contains(safePreview.Error, "not verified")
            Check.That(File.ReadAllText(workflowPath) == escaped, "Preview changed the custom workflow")
            let custom = Path.Combine(root, ".github/tokate-pr.md")
            File.WriteAllText(custom, TestResources.Template("tokate-pr.md") + "Owner customization\n")
            File.WriteAllText(workflowPath, "custom owner workflow\n")
            flow.Call(
                []string{
                    "init",
                    "--repo",
                    "owner/project",
                    "--path",
                    root,
                    "--model-policy",
                    "whitelist",
                    "--models",
                    "{\"model-a\":[\"low\",\"high\"],\"model-b\":[\"absent\"]}",
                    "--eligibility",
                    "manual",
                    "--base-branch",
                    "release",
                    "--network",
                    "allow",
                    "--seconds",
                    "5400",
                    "--reservation-seconds",
                    "300",
                    "--pr-text",
                    "Literal {{issue}} owner text",
                    "--close-message",
                    "Ask the owner for access.",
                    "--non-interactive",
                    "--yes"
                },
                owner: true
            )
            let restricted = File.ReadAllText(policyPath)
            policy = Check.Json(restricted)
            Check.That(
                Check.Text(policy["target_branch"]) == "release" && Check.Text(policy["max_seconds"]) == "5400" &&
                    Check.Text(policy["allow_network"]) == "true",
                "Noninteractive settings were not applied"
            )
            flow.Call(
                []string{"init", "--repo", "owner/project", "--path", root, "--non-interactive", "--yes"},
                owner: true
            )
            Check.That(
                File.ReadAllText(policyPath) == restricted && File.ReadAllText(
                    workflowPath
                ) == "custom owner workflow\n" &&
                    File
                    .ReadAllText(custom).EndsWith("Owner customization\n"),
                "Repeat overwrote customization or restrictions"
            )
            let invalid = []string{
                "init",
                "--repo",
                "owner/project",
                "--path",
                root,
                "--verification",
                "[]",
                "--non-interactive",
                "--yes"
            }
            flow.Call(invalid, 1, true)
            Check.That(File.ReadAllText(policyPath) == restricted, "Invalid policy replaced owner work")
            policy["allowed_tools"] = Check.Json(
                "[{\"harness\":\"claude\",\"provider\":\"anthropic\"},{\"harness\":\"omp\",\"provider\":\"gufo\"}]"
            )
            Check.SaveJson(policyPath, policy)
            let toolArgs = List[string]{
                "init",
                "--repo",
                "owner/project",
                "--path",
                root,
                "--allowed-tools",
                "pi",
                "--non-interactive",
                "--yes"
            }
            flow.Call(toolArgs.ToArray(), owner: true)
            let mixed = Check.Json(File.ReadAllText(policyPath))["allowed_tools"]?.ToJsonString() ?? ""
            for name in[]string{"claude", "omp", "pi"} {
                Check.Contains(mixed, "\"harness\":\"" + name + "\"")
            }
            toolArgs[6] = "claude/anthropic,hermes/openrouter"
            flow.Call(toolArgs.ToArray(), owner: true)
            policy = Check.Json(File.ReadAllText(policyPath))
            let exact = policy["allowed_tools"]?.AsArray() ?? throw Exception("Missing tools")
            Check.That(
                exact.Count == 2 && Check.Text(exact[1]?["harness"]) == "hermes",
                "Exact external tools were not selected"
            )
            toolArgs[6] = "codex"
            flow.Call(toolArgs.ToArray(), owner: true)
            policy = Check.Json(File.ReadAllText(policyPath))
            let kept = policy["allowed_tools"]?.AsArray() ?? throw Exception("Missing tools")
            Check.That(kept.Count == 3, "Managed selection removed external permissions")
            let beforeInvalidTool = File.ReadAllText(policyPath)
            toolArgs[6] = "claude/"
            flow.Call(toolArgs.ToArray(), 1, true)
            Check.That(File.ReadAllText(policyPath) == beforeInvalidTool, "Invalid tool pair changed policy")
            let obsolete = Path.Combine(flow.Temp.Root, "obsolete")
            Directory.CreateDirectory(Path.Combine(obsolete, ".github"))
            let obsoletePolicy = Check.Json(TestResources.Template("tokate.json"))
            obsoletePolicy["version"] = JsonValue.Create(1)
            let obsoleteText = obsoletePolicy.ToJsonString()
            File.WriteAllText(Path.Combine(obsolete, ".github/tokate.json"), obsoleteText)
            flow.Call(
                []string{"init", "--repo", "owner/project", "--path", obsolete, "--non-interactive", "--yes"},
                1,
                true
            )
            Check.That(
                File.ReadAllText(Path.Combine(obsolete, ".github/tokate.json")) == obsoleteText,
                "Unsupported policy was rewritten"
            )
            let interactiveRoot = Path.Combine(flow.Temp.Root, "interactive")
            let command = "'" + binary + "' init --repo owner/project --path '" + interactiveRoot + "' --plain"
            let env = System.Collections.Generic.Dictionary[string, string](flow.Temp.Env)
            env["GH_TOKEN"] = "fixture-owner"
            let terminal = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                env,
                "whitelist\nadd\nmodel-a\nhigh xhigh\n\n\n\nmain\n\n\n\n/usr/bin/true\n\nverify, build\n\ny\n"
            )
            Check.Success(terminal)
            Check.That(
                terminal.Output.Split("Models: unrestricted or whitelist").Length == 2,
                "Setup asked for model mode more than once"
            )
            Check.That(
                File.Exists(Path.Combine(interactiveRoot, ".github/tokate.json")),
                "Interactive confirmation did not apply setup"
            )
            let selected = Check.Json(File.ReadAllText(Path.Combine(interactiveRoot, ".github/tokate.json")))
            Check.That(
                selected["models"]?["model-a"]?.ToJsonString() == "[\"high\",\"xhigh\"]" &&
                    selected["verification"]?.ToJsonString() == "[[\"/bin/sh\",\"-c\",\"/usr/bin/true\"]]" &&
                    selected["required_checks"]?.ToJsonString() == "[\"verify\",\"build\"]",
                "Interactive setup lost selected models, commands or check names"
            )
            flow.Call([]string{"defaults", "set", "--model", "gpt-6.1-sol", "--effort", "high"})
            flow.Call(
                []string{
                    "defaults",
                    "set",
                    "--profile",
                    "local",
                    "--harness",
                    "pi",
                    "--model",
                    "local-" + String('x', 120),
                    "--effort",
                    "absent",
                    "--endpoint",
                    "http://127.0.0.1:12345/v1"
                }
            )
            let pickerScript = Path.Combine(flow.Temp.Root, "model-checklist.py")
            File.WriteAllText(pickerScript, TestResources.Template("model-checklist.py"))
            let picker = TestProcess.Run(
                "python3",
                []string{pickerScript, binary, Path.Combine(flow.Temp.Root, "checklist")},
                env
            )
            Check.Success(picker)
            Console.Write(picker.Output)
            let previousToken = flow.Temp.Env["GH_TOKEN"]
            flow.Temp.Env["GH_TOKEN"] = "fixture-owner"
            let guided = TestTerminal.Pty(
                binary,
                []string{},
                flow.Temp,
                80,
                "2\nowner/project\n1\n1\n/usr/bin/true\n\nverify\n2\n2\n10\n1\nq\n"
            )
            flow.Temp.Env["GH_TOKEN"] = previousToken
            Check.Success(guided)
            Check.Contains(guided.Output, "Review project setup")
            Check.That(File.Exists(Path.Combine(flow.Temp.Root, ".github/tokate.json")), guided.Output + guided.Error)
            let guidedPolicy = Check.Json(File.ReadAllText(Path.Combine(flow.Temp.Root, ".github/tokate.json")))
            Check.That(
                Check.Text(guidedPolicy["max_seconds"]) == "600" && Check.Text(
                    guidedPolicy["eligibility"]
                ) == "trusted" &&
                    Check.Text(guidedPolicy["model_policy"]) == "unrestricted" &&
                    guidedPolicy["verification"]?.ToJsonString() == "[[\"/bin/sh\",\"-c\",\"/usr/bin/true\"]]",
                "Accepted owner workflow changed the reviewed policy"
            )
            flow.NoInference()
            flow.NoPr()
            Console.WriteLine(
                "PASS CLI owner setup: bootstrap, preview, confirmation, two files, repeat, restrictions, upgrade and explicit options"
            )
        }

        internal func Structured(binary string) {
            using let temp = Temp()
            let bin = Path.Combine(temp.Root, "bin")
            let calls = Path.Combine(temp.Root, "calls")
            for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
                let tool = Path.Combine(bin, name)
                File.WriteAllText(
                    tool,
                    "#!/bin/sh\necho called >> '" + calls + "'\necho synthetic-tool-error-marker >&2\nexit 17\n"
                )
                File.SetUnixFileMode(tool, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            }
            for command in Commands {
                let help = Check.Envelope(Call(binary, []string{command, "--help", "--json"}, temp), command, "ok")
                if command != "help" {
                    Check.That(
                        Check.Text(help["data"]?["commands"]?[0]?["command"]) == command,
                        "Focused metadata missing command"
                    )
                }
            }
            let metadata = Check.Envelope(Call(binary, []string{"help", "--json"}, temp), "help", "ok")
            Check.That(
                metadata["data"]?["commands"]?.AsArray().Count == Commands.Length,
                "Metadata omits public commands"
            )
            for command in metadata["data"]?["commands"]?.AsArray() ?? JsonArray() {
                let names = HashSet[string](StringComparer.Ordinal)
                for option in command["arguments"]?.AsArray() ?? JsonArray() {
                    Check.That(names.Add(Check.Text(option["name"])), "CLI metadata repeated an option")
                }
                Check.That(Check.Text(command["noninteractive"]) == "true", "Hidden interactive command")
                Check.That(
                    Check.Text(command["inference"]) == (Check.Text(command["command"]) == "work" ? "true": "false"),
                    "Incorrect inference effects"
                )
                Check.That(command["effects"]?.AsObject().Count == 4, "Incomplete read/write effects")
                Check.That(
                    command["arguments"]?.ToJsonString().Contains("--json") == true,
                    "JSON absent from accepted arguments"
                )
            }
            for argv in[][]string{
                []string{"unknown", "--json"},
                []string{"work", "--unknown", "--json"},
                []string{"checks", "--run", "saved", "--repo", "owner/project", "--json"},
                []string{"doctor", "--json=true"},
                []string{"status", "--run", "saved", "--json", "--json"},
                []string{"status", "--run", "saved", "--repo", "owner/project", "--json"},
                []string{"status", "--run", "saved", "--issue", "1", "--json"},
                []string{"amend", "--run", "saved", "--commit", String('a', 40) + "\n", "--seconds", "30", "--json"},
                []string{"revoke-sync", "--repo", "owner/project", "--grant", "invalid", "--json"},
                []string{"revoke-sync", "--repo", "owner/project", "--grant", String('a', 40) + "\n", "--json"},
                []string{
                    "authorize-sync",
                    "--repo",
                    "owner/project",
                    "--pr",
                    "10",
                    "--commit",
                    String('a', 40),
                    "--upstream",
                    "invalid",
                    "--json"
                },
                []string{
                    "authorize-sync",
                    "--repo",
                    "owner/project",
                    "--pr",
                    "10",
                    "--commit",
                    String('a', 40),
                    "--upstream",
                    String('a', 40) + "\n",
                    "--json"
                },
                []string{
                    "amend",
                    "--run",
                    "saved",
                    "--commit",
                    String('a', 40),
                    "--seconds",
                    "30",
                    "--sync",
                    "invalid",
                    "--json"
                },
                []string{
                    "amend",
                    "--run",
                    "saved",
                    "--commit",
                    String('a', 40),
                    "--seconds",
                    "30",
                    "--sync",
                    String('a', 40) + "\n",
                    "--json"
                },
                []string{"approve", "--issue", "0", "--json"}
            } {
                Check.Envelope(Call(binary, argv, temp, 1), argv[0], "error", "invalid_arguments")
            }
            Check.That(!File.Exists(calls), "Invalid inputs or metadata invoked prerequisites")
            let version = Check.Envelope(Call(binary, []string{"--version", "--json"}, temp), "--version", "ok")
            Check.That(
                Call(binary, []string{"--version"}, temp).Output.Trim() == "tokate " + Check.Text(
                    version["data"]?["version"]
                ),
                "Structured and plain versions differ"
            )
            let alias = Check.Json(Call(binary, []string{"version", "--json"}, temp).Output)
            Check.That(JsonNode.DeepEquals(alias, version), "Version alias result differs")
            Check.That(
                Call(binary, []string{"version"}, temp).Output.Trim() == "tokate " + Check.Text(
                    version["data"]?["version"]
                ),
                "Plain version alias differs"
            )
            Check.Contains(Call(binary, []string{"version", "--help"}, temp).Output, "Usage: tokate --version")
            Check.Envelope(
                Call(binary, []string{"version", "extra", "--json"}, temp, 1),
                "--version",
                "error",
                "invalid_arguments"
            )
            let defaults = Check.Envelope(Call(binary, []string{"help", "defaults", "--json"}, temp), "help", "ok")[
                "data"
            ]?["commands"]?[0]
            Check.That(Check.Text(defaults?["effects"]?["local_write"]) == "true", "Defaults write effect missing")
            Check.That(
                JsonNode.DeepEquals(
                    defaults?["operations"]?[0]?["required_input_sets"],
                    Check.Json("[[\"harness\"],[\"model\",\"effort\"]]")
                ),
                "Defaults set required inputs differ"
            )
            Check.That(
                Check.Text(defaults?["operations"]?[1]?["effects"]?["local_write"]) == "false",
                "Defaults read advertised a write"
            )
            for name in[]string{"select", "amend", "request"} {
                let command = Check.Envelope(Call(binary, []string{"help", name, "--json"}, temp), "help", "ok")[
                    "data"
                ]?["commands"]?[0]
                Check.That(
                    Check.Text(command?["effects"]?["local_write"]) == "true" && Check.Text(
                        command?["effects"]?["github_read"]
                    ) == "true",
                    "Missing command write effects"
                )
                Check.That(Check.Text(command?["inference"]) == "false", "Non-inference command advertised inference")
            }
            let workMetadata = Check.Envelope(Call(binary, []string{"help", "work", "--json"}, temp), "help", "ok")
            for name in[]string{"seconds", "runs", "fork", "allow-network"} {
                var listed bool
                for input in workMetadata["data"]?["commands"]?[0]?["exclusive_run_inputs"]?.AsArray() ?? JsonArray() {
                    listed = listed || Check.Text(input) == name
                }
                Check.That(listed, "Metadata omitted --run conflict: " + name)
                let argv = name == "allow-network" ? []string{
                    "work",
                    "--run",
                    "saved",
                    "--allow-network",
                    "--json"
                }: []string{"work", "--run", "saved", "--" + name, "1", "--json"}
                let rejected = Check.Envelope(Call(binary, argv, temp, 1), "work", "error", "invalid_arguments")
                Check.Contains(Check.Text(rejected["error"]?["message"]), "--run conflicts with --" + name)
            }
            Check.Envelope(
                Call(binary, []string{"checks", "--run", "saved", "--watch", "--timeout", "1", "--json"}, temp, 1),
                "checks",
                "error",
                "invalid_state"
            )
            Check.Envelope(
                Call(binary, []string{"work", "--run", "saved", "--yes", "--non-interactive", "--json"}, temp, 1),
                "work",
                "error",
                "invalid_state"
            )
            var longPath = "/tmp"
            for i in 0 ... 27 {
                longPath += "/synthetic-" + String('x', 80)
            }
            Check.Contains(Call(binary, []string{"status", "--run", longPath}, temp, 1).Error, longPath)
            Check.Envelope(
                Call(binary, []string{"status", "--run", longPath, "--json"}, temp, 1),
                "status",
                "error",
                "invalid_state"
            )
            for shell in[]string{"bash", "zsh", "fish"} {
                let script = Check.Envelope(
                    Call(binary, []string{"completion", shell, "--json"}, temp),
                    "completion",
                    "ok"
                )
                Check.That(
                    Check.Text(script["data"]?["script"]) == Call(binary, []string{"completion", shell}, temp).Output,
                    "Completion script was shortened"
                )
                Check.That(Check.Text(script["truncated"]) == "false", "Completion was truncated")
            }
            let brokenDoctor = TestProcess.Run(binary, []string{"doctor", "--json"}, temp.Env)
            let broken = Check.Envelope(brokenDoctor, "doctor", "error", "missing_tools")
            Check.That(Check.Text(broken["data"]?["tools"]?[0]?["status"]) == "failed", "Broken tool accepted")
            Check.That(
                !(brokenDoctor.Output + brokenDoctor.Error).Contains("synthetic-tool-error-marker"),
                "Raw diagnostic output leaked"
            )
            let empty = Path.Combine(temp.Root, "empty")
            Directory.CreateDirectory(empty)
            temp.Env["PATH"] = empty
            let doctor = TestProcess.Run(binary, []string{"doctor", "--json"}, temp.Env)
            let diagnosis = Check.Envelope(doctor, "doctor", "error", "missing_tools")
            Check.That(diagnosis["data"]?["tools"]?.AsArray().Count == 9, "Doctor omitted common checks")
            Check.That(!doctor.Output.Contains("Tokate environment"), "Doctor emitted prose stdout")
            let blocked = Check.Envelope(
                TestProcess.Run(binary, []string{"policy", "--repo", "owner/project", "--json"}, temp.Env),
                "policy",
                "error",
                "missing_tools"
            )
            Check.That(Check.Text(blocked["next_actions"]?[0]?[1]) == "doctor", "Missing-tools action absent")
            let init = Path.Combine(temp.Root, "project")
            Check.Envelope(
                TestProcess.Run(
                    binary,
                    []string{"init", "--repo", "owner/project", "--path", init, "--json"},
                    temp.Env
                ),
                "init",
                "error",
                "missing_tools"
            )
            Check.That(!File.Exists(Path.Combine(init, ".github/tokate.json")), "Failed setup wrote configuration")
            let saved = Path.Combine(temp.Root, "saved")
            Directory.CreateDirectory(saved)
            let rows = JsonArray()
            for i in 0 ... 70 {
                rows.Add(
                    Check.Map(
                        "command",
                        Check.Json("[\"/bin/sh\",\"-c\",\"exit 23\"]"),
                        "exit_code",
                        23,
                        "output",
                        "synthetic-verifier-output-marker",
                        "error",
                        "synthetic-verifier-error-marker"
                    )
                )
            }
            let fullArgs = JsonArray()
            for i in 0 ... 100 {
                fullArgs.Add(JsonValue.Create("complete-argument-" + i.ToString()) as JsonNode)
            }
            let firstRow = rows[0] ?? throw Exception("Missing verification row")
            firstRow["command"] = fullArgs
            let hash = String('a', 40)
            let identity = String('x', 3000)
            let record = Check.Map(
                "version",
                2,
                "id",
                "saved",
                "state",
                "failed",
                "commit",
                hash,
                "donor",
                identity,
                "verification",
                rows,
                "error",
                "synthetic-saved-error-marker" + String('x', 20000)
            )
            File.WriteAllText(Path.Combine(saved, "run.json"), record.ToJsonString())
            File.WriteAllText(Path.Combine(saved, "events.jsonl"), "synthetic-harness-marker")
            File.WriteAllText(Path.Combine(saved, "verification.json"), rows.ToJsonString())
            let statusResult = TestProcess.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env)
            let status = Check.Envelope(statusResult, "status", "ok")
            Check.That(
                status["data"]?["verification"]?.AsArray().Count == 64 && Check.Text(
                    status["data"]?["verification_count"]
                ) == "70",
                "Summary list bounds missing"
            )
            Check.That(Check.Text(status["truncated"]) == "true", "Missing truncation signal")
            Check.That(
                status["data"]?["verification"]?[0]?["command"]?.AsArray().Count == 100,
                "Executable arguments were shortened"
            )
            Check.That(
                Check.Text(status["data"]?["commit"]) == hash && Check.Text(status["data"]?["donor"]) == identity,
                "Identity shortened"
            )
            Check.That(
                Check.Text(status["data"]?["artifacts"]?["events.jsonl"]) == Path.Combine(saved, "events.jsonl"),
                "Missing full artifact path. Expected " + Path.Combine(saved, "events.jsonl") +
                    "\n" +
                    statusResult.Output
            )
            Check.That(Check.Text(status["next_actions"]?[0]?[3]) == saved, "Action path shortened")
            let legacy = TestProcess.Run(binary, []string{"status", "--run", saved}, temp.Env)
            Check.Success(legacy)
            Check.That(Check.Json(legacy.Output)["schema_version"] == nil, "Legacy status was enveloped")
            Check.That(
                Check.Json(legacy.Output)["verification"]?[0]?.AsObject().Count == 2,
                "Legacy verification exposes logs"
            )
            for marker in[]string{
                "synthetic-verifier-output-marker",
                "synthetic-verifier-error-marker",
                "synthetic-saved-error-marker",
                "synthetic-harness-marker"
            } {
                Check.That(
                    !(statusResult.Output + statusResult.Error + legacy.Output + legacy.Error).Contains(marker),
                    "Raw marker escaped summary: " + marker
                )
            }
            firstRow.AsObject().Remove("exit_code")
            firstRow["state"] = JsonValue.Create("interrupted")
            firstRow["output_truncated"] = JsonValue.Create(true)
            firstRow["error_truncated"] = JsonValue.Create(false)
            record["verification"] = rows.DeepClone()
            record["failure_reason"] = JsonValue.Create("inference_interrupted")
            record["output_truncated"] = JsonValue.Create(true)
            File.WriteAllText(Path.Combine(saved, "run.json"), record.ToJsonString())
            let stoppedResult = TestProcess.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env)
            let stopped = Check.Envelope(stoppedResult, "status", "ok")
            let stoppedCheck = stopped["data"]?["verification"]?[0] ?? throw Exception("Missing interrupted check")
            Check.That(
                Check.Text(stoppedCheck["state"]) == "interrupted" && stoppedCheck["exit_code"] == nil && Check.Text(
                    stoppedCheck["output_truncated"]
                ) == "true" &&
                    Check.Text(stoppedCheck["error_truncated"]) == "false",
                "Incomplete verification acquired an exit code or lost stream truncation"
            )
            Check.That(
                Check.Text(stopped["data"]?["error"]?["code"]) == "inference_failed" && Check.Text(
                    stopped["data"]?["output_truncated"]
                ) == "true",
                "Interrupted inference lost its safe failure classification"
            )
            Check.That(
                !stoppedResult.Output.Contains("synthetic-verifier-output-marker") && !stoppedResult.Output.Contains(
                    "synthetic-verifier-error-marker"
                ),
                "Interrupted verification leaked private output"
            )
            for action in stopped["next_actions"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(action[1]) != "recover", "Interrupted inference suggested recovery")
            }
            record["failure_reason"] = JsonValue.Create("verification_failed")
            File.WriteAllText(Path.Combine(saved, "run.json"), record.ToJsonString())
            let correction = Check.Map(
                "uuid",
                Guid.NewGuid().ToString("D"),
                "commit",
                hash,
                "state",
                "failed",
                "failure_reason",
                "verification_failed",
                "verification",
                rows,
                "error",
                "synthetic-correction-error-marker",
                "publication_error",
                "synthetic-correction-error-marker"
            )
            File.WriteAllText(Path.Combine(saved, "correction.json"), correction.ToJsonString())
            let correctedResult = TestProcess.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env)
            let corrected = Check.Envelope(correctedResult, "status", "ok")
            Check.That(
                Check.Text(corrected["data"]?["correction"]?["error"]?["code"]) == "verification_failed",
                "Correction reason missing"
            )
            Check.That(!correctedResult.Output.Contains("synthetic-correction-error-marker"), "Correction error leaked")
            Check.That(
                Check.Text(corrected["data"]?["correction"]?["verification"]?[0]?["state"]) == "interrupted" &&
                    corrected["data"]?["correction"]?["verification"]?[0]?["exit_code"] == nil,
                "Correction summary lost incomplete verification state"
            )
            for action in corrected["next_actions"]?.AsArray() ?? JsonArray() {
                Check.That(Check.Text(action[1]) != "recover", "Suggested legacy recovery for explicit correction")
            }
            File.Copy(binary, Path.Combine(temp.Root, "tokate-cli"))
            let pty = TestProcess.Run(
                "/usr/bin/script",
                []string{
                    "-q",
                    "-e",
                    "-c",
                    "test -t 1 && ./tokate-cli status --run ./saved --json 2>diagnostics",
                    "/dev/null"
                },
                temp.Env,
                cwd: temp.Root
            )
            Check.Envelope(pty, "status", "ok")
            record["commit"] = JsonValue.Create(String('a', 70000))
            File.WriteAllText(Path.Combine(saved, "run.json"), record.ToJsonString())
            Check.Envelope(
                TestProcess.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env),
                "status",
                "error",
                "output_too_large"
            )
            let longError = Check.Envelope(
                TestProcess.Run(binary, []string{"doctor", "--" + String('x', 6000), "--json"}, temp.Env),
                "doctor",
                "error",
                "invalid_arguments"
            )
            Check.That(
                Check.Text(longError["error"]?["message"]).Length <= 2048 && Check.Text(
                    longError["truncated"]
                ) == "true",
                "Unbounded display prose"
            )
            Console.WriteLine(
                "PASS structured CLI: metadata, errors before effects, diagnostics, scripts, redirected/PTY output, bounded summaries and private markers"
            )
        }

        internal func Saved(binary string) {
            using let temp = Temp()
            temp.Env["TERM"] = "dumb"
            temp.Env["NO_COLOR"] = "1"
            temp.Env["PATH"] = Path.Combine(temp.Root, "bin")
            let executable = Path.Combine(temp.Root, "tokate saved")
            File.Copy(binary, executable)
            let root = Path.Combine(temp.Env["HOME"], ".local/state/tokate/runs")
            let first = Path.Combine(root, "a first")
            let second = Path.Combine(root, "b second")
            Directory.CreateDirectory(first)
            Directory.CreateDirectory(second)
            let record = Check.Map(
                "version",
                2,
                "id",
                "first",
                "repo",
                "owner/project",
                "issue",
                1,
                "donor",
                "donor",
                "model",
                "fixture-model",
                "state",
                "claimed",
                "source",
                "tokate",
                "seconds",
                60,
                "verification_reserve",
                20
            )
            File.WriteAllText(Path.Combine(first, "run.json"), record.ToJsonString())
            record["id"] = JsonValue.Create("second")
            record["state"] = JsonValue.Create("generated")
            record["model"] = JsonValue.Create("second\u001b[31m")
            File.WriteAllText(Path.Combine(second, "run.json"), record.ToJsonString())
            let firstBytes = Check.Hash(Path.Combine(first, "run.json"))
            let secondBytes = Check.Hash(Path.Combine(second, "run.json"))
            let obsolete = Path.Combine(root, "obsolete")
            Directory.CreateDirectory(obsolete)
            record["version"] = JsonValue.Create(1)
            let obsoleteText = record.ToJsonString()
            File.WriteAllText(Path.Combine(obsolete, "run.json"), obsoleteText)
            record["version"] = JsonValue.Create(2)
            let broken = Path.Combine(root, "broken")
            let oversized = Path.Combine(root, "oversized")
            Directory.CreateDirectory(broken)
            Directory.CreateDirectory(oversized)
            File.WriteAllText(Path.Combine(broken, "run.json"), "{")
            File.WriteAllText(Path.Combine(oversized, "run.json"), String('x', 1024 * 1024 + 1))
            Directory.CreateSymbolicLink(Path.Combine(root, "linked"), first)
            let command = []string{"-q", "-e", "-c", "exec '" + executable.Replace("'", "'\"'\"'") + "'", "/dev/null"}
            let selected = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\n99\n1\n3\n3\n2\nq\n")
            Check.Success(selected)
            Check.Contains(selected.Output, "a first")
            Check.That(
                File.ReadAllText(Path.Combine(obsolete, "run.json")) == obsoleteText,
                "Unsupported saved run was changed"
            )
            Check.Contains(selected.Output, "b second")
            Check.Contains(selected.Output, "Unreadable entries skipped: 4")
            Check.Contains(selected.Output, "Choose a number from 1 to 2.")
            Check.Contains(selected.Output, "Start reserved donation")
            let last = selected.Output.Substring(selected.Output.LastIndexOf("Continue contribution"))
            Check.Contains(last, "Submit verified work")
            Check.That(!last.Contains("Start reserved donation"), "Saved selection retained the previous run action")
            Check.That(!selected.Output.Contains("\u001b[31m"), "Saved metadata injected terminal controls")
            Check.That(
                !selected.Output.Contains("repo> ") && !selected.Output.Contains("Missing tools"),
                "Offline selection required repository tools"
            )
            Check.That(
                Check.Hash(Path.Combine(first, "run.json")) == firstBytes && Check.Hash(
                    Path.Combine(second, "run.json")
                ) == secondBytes,
                "Saved inspection changed metadata"
            )
            Check.That(
                Directory.GetFileSystemEntries(first).Length == 1 && Directory.GetFileSystemEntries(second).Length == 1,
                "Saved inspection created execution artifacts"
            )
            let firstText = File.ReadAllText(Path.Combine(first, "run.json"))
            let unlimited = Check.Json(firstText)
            unlimited["unlimited"] = JsonValue.Create(true)
            unlimited["seconds"] = JsonValue.Create(20)
            File.WriteAllText(Path.Combine(first, "run.json"), unlimited.ToJsonString())
            let budget = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\n1\n1\n2\n3\nq\n")
            Check.Success(budget)
            Check.Contains(budget.Output, "unlimited coding time, independent verification budget 20s")
            Check.That(!budget.Output.Contains("Coding  0"), "Unlimited saved work displayed zero coding time")
            Check.That(
                File.ReadAllText(Path.Combine(first, "run.json")) == unlimited.ToJsonString(),
                "Declined donation changed saved work"
            )
            File.WriteAllText(Path.Combine(first, "run.json"), firstText)
            let secondText = File.ReadAllText(Path.Combine(second, "run.json"))
            let partial = Check.Json(secondText)
            partial["state"] = JsonValue.Create("incomplete_generated")
            partial["incomplete"] = JsonValue.Create(true)
            File.WriteAllText(Path.Combine(second, "run.json"), partial.ToJsonString())
            let incomplete = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\n2\n3\nq\n")
            Check.Success(incomplete)
            Check.Contains(incomplete.Output, "Submit incomplete work for a draft PR")
            Check.That(!incomplete.Output.Contains("Submit verified work"), "Incomplete work was labeled verified")
            Check.That(
                File.ReadAllText(Path.Combine(second, "run.json")) == partial.ToJsonString(),
                "Inspection published incomplete work"
            )
            File.WriteAllText(Path.Combine(second, "run.json"), secondText)
            Directory.Delete(second, true)
            let cancelled = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\nh\nq\n")
            Check.Success(cancelled)
            Check.That(!cancelled.Output.Contains("Donor run"), "Only remaining contribution was selected implicitly")
            let stateHome = Path.Combine(temp.Root, "new state")
            let current = Path.Combine(stateHome, "tokate/runs/a first")
            Directory.CreateDirectory(current)
            File.WriteAllText(Path.Combine(current, "run.json"), record.ToJsonString())
            temp.Env["XDG_STATE_HOME"] = stateHome
            let combined = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\nh\nq\n")
            Check.Success(combined)
            Check.Contains(combined.Output, "1  ")
            Check.Contains(combined.Output, "2  ")
            Check.Contains(combined.Output.Replace("\r\n", " ").Replace("\n", " "), "previous storage")
            Check.That(Check.Hash(Path.Combine(first, "run.json")) == firstBytes, "XDG discovery migrated old work")
            temp.Env.Remove("XDG_STATE_HOME")
            record["model"] = JsonValue.Create(String('x', 257))
            File.WriteAllText(Path.Combine(first, "run.json"), record.ToJsonString())
            let empty = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\nq\n")
            Check.Success(empty)
            Check.Contains(empty.Output, "No readable saved contributions were found.")
            Check.That(!empty.Output.Contains("Saved contribution number"), "Empty list requested a selection")
            for index in 0 ... 130 {
                Directory.CreateDirectory(Path.Combine(root, "extra-" + index.ToString()))
            }
            let bounded = TestProcess.Run("/usr/bin/script", command, temp.Env, input: "3\nh\nq\n")
            Check.Success(bounded)
            Check.Contains(bounded.Output, "Showing the first 128 inspected entries.")
            Console.WriteLine(
                "PASS offline saved contribution selection, cancellation, invalid and linked metadata, bounded discovery, private state preservation and action reset"
            )
        }

        internal func All(binary string, shell string = "bash") {
            if shell == "bash" {
                Structured(binary)
                TerminalOutput.All(binary)
                Saved(binary)
            }
            Contract(binary, shell)
        }

        internal func Contract(binary string, shell string = "bash") {
            Check.That(shell == "bash" || shell == "zsh" || shell == "fish", "Choose bash, zsh or fish")
            using let temp = Temp()
            let bin = Path.Combine(temp.Root, "bin")
            let log = Path.Combine(temp.Root, "calls")
            for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
                let tool = Path.Combine(bin, name)
                File.WriteAllText(
                    tool,
                    "#!/bin/sh\nprintf '%s\\n' '" +
                        name +
                        "' \"$$@\" >> '" +
                        log +
                        "'\ntest \"$1\" = --version && exit 0\nexit 17\n"
                )
                File.SetUnixFileMode(tool, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            }
            for argv in[][]string{[]string{}, []string{"--help"}, []string{"-h"}, []string{"help"}} {
                let help = Call(binary, argv, temp)
                Check.Contains(help.Output, "toh-KAH-teh")
                Check.That(help.Error == "", "Help wrote warnings")
                Check.That(
                    !help.Output.Contains("repo> ") && !help.Output.Contains("tokate> "),
                    "Redirected entry or explicit help started an interactive view"
                )
            }
            for command in Commands {
                if command == "help" {
                    continue
                }
                for argv in[][]string{[]string{command, "--help"}, []string{command, "-h"}, []string{"help", command}} {
                    let help = Call(binary, argv, temp)
                    Check.Contains(help.Output, "Usage: tokate " + command)
                    Check.Contains(help.Output, "Example:")
                    Check.That(help.Error == "", "Command help wrote warnings")
                }
            }
            let work = Call(binary, []string{"work", "--help"}, temp).Output
            Check.Contains(work, "inference")
            Check.Contains(work, "publication step")
            Check.Contains(work, "Explicit budget 1..86400 seconds")
            Check.Contains(work, "(required)")
            Check.Contains(work, "use --run DIR instead of required inputs")
            Check.That(!work.Contains("tokate doctor"), "Work help repeats global help")
            Check.Contains(Call(binary, []string{"recover", "-h"}, temp).Output, "default: 300")

            for argv in[][]string{
                []string{"nonsense", "--help"},
                []string{"help", "nonsense"},
                []string{"help", "work", "extra"},
                []string{"work", "--unknown=value", "--help"},
                []string{"work", "--issue=1", "--issue", "1"},
                []string{"work", "--help", "-h"},
                []string{"work", "--model="},
                []string{"work", "--model", "--help"},
                []string{"checks", "--watch=true"},
                []string{"work", "--allow-network=false"},
                []string{"checks", "--run=x", "--pr=1"},
                []string{"checks", "--run=x", "--repo=owner/project"},
                []string{"work", "--run=x", "--seconds=1"},
                []string{"work", "--run=x", "https://github.com/owner/project/issues/1"},
                []string{"recover", "--run=x", "--seconds=0"},
                []string{"checks", "--run=x", "--timeout=86401"},
                []string{"verify-pr", "--repo=owner/project", "--pr=no"},
                []string{"approve", "--base-branch=bad..branch", "--help"},
                []string{"approve", "--base-branch=release//next", "--help"},
                []string{"approve", "--base-branch=release.lock", "--help"},
                []string{"approve", "--base-branch=refs/heads/.hidden", "--help"},
                []string{"approve", "--base-branch=release", "--base-branch=other", "--help"},
                []string{"work", "--base-branch=release", "--help"},
                []string{"revoke", "--repo=owner/project", "--issue=-1"},
                []string{"work", "--repo=owner/project", "--issue=1", "--model=model", "--effort=invalid"},
                []string{"work", "--repo=owner/project", "--issue=1", "--model=bad model", "--effort=high"},
                []string{"revoke", "--repo=other/project", "--issue=https://github.com/owner/project/issues/1"},
                []string{"revoke", "--issue=2", "https://github.com/owner/project/issues/1"},
                []string{"revoke", "--issue=https://github.com/owner/project/pull/1"},
                []string{"revoke", "--issue=https://example.test/owner/project/issues/1"},
                []string{"work", "owner/project", "--repo=other/project", "--issue=1"},
                []string{"work", "https://example.test/owner/project"},
                []string{"checks", "https://github.com/owner/project/pull/1", "--pr=2"},
                []string{"checks", "https://github.com/owner/project/pull/1", "--repo=other/project"},
                []string{"checks", "https://example.test/owner/project/pull/1"},
                []string{"work", "owner/project", "--run=x"},
                []string{"revoke", "--issue=https://github.com/owner/project/issues/0"},
                []string{"revoke", "--issue=https://github.com/owner/project/issues/999999999999"},
                []string{
                    "prepare",
                    "--repo=owner/project",
                    "--issue=1",
                    "--state=bad",
                    "--source=external",
                    "--tools=tools.json"
                },
                []string{"prepare", "--repo=owner/project", "--issue=1", "--source=invalid"},
                []string{"external", "--run=x", "--commit=HEAD"},
                []string{"request", "--repo=owner/project", "--issue=1"},
                []string{"coordinator-setup", "--repo=owner/project"},
                []string{"coordinate", "--repo=owner/project"},
                []string{"submit"},
                []string{"completion"},
                []string{"completion", "powershell"},
                []string{"completion", "powershell", "--help"},
                []string{"completion", "bash", "extra"},
                []string{"status", "--run=x", "--repo=owner/project"}
            } {
                Check.Contains(Call(binary, argv, temp, 1).Error, "Usage:")
            }
            let saved = Path.Combine(temp.Root, "run")
            Directory.CreateDirectory(saved)
            File.WriteAllText(Path.Combine(saved, "run.json"), "{\"version\":2,\"state\":\"claimed\"}")
            Check.Contains(Call(binary, []string{"status", "--run=" + saved}, temp).Output, "claimed")
            Check.That(!File.Exists(log), "Help or invalid inputs invoked a tool")

            {
                let script = Call(binary, []string{"completion", shell}, temp).Output
                let path = Path.Combine(temp.Root, "completion." + shell)
                File.WriteAllText(path, script)
                Check.Success(TestProcess.Run("/usr/bin/" + shell, []string{"-n", path}, temp.Env))
                var command string
                var args[]string
                if shell == "bash" {
                    let spaced = Path.Combine(temp.Root, "run with spaces")
                    Directory.CreateDirectory(spaced)
                    command = "source '" +
                        path +
                        "'; COMP_WORDS=(tokate work --mo); COMP_CWORD=2; _tokate; printf '%s\\n' \"$${COMPREPLY[@]}\"; " +
                        "COMP_WORDS=(tokate work --effort=hi); _tokate; printf '%s\\n' \"$${COMPREPLY[@]}\"; " +
                        "COMP_WORDS=(tokate work '--runs=" +
                        temp.Root +
                        "/run w'); _tokate; printf '%s\\n' \"$${COMPREPLY[@]}\""
                    args = []string{"--noprofile", "--norc", "-c", command}
                } else if shell == "zsh" {
                    command = "autoload -Uz compinit; compinit -D; source '" +
                        path +
                        "'; " +
                        "_arguments() { if [[ $$1 == -C ]]; then state=args; line=(work); else print -rl -- \"$$@\"; fi; }; _tokate"
                    args = []string{"-f", "-c", command}
                } else {
                    command = "source '" +
                        path +
                        "'; complete -C 'tokate work --mo'; complete -C 'tokate work --effort=hi'"
                    args = []string{"--no-config", "-c", command}
                }
                let output = Check.Success(TestProcess.Run("/usr/bin/" + shell, args, temp.Env))
                Check.Contains(output, "--model")
                Check.Contains(output, shell == "zsh" ? "--effort=": "--effort=high")
                if shell == "bash" {
                    Check.Contains(output, "--runs=" + Path.Combine(temp.Root, "run with spaces"))
                }
                if shell == "zsh" {
                    File.Copy(path, Path.Combine(temp.Root, "_tokate"))
                    let autoload = "fpath=('" +
                        temp.Root +
                        "' $$fpath); autoload -Uz _tokate; " +
                        "_arguments() { if [[ $$1 == -C ]]; then state=args; line=(work); else print -rl -- \"$$@\"; fi; }; _tokate"
                    Check.Contains(
                        Check.Success(TestProcess.Run("/usr/bin/zsh", []string{"-f", "-c", autoload}, temp.Env)),
                        "--model"
                    )
                }
            }
            Check.That(!File.Exists(log), "Completion invoked a tool")
            let empty = Path.Combine(temp.Root, "empty")
            Directory.CreateDirectory(empty)
            let originalPath = temp.Env["PATH"]
            temp.Env["PATH"] = empty
            Call(binary, []string{"work", "--help"}, temp)
            Call(binary, []string{"help", "work"}, temp)
            Call(binary, []string{"-h"}, temp)
            Call(binary, []string{"completion", "bash"}, temp)
            Check.Contains(Call(binary, []string{"work"}, temp, 1).Error, "Required: --issue")
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "use --repo OWNER/REPO")
            temp.Env["PATH"] = originalPath

            File.Delete(Path.Combine(bin, "setsid"))
            File.CreateSymbolicLink(Path.Combine(bin, "setsid"), "/usr/bin/setsid")
            for argv in[][]string{
                []string{"policy", "owner/project"},
                []string{"policy", "https://github.com/owner/project"},
                []string{"checks", "https://github.com/owner/project/pull/1"},
                []string{"verify-pr", "https://github.com/owner/project/pull/1"},
                []string{"work", "https://github.com/owner/project/issues/1", "--model=model", "--effort=high"},
                []string{"work", "--issue=https://github.com/owner/project/issues/1", "--model=model", "--effort=high"},
                []string{
                    "work",
                    "--repo=OWNER/project",
                    "--issue=01",
                    "https://github.com/owner/project/issues/1#issuecomment-2",
                    "--model=model",
                    "--effort=high"
                }
            } {
                let result = TestProcess.Run(binary, argv, temp.Env, cwd: temp.Root)
                Check.That(result.Code == 1, "Recording gh stub should fail")
                Check.Contains(File.ReadAllText(log), "gh\napi\n")
                Check.That(!result.Error.Contains("Usage:"), "Valid URL input rejected")
                File.Delete(log)
            }
            temp.Tool("holder")
            using let listener = Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            listener.Bind(Address(temp.Root))
            listener.Listen(1)
            let observed = Chan[string](1)
            go Observe(listener, observed)
            File.WriteAllText(
                Path.Combine(bin, "git"),
                "#!/bin/sh\nprintf '%s' \"$$LANG\" > child-lang\n" +
                    "[ -z \"$${LC_ALL+x}\" ] && : > child-lc-all-unset\n" +
                    "/usr/bin/setsid ./bin/holder --discovery-holder &\ni=0\n" +
                    "while [ ! -f holder-ready ] && [ \"$$i\" -lt 500 ]; do /bin/sleep 0.01; i=$$((i + 1)); done\n" +
                    "[ -f holder-ready ]\n"
            )
            let clock = Stopwatch.StartNew()
            let discovery = Call(binary, []string{"policy"}, temp, 1)
            let pid = <-observed
            Check.That(!pid.StartsWith("error:"), pid)
            Check.That(clock.Elapsed.TotalSeconds < 8, "Repository discovery exceeded its cleanup bound")
            Check.Contains(discovery.Error, "Ambiguous or unsupported local remotes")
            Check.That(
                File.ReadAllText(Path.Combine(temp.Root, "child-lang")) == temp.Env["LANG"],
                "Child LANG changed"
            )
            Check.That(File.Exists(Path.Combine(temp.Root, "child-lc-all-unset")), "Child LC_ALL changed")
            Collected(pid)
            Check.That(!File.Exists(log), "Failed repository discovery invoked GitHub")
            File.WriteAllText(Path.Combine(bin, "git"), "#!/bin/sh\n: > namespace-command-started\n")
            let unavailable = TestProcess.Run(
                "/usr/bin/bwrap",
                []string{
                    "--unshare-user",
                    "--unshare-pid",
                    "--disable-userns",
                    "--bind",
                    "/",
                    "/",
                    "--",
                    binary,
                    "policy",
                    "--json"
                },
                temp.Env,
                cwd: temp.Root
            )
            let blocked = Check.Envelope(unavailable, "policy", "error", "namespace_unavailable")
            Check.Contains(Check.Text(blocked["error"]?["message"]), "Namespace startup failed")
            Check.That(
                !File.Exists(Path.Combine(temp.Root, "namespace-command-started")),
                "Git ran without a namespace"
            )
            let doctor = TestProcess.Run(
                "/usr/bin/bwrap",
                []string{
                    "--unshare-user",
                    "--disable-userns",
                    "--bind",
                    "/",
                    "/",
                    "--",
                    binary,
                    "doctor",
                    "--external",
                    "--json"
                },
                temp.Env,
                cwd: temp.Root
            )
            let restricted = Check.Envelope(doctor, "doctor", "error", "namespace_unavailable")
            Check.That(
                Check.Text(restricted["data"]?["tools"]?[0]?["code"]) == "namespace_unavailable",
                "Doctor mislabeled namespace failure as missing tools"
            )
            Check.That(
                restricted["next_actions"]?.AsArray().Count == 0,
                "Doctor offered installation for blocked namespaces"
            )
            File.Delete(Path.Combine(bin, "git"))
            File.CreateSymbolicLink(Path.Combine(bin, "git"), "/usr/bin/git")
            Check.Success(TestProcess.Run("/usr/bin/git", []string{"init", "-b", "main", temp.Root}, temp.Env))
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "No GitHub remote")
            Check.Success(
                TestProcess.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "add", "origin", "git@github.com:owner/project.git"},
                    temp.Env
                )
            )
            let policy = TestProcess.Run(binary, []string{"policy"}, temp.Env, cwd: temp.Root)
            Check.That(policy.Code == 1 && !policy.Error.Contains("Usage:"), "Unique remote rejected")
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            File.Delete(log)
            let nested = Path.Combine(temp.Root, "subdirectory")
            Directory.CreateDirectory(nested)
            let fromSubdirectory = TestProcess.Run(binary, []string{"policy"}, temp.Env, cwd: nested)
            Check.That(
                fromSubdirectory.Code == 1 && !fromSubdirectory.Error.Contains("Usage:"),
                "Repository subdirectory rejected"
            )
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            File.Delete(log)
            Check.Success(
                TestProcess.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "add", "upstream", "https://github.com/OWNER/project.git"},
                    temp.Env
                )
            )
            let same = TestProcess.Run(binary, []string{"policy"}, temp.Env, cwd: temp.Root)
            Check.That(same.Code == 1 && !same.Error.Contains("Usage:"), "Equivalent remotes rejected")
            File.Delete(log)
            Check.Success(
                TestProcess.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "set-url", "upstream", "https://github.com/other/project.git"},
                    temp.Env
                )
            )
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "Ambiguous local remotes")
            Check.That(!File.Exists(log), "Ambiguous remotes invoked GitHub")
            let urlOverride = TestProcess.Run(
                binary,
                []string{"work", "https://github.com/owner/project/issues/1", "--model=model", "--effort=high"},
                temp.Env,
                cwd: temp.Root
            )
            Check.That(
                urlOverride.Code == 1 && !urlOverride.Error.Contains("Usage:"),
                "Issue URL did not override local context"
            )
            File.Delete(log)
            Check.Success(
                TestProcess.Run("/usr/bin/git", []string{"-C", temp.Root, "remote", "remove", "upstream"}, temp.Env)
            )
            Check.Success(
                TestProcess.Run(
                    "/usr/bin/git",
                    []string{
                        "-C",
                        temp.Root,
                        "remote",
                        "set-url",
                        "--push",
                        "origin",
                        "https://github.com/other/project.git"
                    },
                    temp.Env
                )
            )
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "Ambiguous local remotes")
            Check.That(!File.Exists(log), "Conflicting push remote invoked GitHub")
            let explicitRepo = TestProcess.Run(
                binary,
                []string{"policy", "--repo=https://github.com/owner/project.git"},
                temp.Env,
                cwd: temp.Root
            )
            Check.That(
                explicitRepo.Code == 1 && !explicitRepo.Error.Contains("Usage:"),
                "Explicit repo did not override local context"
            )
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            Check.That(!File.ReadAllText(log).Contains("codex"), "Unexpected inference")
            Check.That(!File.ReadAllText(log).Contains("POST"), "Unexpected remote mutation")
            Console.WriteLine(
                "PASS CLI discovery: help, validation, equals syntax, URL/context, completion and missing tools"
            )
        }
    }
}
