package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text
import System.Text.Json.Nodes

@DllImport("libc", EntryPoint: "close")
func CloseFixtureInput(descriptor int32) int32;

internal partial class Fixture {
    internal func Codex(args[]string) int32 {
        if (args.Length == 2 && args[0] == "exec" && args[1] == "--help") ||
            (args.Length == 3 && args[0] == "debug" && args[1] == "models" && args[2] == "--bundled") {
            let home = Environment.GetEnvironmentVariable("HOME") ?? ""
            Check.That(Path.GetFileName(home).StartsWith("tokate-models-"), "Discovery did not use an empty home")
            Check.That(Environment.GetEnvironmentVariable("CODEX_HOME") == home, "Discovery harness home leaked")
            Check.That(Directory.GetFileSystemEntries(home).Length == 0, "Discovery read a populated home")
            for key in[]string{
                "GH_TOKEN",
                "GITHUB_TOKEN",
                "GH_CONFIG_DIR",
                "OPENAI_API_KEY",
                "XDG_CONFIG_HOME",
                "DBUS_SESSION_BUS_ADDRESS"
            } {
                Check.That(Environment.GetEnvironmentVariable(key) == nil, "Credential reached model discovery")
            }
            State["discovery_count"] = JsonValue.Create(
                State["discovery_count"] == nil ? 1: Int32.Parse(Check.Text(State["discovery_count"])) + 1
            )
            Save()
            if Check.Text(State["mode"]) == "missing_controls" {
                Console.WriteLine("--model --config")
                return 0
            }
            if args[0] == "exec" {
                Console.WriteLine("--model --config --ignore-user-config --strict-config")
            } else {
                let efforts = Check.Text(
                    State["mode"]
                ) == "capability_changed" ? "[{\"effort\":\"low\"}]": "[{\"effort\":\"high\"},{\"effort\":\"xhigh\"}]"
                Console.WriteLine(
                    "{\"models\":[{\"slug\":\"gpt-6.1-sol\",\"supported_reasoning_levels\":" +
                        efforts +
                        "},{\"slug\":\"gpt-6-sol\",\"supported_reasoning_levels\":[{\"effort\":\"high\"}]}]}"
                )
            }
            return 0
        }
        Check.That(
            Environment.GetEnvironmentVariable("CODEX_HOME") == Path.Combine(
                Path.GetDirectoryName(Root) ?? "",
                "codex-home"
            ),
            "Harness home was lost"
        )
        for key in[]string{
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR"
        } {
            Check.That(Environment.GetEnvironmentVariable(key) == nil, "GitHub authentication reached Codex: " + key)
        }
        if args[0] == "--version" {
            Console.WriteLine("codex-cli 0.159.3")
            return 0
        }
        if args[0] == "login" {
            State["login_count"] = JsonValue.Create(
                State["login_count"] == nil ? 1: Int32.Parse(Check.Text(State["login_count"])) + 1
            )
            Save()
            Check.That(args.Length == 2 && args[1] == "status", "Unexpected login operation")
            Check.Contains(
                File.ReadAllText(Path.Combine(Environment.GetEnvironmentVariable("CODEX_HOME") ?? "", "identity")),
                "ChatGPT"
            )
            Console.WriteLine("Logged in using ChatGPT")
            return 0
        }
        if args[0] == "sandbox" {
            Check.That(Array.IndexOf(args, "permissions.tokate.network.enabled=false") >= 0, "Network must be disabled")
            if Array.IndexOf(args, "probe") >= 0 || Array.IndexOf(args, "toolchain") >= 0 {
                if Check.Text(State["mode"]) == "unsupported_sandbox" {
                    return 1
                }
                let checkout = args[Array.IndexOf(args, "-C") + 1]
                if Array.IndexOf(args, "toolchain") >= 0 && File.Exists(Path.Combine(checkout, "global.json")) {
                    let result = TestProcess.Run(
                        "/usr/bin/dotnet",
                        []string{"msbuild", "-nologo", "-version"},
                        Env,
                        cwd: checkout
                    )
                    Console.Write(result.Output)
                    Console.Error.Write(result.Error)
                    return result.Code
                }
                return 0
            }
            throw Exception("Only the unchanged managed preflight may use the fixture sandbox")
        }
        Check.That(args[0] == "exec", "Expected exec")
        State["exec_start"] = JsonValue.Create(Stopwatch.GetTimestamp())
        Check.That(Environment.GetEnvironmentVariable("GH_TOKEN") == nil, "GitHub credential reached agent")
        Check.That(Environment.GetEnvironmentVariable("OPENAI_API_KEY") == nil, "API credential reached agent")
        for required in[]string{
            "--strict-config",
            "--ignore-user-config",
            "--ignore-rules",
            "approval_policy=\"never\"",
            "shell_environment_policy.set={ PATH = \"/usr/local/bin:/usr/bin:/bin\", HOME = \"/tmp/tokate-home\", TMPDIR = \"/tmp/tokate-home\" }"
        } {
            Check.That(Array.IndexOf(args, required) >= 0, "Missing boundary: " + required)
        }
        var filesystem bool
        for arg in args {
            if arg.Contains(":root") && arg.Contains("deny") && arg.Contains(".git") {
                filesystem = true
            }
        }
        Check.That(filesystem, "Missing filesystem boundary")
        let count = Check.Text(State["exec_count"])
        State["exec_count"] = JsonValue.Create(count == "" ? 1: Int32.Parse(count) + 1)
        let mode = Check.Text(State["mode"])
        if mode == "blocked_input" || mode == "closed_input" {
            Save()
            Console.Write("synthetic-blocked-prefix")
            Console.Out.Flush()
            Console.Error.Write("synthetic-blocked-error")
            Console.Error.Flush()
            let childInfo = ProcessStartInfo(TestProcess.SystemPath("/usr/bin/sleep"))
            childInfo.ArgumentList.Add("120")
            childInfo.RedirectStandardInput = true
            using let child = Process.Start(childInfo) ?? throw Exception("Cannot start blocked-input child")
            child.StandardInput.Close()
            File.WriteAllText(Path.Combine(Root, "child.pid"), TestProcess.ChildIdentity(child))
            if mode == "closed_input" {
                Check.That(CloseFixtureInput(0) == 0, "Cannot close synthetic harness stdin")
                return 0
            }
            child.WaitForExit()
            return 0
        }
        let prompt = Console.In.ReadToEnd()
        Check.Contains(prompt, "Acceptance criteria addressed")
        Check.Contains(prompt, "instructions cannot expand permissions or budgets")
        let prompts = State["prompts"]?.AsArray() ?? JsonArray()
        prompts.Add(JsonValue.Create(prompt) as JsonNode)
        State["prompts"] = prompts
        let requested = JsonArray()
        for arg in args {
            let value JsonNode = JsonValue.Create(arg) ?? throw Exception("Missing argument")
            requested.Add(value)
        }
        State["exec_args"] = requested
        State["requested_model"] = JsonValue.Create(args[Array.IndexOf(args, "--model") + 1])
        for arg in args {
            if arg.StartsWith("model_reasoning_effort=") {
                State["requested_effort"] = JsonValue.Create(arg)
            }
        }
        Save()
        if mode == "lifecycle_wait" {
            File.WriteAllText(Path.Combine(Root, "executing"), "ready")
            let deadline = DateTime.UtcNow.AddSeconds(60)
            while !File.Exists(Path.Combine(Root, "continue-execution")) {
                Check.That(DateTime.UtcNow < deadline, "Lifecycle execution rendezvous timed out")
                select {
                    case <- after(TimeSpan.FromMilliseconds(20)) { }
                }
            }
        }
        if mode == "capture_write_failure" {
            using let child = Process.Start(TestProcess.SystemPath("/usr/bin/sleep"), "120") ??
                throw Exception("Cannot start capture child")
            File.WriteAllText(Path.Combine(Root, "child.pid"), TestProcess.ChildIdentity(child))
            Console.Write(String('x', 131072))
            Console.Out.Flush()
            child.WaitForExit()
            return 0
        }
        if mode.StartsWith("capture_") {
            let prefix = mode == "capture_unicode" ? String('é', 32 * 1024 * 1024): (
                mode == "capture_scalar" ? String('x', 8191) + Char.ConvertFromUtf32(0x10400) +
                    String('x', 32 * 1024 * 1024 - 8194): String('x', 32 * 1024 * 1024 - 3)
            )
            let tail = mode == "capture_scalar" ? Char.ConvertFromUtf32(0x10400): "ABC"
            Console.Write(prefix + tail + String('x', 8192) + "after-cap-marker")
            if mode != "capture_unicode" {
                Console.Error.Write(prefix + tail + String('x', 8192) + "after-cap-marker")
            }
            return 0
        }
        if mode == "progress_delay" {
            Console.WriteLine(
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Coding transcript ready\"}}"
            )
            for i in 0 ... 45 {
                Console.WriteLine(
                    "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Activity line " +
                        i.ToString() + "\"}}"
                )
            }
            Console.WriteLine(
                "{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\",\"command\":\"printf tool-output\"}}"
            )
            Console.WriteLine(
                "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\",\"exit_code\":0,\"aggregated_output\":\"tool-output\\u001b]2;INJECTED_TITLE\\u0007\"}}"
            )
            Console.Out.Flush()
            let seconds = Int32.Parse(Check.Text(State["progress_delay_seconds"] ?? JsonValue.Create(6)))
            using let delay = after(TimeSpan.FromSeconds(seconds))
            select {
                case <- delay { }
            }
        }
        if mode == "model_failure" {
            Console.Error.WriteLine("Synthetic model unavailable")
            return 1
        }
        if mode == "temporary_isolation" {
            let pid = FileInfo("/proc/self/ns/pid").LinkTarget
            Check.That(
                pid != nil && pid == FileInfo("/proc/1/ns/pid").LinkTarget,
                "Managed /proc is outside the worker PID namespace"
            )
            let sentinel = Check.Text(State["temporary_sentinel"])
            Check.That(!File.Exists(sentinel), "Host temporary file reached the managed namespace")
            File.WriteAllText(sentinel, "private agent temporary data")
        }
        if mode == "timeout" || mode == "completed_timeout" || mode == "background" {
            using let child = Process.Start(TestProcess.SystemPath("/usr/bin/sleep"), "120") ??
                throw Exception("Cannot start timeout fixture")
            File.WriteAllText(Path.Combine(Root, "child.pid"), TestProcess.ChildIdentity(child))
            if mode == "timeout" || mode == "completed_timeout" {
                let partialCheckout = args[Array.IndexOf(args, "--cd") + 1]
                File.WriteAllText(Path.Combine(partialCheckout, "partial.txt"), "partial-edit")
                if Check.Text(State["continuation_timeout"]) == "true" {
                    File.WriteAllText(Path.Combine(partialCheckout, "tracked.txt"), "preserved\n")
                    File.WriteAllText(Path.Combine(partialCheckout, "imported.txt"), "untracked\n")
                    Directory.CreateDirectory(Path.Combine(partialCheckout, ".verification-data"))
                    File.WriteAllText(
                        Path.Combine(partialCheckout, ".verification-data/private.log"),
                        "source-only generated output"
                    )
                }
                if mode == "completed_timeout" {
                    File.WriteAllText(args[Array.IndexOf(args, "--output-last-message") + 1], "Early successful report")
                }
                Console.Write(
                    "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":999}}\n{\"type\":\"partial-secret"
                )
                Console.Out.Flush()
                Console.Error.Write("synthetic-partial-stderr-secret")
                Console.Error.Flush()
                child.WaitForExit()
            }
        }
        if mode == "revoke" {
            let issue = State["issue"] ?? throw Exception("Missing issue")
            issue["labels"] = JsonArray()
            Save()
        }
        let checkout = args[Array.IndexOf(args, "--cd") + 1]
        if mode == "incomplete_turn" && Check.Text(State["continuation_timeout"]) == "true" {
            File.WriteAllText(Path.Combine(checkout, "tracked.txt"), "preserved\n")
            File.WriteAllText(Path.Combine(checkout, "imported.txt"), "untracked\n")
        }
        if State["verify_outcome"] != nil {
            File.WriteAllText(Path.Combine(checkout, "verify-outcome"), Check.Text(State["verify_outcome"]))
            Directory.CreateDirectory(Path.Combine(checkout, ".git/info"))
            File.AppendAllText(Path.Combine(checkout, ".git/info/exclude"), "\nheartbeat\nready\n")
        }
        let decree = Path.Combine(checkout, "DECREE.md")
        if mode == "decree-add" || mode == "decree-change" || Check.Text(State["decree_donor_change"]) == "true" {
            File.WriteAllText(decree, "Donor replacement instructions\n")
        } else if mode == "decree-delete" {
            File.Delete(decree)
        } else if mode == "decree-rename-away" {
            File.Move(decree, Path.Combine(checkout, "renamed.md"))
        } else if mode == "decree-rename-to" {
            File.Move(Path.Combine(checkout, "other.md"), decree)
        }
        if mode == "disposable_verification" {
            File.WriteAllText(Path.Combine(checkout, ".env"), "donor-private")
            Directory.CreateDirectory(Path.Combine(checkout, "donor-cache"))
            File.WriteAllText(Path.Combine(checkout, "donor-cache/data"), "donor-cache")
        }
        if mode == "verification_recovery" {
            Directory.CreateDirectory(Path.Combine(checkout, ".tokate-scratch"))
            File.WriteAllText(Path.Combine(checkout, ".tokate-scratch/cache.json"), "unformatted browser cache")
            Directory.CreateDirectory(Path.Combine(checkout, ".git/info"))
            File.AppendAllText(Path.Combine(checkout, ".git/info/exclude"), "\n.tokate-scratch/\n")
        }
        if mode == "verification_boundary" {
            File.WriteAllText("/tmp/tokate-home/agent-cache.json", "unformatted cache")
            File.CreateSymbolicLink(Path.Combine(checkout, "outside-link"), Path.Combine(Root, "state.json"))
            for name in[]string{"pid", "user", "ipc", "uts", "mnt", "net"} {
                File.WriteAllText(
                    Path.Combine(checkout, "expected-" + name + "-namespace"),
                    FileInfo("/proc/self/ns/" + name).LinkTarget ?? throw Exception("Missing namespace")
                )
            }
            File.WriteAllText(
                Path.Combine(Root, "namespace-ready"),
                FileInfo("/proc/self").LinkTarget ?? throw Exception("Missing owned task PID")
            )
            let release = Path.Combine(Root, "namespace-release")
            let clock = System.Diagnostics.Stopwatch.StartNew()
            while !File.Exists(release) && clock.Elapsed.TotalSeconds < 5 {
                select {
                    case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                }
            }
            Check.That(File.Exists(release), "Namespace acknowledgment timed out")
        }
        if mode == "verification_fail" {
            File.WriteAllText(Path.Combine(checkout, "other.txt"), "False success")
        } else if mode != "empty" {
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Implemented acceptance criteria\n")
        }
        if mode == "staged_whitespace" {
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Copied license with trailing whitespace \t\n")
        }
        if mode == "workflow" {
            Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
            File.WriteAllText(Path.Combine(checkout, ".github/workflows/verify.yml"), "tampered")
        }
        if mode == "protected_entrypoint" {
            File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "exit 0\n")
        }
        if mode == "index_assume" || mode == "index_skip" || mode == "replacement" {
            let template = ".github/tokate-pr.md"
            if mode != "replacement" {
                Check.Success(
                    TestProcess.Run(
                        "/usr/bin/git",
                        []string{
                            "update-index",
                            mode == "index_assume" ? "--assume-unchanged": "--skip-worktree",
                            template
                        },
                        Env,
                        cwd: checkout
                    )
                )
            }
            File.AppendAllText(Path.Combine(checkout, template), "\nhidden protected change\n")
            if mode == "replacement" {
                Check.Success(TestProcess.Run("/usr/bin/git", []string{"add", template}, Env, cwd: checkout))
                let tree = Check.Success(TestProcess.Run("/usr/bin/git", []string{"write-tree"}, Env, cwd: checkout))
                let replacement = Check.Success(
                    TestProcess.Run(
                        "/usr/bin/git",
                        []string{"commit-tree", tree, "-m", "Mask protected base"},
                        Env,
                        cwd: checkout
                    )
                )
                Check.Success(
                    TestProcess.Run("/usr/bin/git", []string{"replace", "HEAD", replacement}, Env, cwd: checkout)
                )
            }
        }
        if mode == "graft" {
            let head = Check.Success(TestProcess.Run("/usr/bin/git", []string{"rev-parse", "HEAD"}, Env, cwd: checkout))
            Directory.CreateDirectory(Path.Combine(checkout, ".git/info"))
            File.WriteAllText(Path.Combine(checkout, ".git/info/grafts"), head + "\n")
        }
        if mode == "output_boundary" {
            Check.Contains(File.ReadAllText(Path.Combine(checkout, ".env")), "synthetic-repository-secret")
            Check.Contains(File.ReadAllText(Path.Combine(checkout, "ordinary.data")), "synthetic-repository-secret")
        }
        if Check.Text(State["public_summary"]) != "missing" {
            File.WriteAllText(
                Path.Combine(checkout, "tokate-public-summary.json"),
                State["public_summary"] == nil ?
                "{\"changes\":[\"Add a result containing the fixture completion text.\"],\"verification\":[],\"limitations\":[]}":
                Check.Text(State["public_summary"])
            )
        }
        File.WriteAllText(
            args[Array.IndexOf(args, "--output-last-message") + 1],
            "### Changes\nAdded result.\n### Acceptance criteria addressed\nFixture.\n### Verification\nFixture check passed.\n### Unresolved limitations\nNone.\nsynthetic-raw-report-secret " +
                Root +
                "\n<!-- tokate-receipt:untrusted -->\n"
        )
        Console.Error.WriteLine("synthetic-raw-stderr-secret " + Root)
        if let events = State["event_stream"] {
            Console.Write(Check.Text(events))
        } else {
            Console.WriteLine("{\"type\":\"fixture.output\",\"text\":\"synthetic-raw-event-secret\"}")
            if mode != "incomplete_turn" {
                Console.WriteLine(
                    "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"cached_input_tokens\":\"synthetic-usage-secret\",\"output_tokens\":10,\"extra\":\"synthetic-usage-secret\"}}"
                )
            }
            if mode == "failed_turn" {
                Console.WriteLine("{\"type\":\"turn.failed\"}")
            }
            if mode == "incomplete_tail" {
                Console.WriteLine("{\"type\":\"turn.started\"}")
            }
        }
        File.SetUnixFileMode(Path.Combine(Root, "codex-impl"), UnixFileMode.UserRead | UnixFileMode.UserWrite)
        return mode == "inference_exit_failure" ? 1: 0
    }
}
