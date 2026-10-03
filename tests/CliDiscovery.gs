package TokateTests

import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.Json.Nodes
import Tokate

internal class CliDiscovery {
    shared {
        internal func Call(binary string, args[]string, temp Temp, code int32 = 0) Result {
            let result = Check.Run(binary, args, temp.Env, cwd: temp.Root)
            Check.That(result.Code == code, result.Output + result.Error)
            Check.That(!result.Error.Contains("Missing tools"), "Prerequisites checked before validation")
            return result
        }

        internal func Envelope(result Result, command string, status string, error string = "") JsonNode {
            let value = Check.Json(result.Output)
            Check.That(value.AsObject().Count == 8, "Unexpected public envelope fields")
            Check.That(Check.Text(value["schema_version"]) == "1", "Missing output schema version")
            Check.That(Check.Text(value["command"]) == command, "Wrong result command")
            Check.That(Check.Text(value["status"]) == status, "Wrong result status")
            Check.That(Check.Text(value["exit_code"]) == result.Code.ToString(), "Envelope exit differs from process")
            Check.That(Encoding.UTF8.GetByteCount(result.Output) <= 65536, "Unbounded public output")
            Check.That(!result.Output.Contains('\u001b'), "JSON contains terminal styling")
            Check.That(
                Check.Text(value["error"]?["code"]) == error,
                "Wrong stable error identifier: expected " + error + ", got " + Check.Text(value["error"]?["code"]) +
                    "\n" +
                    result.Output +
                    result.Error
            )
            return value
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
            for command in Cli.Commands {
                let help = Envelope(Call(binary, []string{command.Name, "--help", "--json"}, temp), command.Name, "ok")
                if command.Name != "help" {
                    Check.That(
                        Check.Text(help["data"]?["commands"]?[0]?["command"]) == command.Name,
                        "Focused metadata missing command"
                    )
                }
            }
            let metadata = Envelope(Call(binary, []string{"help", "--json"}, temp), "help", "ok")
            Check.That(
                metadata["data"]?["commands"]?.AsArray().Count == Cli.Commands.Length,
                "Metadata omits public commands"
            )
            for command in metadata["data"]?["commands"]?.AsArray() ?? JsonArray() {
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
                []string{"amend", "--run", "saved", "--commit", String('a', 40) + "\n", "--seconds", "30", "--json"},
                []string{"approve", "--issue", "0", "--json"}
            } {
                Envelope(Call(binary, argv, temp, 1), argv[0], "error", "invalid_arguments")
            }
            Check.That(!File.Exists(calls), "Invalid inputs or metadata invoked prerequisites")
            let version = Envelope(Call(binary, []string{"--version", "--json"}, temp), "--version", "ok")
            Check.That(
                Call(binary, []string{"--version"}, temp).Output.Trim() == "tokate " + Check.Text(
                    version["data"]?["version"]
                ),
                "Structured and plain versions differ"
            )
            let defaults = Envelope(Call(binary, []string{"help", "defaults", "--json"}, temp), "help", "ok")["data"]?[
                "commands"
            ]?[0]
            Check.That(Check.Text(defaults?["effects"]?["local_write"]) == "true", "Defaults write effect missing")
            Check.That(
                defaults?["operations"]?[0]?["required_inputs"]?.AsArray().Count == 4,
                "Defaults set tuple missing"
            )
            Check.That(
                Check.Text(defaults?["operations"]?[1]?["effects"]?["local_write"]) == "false",
                "Defaults read advertised a write"
            )
            for name in[]string{"select", "amend"} {
                let command = Envelope(Call(binary, []string{"help", name, "--json"}, temp), "help", "ok")["data"]?[
                    "commands"
                ]?[0]
                Check.That(
                    Check.Text(command?["effects"]?["local_write"]) == "true" && Check.Text(
                        command?["effects"]?["github_read"]
                    ) == "true",
                    "Missing selection/amendment effects"
                )
                Check.That(Check.Text(command?["inference"]) == "false", "Selection/amendment advertised inference")
            }
            let workMetadata = Envelope(Call(binary, []string{"help", "work", "--json"}, temp), "help", "ok")
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
                let rejected = Envelope(Call(binary, argv, temp, 1), "work", "error", "invalid_arguments")
                Check.Contains(Check.Text(rejected["error"]?["message"]), "--run conflicts with --" + name)
            }
            Envelope(
                Call(binary, []string{"checks", "--run", "saved", "--watch", "--timeout", "1", "--json"}, temp, 1),
                "checks",
                "error",
                "invalid_state"
            )
            Envelope(
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
            Envelope(
                Call(binary, []string{"status", "--run", longPath, "--json"}, temp, 1),
                "status",
                "error",
                "invalid_state"
            )
            for shell in[]string{"bash", "zsh", "fish"} {
                let script = Envelope(Call(binary, []string{"completion", shell, "--json"}, temp), "completion", "ok")
                Check.That(
                    Check.Text(script["data"]?["script"]) == Call(binary, []string{"completion", shell}, temp).Output,
                    "Completion script was shortened"
                )
                Check.That(Check.Text(script["truncated"]) == "false", "Completion was truncated")
            }
            let brokenDoctor = Check.Run(binary, []string{"doctor", "--json"}, temp.Env)
            let broken = Envelope(brokenDoctor, "doctor", "error", "missing_tools")
            Check.That(Check.Text(broken["data"]?["tools"]?[0]?["status"]) == "failed", "Broken tool accepted")
            Check.That(
                !(brokenDoctor.Output + brokenDoctor.Error).Contains("synthetic-tool-error-marker"),
                "Raw diagnostic output leaked"
            )
            let empty = Path.Combine(temp.Root, "empty")
            Directory.CreateDirectory(empty)
            temp.Env["PATH"] = empty
            let doctor = Check.Run(binary, []string{"doctor", "--json"}, temp.Env)
            let diagnosis = Envelope(doctor, "doctor", "error", "missing_tools")
            Check.That(diagnosis["data"]?["tools"]?.AsArray().Count == 6, "Doctor omitted checks")
            Check.That(!doctor.Output.Contains("Tokate environment"), "Doctor emitted prose stdout")
            let blocked = Envelope(
                Check.Run(binary, []string{"policy", "--repo", "owner/project", "--json"}, temp.Env),
                "policy",
                "error",
                "missing_tools"
            )
            Check.That(Check.Text(blocked["next_actions"]?[0]?[1]) == "doctor", "Missing-tools action absent")
            let init = Path.Combine(temp.Root, "project")
            Envelope(Check.Run(binary, []string{"init", "--path", init, "--json"}, temp.Env), "init", "ok")
            Check.That(File.Exists(Path.Combine(init, ".github/tokate.json")), "JSON changed init effects")
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
                1,
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
            let statusResult = Check.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env)
            let status = Envelope(statusResult, "status", "ok")
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
            let legacy = Check.Run(binary, []string{"status", "--run", saved}, temp.Env)
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
            let stoppedResult = Check.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env)
            let stopped = Envelope(stoppedResult, "status", "ok")
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
            let correctedResult = Check.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env)
            let corrected = Envelope(correctedResult, "status", "ok")
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
            let pty = Check.Run(
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
            Envelope(pty, "status", "ok")
            record["commit"] = JsonValue.Create(String('a', 70000))
            File.WriteAllText(Path.Combine(saved, "run.json"), record.ToJsonString())
            Envelope(
                Check.Run(binary, []string{"status", "--run", saved, "--json"}, temp.Env),
                "status",
                "error",
                "output_too_large"
            )
            let longError = Envelope(
                Check.Run(binary, []string{"doctor", "--" + String('x', 6000), "--json"}, temp.Env),
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

        internal func All(binary string, shell string = "bash") {
            Structured(binary)
            Check.That(shell == "bash" || shell == "zsh" || shell == "fish", "Choose bash, zsh or fish")
            using let temp = Temp()
            let bin = Path.Combine(temp.Root, "bin")
            let log = Path.Combine(temp.Root, "calls")
            for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
                let tool = Path.Combine(bin, name)
                File.WriteAllText(tool, "#!/bin/sh\nprintf '%s\\n' '" + name + "' \"$$@\" >> '" + log + "'\nexit 17\n")
                File.SetUnixFileMode(tool, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            }
            for argv in[][]string{[]string{}, []string{"--help"}, []string{"-h"}, []string{"help"}} {
                let help = Call(binary, argv, temp)
                Check.Contains(help.Output, "toh-KAH-teh")
                Check.That(help.Error == "", "Help wrote warnings")
            }
            for command in Cli.Commands {
                if command.Name == "help" {
                    continue
                }
                for argv in[][]string{
                    []string{command.Name, "--help"},
                    []string{command.Name, "-h"},
                    []string{"help", command.Name}
                } {
                    let help = Call(binary, argv, temp)
                    Check.Contains(help.Output, "Usage: tokate " + command.Name)
                    Check.Contains(help.Output, "Example:")
                    Check.That(help.Error == "", "Command help wrote warnings")
                    for option in Cli.Options {
                        if command.Has(option.Name) {
                            Check.Contains(help.Output, "--" + option.Name)
                        }
                    }
                }
            }
            let work = Call(binary, []string{"work", "--help"}, temp).Output
            Check.Contains(work, "inference")
            Check.Contains(work, "publish a draft PR")
            Check.Contains(work, "default: min(3600, owner limit)")
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
                []string{"approve", "--repo=owner/project", "--issue=1"},
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
                []string{"status"}
            } {
                Check.Contains(Call(binary, argv, temp, 1).Error, "Usage:")
            }
            let saved = Path.Combine(temp.Root, "run")
            Directory.CreateDirectory(saved)
            File.WriteAllText(Path.Combine(saved, "run.json"), "{\"state\":\"claimed\"}")
            Check.Contains(Call(binary, []string{"status", "--run=" + saved}, temp).Output, "claimed")
            Check.That(!File.Exists(log), "Help or invalid inputs invoked a tool")

            {
                let script = Call(binary, []string{"completion", shell}, temp).Output
                let path = Path.Combine(temp.Root, "completion." + shell)
                File.WriteAllText(path, script)
                Check.Success(Check.Run("/usr/bin/" + shell, []string{"-n", path}, temp.Env))
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
                let output = Check.Success(Check.Run("/usr/bin/" + shell, args, temp.Env))
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
                        Check.Success(Check.Run("/usr/bin/zsh", []string{"-f", "-c", autoload}, temp.Env)),
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

            let input = Args(
                []string{
                    "revoke",
                    "--repo=OWNER/project",
                    "--issue=01",
                    "https://github.com/owner/project/issues/1#issuecomment-2"
                }
            )
            Cli.Validate(input)
            Check.That(
                input.Get("repo") == "owner/project" && input.Number("issue") == 1,
                "URL inputs were not normalized"
            )
            File.Delete(Path.Combine(bin, "setsid"))
            File.CreateSymbolicLink(Path.Combine(bin, "setsid"), "/usr/bin/setsid")
            for argv in[][]string{
                []string{"work", "https://github.com/owner/project/issues/1", "--model=model", "--effort=high"},
                []string{"work", "--issue=https://github.com/owner/project/issues/1", "--model=model", "--effort=high"}
            } {
                let result = Check.Run(binary, argv, temp.Env, cwd: temp.Root)
                Check.That(result.Code == 1, "Recording gh stub should fail")
                Check.Contains(File.ReadAllText(log), "gh\napi\n")
                Check.That(!result.Error.Contains("Usage:"), "Valid URL input rejected")
                File.Delete(log)
            }
            File.WriteAllText(Path.Combine(bin, "git"), "#!/bin/sh\n/bin/sleep 30 &\nexit 0\n")
            let deadline = Stopwatch.StartNew()
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "No GitHub remote")
            Check.That(deadline.Elapsed.TotalSeconds < 7, "Repository discovery waited for a detached pipe holder")
            Check.That(!File.Exists(log), "Failed repository discovery invoked GitHub")
            File.Delete(Path.Combine(bin, "git"))
            File.CreateSymbolicLink(Path.Combine(bin, "git"), "/usr/bin/git")
            Check.Success(Check.Run("/usr/bin/git", []string{"init", "-b", "main", temp.Root}, temp.Env))
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "No GitHub remote")
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "add", "origin", "git@github.com:owner/project.git"},
                    temp.Env
                )
            )
            let policy = Check.Run(binary, []string{"policy"}, temp.Env, cwd: temp.Root)
            Check.That(policy.Code == 1 && !policy.Error.Contains("Usage:"), "Unique remote rejected")
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            File.Delete(log)
            let nested = Path.Combine(temp.Root, "subdirectory")
            Directory.CreateDirectory(nested)
            let fromSubdirectory = Check.Run(binary, []string{"policy"}, temp.Env, cwd: nested)
            Check.That(
                fromSubdirectory.Code == 1 && !fromSubdirectory.Error.Contains("Usage:"),
                "Repository subdirectory rejected"
            )
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            File.Delete(log)
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "add", "upstream", "https://github.com/OWNER/project.git"},
                    temp.Env
                )
            )
            let same = Check.Run(binary, []string{"policy"}, temp.Env, cwd: temp.Root)
            Check.That(same.Code == 1 && !same.Error.Contains("Usage:"), "Equivalent remotes rejected")
            File.Delete(log)
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "set-url", "upstream", "https://github.com/other/project.git"},
                    temp.Env
                )
            )
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "Ambiguous local remotes")
            Check.That(!File.Exists(log), "Ambiguous remotes invoked GitHub")
            let urlOverride = Check.Run(
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
                Check.Run("/usr/bin/git", []string{"-C", temp.Root, "remote", "remove", "upstream"}, temp.Env)
            )
            Check.Success(
                Check.Run(
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
            let explicitRepo = Check.Run(
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
