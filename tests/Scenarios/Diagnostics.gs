package TokateTests

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices
import System.Text.Json.Nodes

@DllImport("libc", EntryPoint: "inotify_init1", SetLastError: true)
func MetadataWatch(flags int32) int32;

@DllImport("libc", EntryPoint: "inotify_add_watch", SetLastError: true)
func MetadataWatchPath(descriptor int32, path string, mask uint32) int32;

@DllImport("libc", EntryPoint: "read", SetLastError: true)
func MetadataEvents(descriptor int32, buffer[]byte, count uint64) int64;

@DllImport("libc", EntryPoint: "mkfifo", SetLastError: true)
func MetadataFifo(path string, mode uint32) int32;

internal class Diagnostics {
    shared {
        private func Metadata(binary string) {
            for layout in[]string{"nested", "sibling"} {
                for kind in[]string{
                    "root-link",
                    "platform-link",
                    "platform-directory-link",
                    "dependency-directory-link",
                    "root-fifo",
                    "platform-fifo",
                    "root-directory",
                    "platform-directory",
                    "launcher-fifo",
                    "native-fifo"
                } {
                    if kind == "dependency-directory-link" && layout == "sibling" {
                        continue
                    }
                    if kind == "launcher-fifo" && layout == "sibling" {
                        continue
                    }
                    using let temp = Temp()
                    let root = Path.Combine(temp.Root, "packages/@openai/codex")
                    let platform = Path.Combine(
                        layout == "nested" ? Path.Combine(root, "node_modules/@openai"): (
                            Path.GetDirectoryName(root) ?? ""
                        ),
                        "codex-linux-x64"
                    )
                    Directory.CreateDirectory(Path.Combine(root, "bin"))
                    Directory.CreateDirectory(platform)
                    let launcher = Path.Combine(root, "bin/codex.js")
                    File.WriteAllText(launcher, "#!/bin/sh\nexit 1\nsynthetic-launcher\n")
                    File.SetUnixFileMode(
                        launcher,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    )
                    File.CreateSymbolicLink(Path.Combine(temp.Root, "bin/codex"), launcher)
                    for tool in[]string{"setsid", "git", "gh", "bwrap"} {
                        File.CreateSymbolicLink(Path.Combine(temp.Root, "bin", tool), "/usr/bin/" + tool)
                    }
                    let manifest = "{\"name\":\"@openai/codex\",\"version\":\"0.160.0\",\"bin\":{\"codex\":\"bin/codex.js\"},\"optionalDependencies\":{\"@openai/codex-linux-x64\":\"npm:@openai/codex@0.160.0-linux-x64\"}}"
                    let metadata = "{\"name\":\"@openai/codex\",\"version\":\"0.160.0-linux-x64\"}"
                    File.WriteAllText(Path.Combine(root, "package.json"), manifest)
                    File.WriteAllText(Path.Combine(platform, "package.json"), metadata)
                    let target = Path.Combine(temp.Root, "private/package.json")
                    Directory.CreateDirectory(Path.GetDirectoryName(target) ?? "")
                    File.WriteAllText(target, kind.StartsWith("root") ? manifest: metadata)
                    let path = kind == "launcher-fifo" ? launcher: kind == "native-fifo" ?
                    Path.Combine(platform, "vendor/x86_64-unknown-linux-musl/bin/codex"):
                    Path.Combine(kind.StartsWith("root") ? root: platform, "package.json")
                    Directory.CreateDirectory(Path.GetDirectoryName(path) ?? "")
                    File.Delete(path)
                    if kind.EndsWith("directory-link") {
                        Directory.Delete(platform, true)
                        let link = kind == "dependency-directory-link" ? Path.GetDirectoryName(platform) ?? "": platform
                        if Directory.Exists(link) {
                            Directory.Delete(link)
                        }
                        Directory.CreateSymbolicLink(link, Path.GetDirectoryName(target) ?? "")
                        if kind == "dependency-directory-link" {
                            Directory.CreateDirectory(
                                Path.Combine(Path.GetDirectoryName(target) ?? "", "codex-linux-x64")
                            )
                            File.Move(
                                target,
                                Path.Combine(Path.GetDirectoryName(target) ?? "", "codex-linux-x64/package.json")
                            )
                        }
                    } else if kind.EndsWith("link") {
                        File.CreateSymbolicLink(path, target)
                    } else if kind.EndsWith("fifo") {
                        Check.That(
                            MetadataFifo(path, kind == "launcher-fifo" || kind == "native-fifo" ? 448: 384) == 0,
                            "Cannot create runtime FIFO"
                        )
                    } else {
                        Directory.CreateDirectory(path)
                    }
                    let watched = kind == "dependency-directory-link" ? Path.Combine(
                        Path.GetDirectoryName(target) ?? "",
                        "codex-linux-x64/package.json"
                    ): target
                    let descriptor = MetadataWatch(2048 | 524288)
                    Check.That(descriptor >= 0, "Cannot watch synthetic metadata")
                    using let handle = SafeFileHandle(IntPtr(descriptor), true)
                    Check.That(MetadataWatchPath(descriptor, watched, 33) >= 0, "Cannot watch synthetic target")
                    let result = TestProcess.Run(
                        "/usr/bin/timeout",
                        []string{"5", binary, "doctor", "--managed", "--json"},
                        temp.Env,
                        cwd: temp.Root
                    )
                    Check.That(result.Code != 124, "Runtime discovery blocked: " + layout + " " + kind)
                    Check.That(result.Code != 0, "Unsafe metadata layout passed doctor")
                    Check.Contains(result.Output, "Unsupported managed Codex runtime layout")
                    let events = [64]byte
                    Check.That(
                        MetadataEvents(descriptor, events, Convert.ToUInt64(events.Length)) == -1 &&
                            Marshal.GetLastPInvokeError() == 11,
                        "Production doctor opened or read rejected synthetic metadata: " + layout + " " + kind
                    )
                }
            }
            Console.WriteLine(
                "PASS production doctor refuses linked or special package metadata before opening synthetic targets"
            )
        }

        private func Tool(temp Temp, name string, body string) {
            let path = Path.Combine(temp.Root, "bin", name)
            File.WriteAllText(
                path,
                "#!/bin/sh\nprintf '%s\\n' '" + name + " ' \"$$*\" >> '" + Path.Combine(temp.Root, "calls") +
                    "'\nprintf '%s\\n' synthetic-auth-secret\nprintf '%s\\n' synthetic-auth-secret >&2\n" +
                    body
            )
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
        }

        private func Call(binary string, temp Temp, words[]string, status string = "ok", code string = "") JsonNode {
            let args = List[string](words)
            args.Add("--json")
            let result = TestProcess.Run(binary, args.ToArray(), temp.Env, cwd: temp.Root)
            Check.That(
                !(result.Output + result.Error).Contains("synthetic-auth-secret"),
                "Raw tool or authentication output leaked"
            )
            return Check.Envelope(result, words[0], status, code)
        }

        private func Row(value JsonNode, name string) JsonNode {
            for row in value["data"]?["tools"]?.AsArray() ?? JsonArray() {
                if Check.Text(row["name"]) == name {
                    return row
                }
            }
            throw Exception("Missing diagnostic: " + name)
        }

        private func Local(binary string) {
            using let temp = Temp()
            temp.Env["PATH"] = Path.Combine(temp.Root, "bin")
            let calls = Path.Combine(temp.Root, "calls")
            File.CreateSymbolicLink(Path.Combine(temp.Root, "bin/setsid"), "/usr/bin/setsid")
            Tool(temp, "gh", "test \"$1\" = --version && exit 0\nexit 1\n")
            for words in[]([]string){
                []string{"doctor", "--owner", "--managed", "--auth"},
                []string{"doctor", "--owner", "--external"},
                []string{"doctor", "--managed", "--external", "--non-interactive"}
            } {
                Call(binary, temp, words, "error", "invalid_arguments")
            }
            Check.That(!File.Exists(calls), "Conflicting scopes started probes")
            for words in[]([]string){[]string{"help"}, []string{"--version"}, []string{"completion", "bash"}} {
                Call(binary, temp, words)
            }
            let saved = Path.Combine(temp.Root, "saved")
            Directory.CreateDirectory(saved)
            File.WriteAllText(
                Path.Combine(saved, "run.json"),
                "{\"version\":2,\"source\":\"external\",\"state\":\"claimed\"}"
            )
            Call(binary, temp, []string{"status", "--run", saved})
            Check.That(!File.Exists(calls), "Offline commands started prerequisite probes")
            Call(binary, temp, []string{"work", "--run", saved}, "error", "invalid_state")
            Check.That(!File.Exists(calls), "Rejected external saved work probed managed tools")
            let incomplete = Call(binary, temp, []string{"doctor", "--owner"}, "error", "missing_tools")
            Check.That(Check.Text(Row(incomplete, "git")["status"]) == "missing", "Owner accepted missing Git")
            for name in[]string{"git", "curl", "tar"} {
                Tool(temp, name, "exit 0\n")
            }
            let owner = Call(binary, temp, []string{"doctor", "--owner"})
            Check.That(
                Check.Text(owner["data"]?["scope"]) == "owner" && owner["data"]?["tools"]?.AsArray().Count == 7,
                "Owner checked donor tools"
            )
            Check.That(Check.Text(owner["data"]?["authentication_requested"]) == "false", "Implicit authentication")
            Check.That(!File.ReadAllText(calls).Contains("status"), "No-auth doctor checked authentication")
            var longTools = temp.Root
            for i in 0 ... 24 {
                longTools = Path.Combine(longTools, String('p', 96))
            }
            Directory.CreateDirectory(longTools)
            File.CreateSymbolicLink(Path.Combine(longTools, "setsid"), "/usr/bin/setsid")
            File.CreateSymbolicLink(Path.Combine(longTools, "gh"), Path.Combine(temp.Root, "bin/gh"))
            for name in[]string{"git", "curl", "tar"} {
                File.CreateSymbolicLink(Path.Combine(longTools, name), Path.Combine(temp.Root, "bin", name))
            }
            temp.Env["PATH"] = longTools
            let longPath = Call(binary, temp, []string{"doctor", "--owner"})
            Check.That(
                Check.Text(Row(longPath, "gh")["path"]) == Path.Combine(longTools, "gh"),
                "Diagnostic tool path was shortened"
            )
            temp.Env["PATH"] = Path.Combine(temp.Root, "bin")
            let auth = Call(binary, temp, []string{"doctor", "--owner", "--auth"}, "error", "authentication_required")
            Check.That(
                Check.Text(Row(auth, "gh-auth")["status"]) == "authentication_required",
                "Missing auth not distinguished"
            )
            Check.That(Check.Text(auth["next_actions"]?[0]?[0]) == "gh", "Authentication repair action missing")
            let missing = Call(binary, temp, []string{"doctor", "--managed"}, "error", "missing_tools")
            Check.That(Check.Text(Row(missing, "codex")["status"]) == "missing", "Missing Codex not distinguished")
            Check.That(Check.Text(Row(missing, "sandbox")["status"]) == "skipped", "Skipped probe passed")
            Tool(temp, "codex", "exit 17\n")
            let broken = Call(binary, temp, []string{"doctor"}, "error", "missing_tools")
            Check.That(Check.Text(Row(broken, "codex")["status"]) == "failed", "Broken Codex accepted")
            File.WriteAllText(Path.Combine(temp.Root, "bin/codex"), "#!/missing/interpreter\n")
            let cannotStart = Call(binary, temp, []string{"doctor"}, "error", "missing_tools")
            Check.Contains(Check.Text(Row(cannotStart, "codex")["detail"]), "could not start")
            Tool(temp, "codex", "test \"$1\" = --version && exit 0\nprintf '%s\\n' 'Logged in using ChatGPT'\nexit 0\n")
            let donorAuth = Call(binary, temp, []string{"doctor", "--managed", "--auth"}, "error", "missing_tools")
            Check.That(
                Check.Text(Row(donorAuth, "codex-auth")["status"]) == "ready",
                "Explicit ChatGPT status not checked"
            )
            let tools = Path.Combine(temp.Root, "tools.json")
            File.WriteAllText(tools, "[]")
            File.Delete(Path.Combine(temp.Root, "bin/codex"))
            File.Delete(Path.Combine(temp.Root, "bin/git"))
            File.WriteAllText(calls, "")
            let archive = Call(binary, temp, []string{"recover", "--run", saved, "--prepare"}, "error", "missing_tools")
            Check.That(
                archive["data"]?["tools"]?.AsArray().Count == 1 && Check.Text(
                    Row(archive, "git")["status"]
                ) == "missing",
                "Correction preparation needs Git but no sandbox or Codex"
            )
            let verify = Call(
                binary,
                temp,
                []string{"external", "--run", saved, "--commit", String('a', 40)},
                "error",
                "missing_tools"
            )
            Check.That(
                Check.Text(Row(verify, "git")["status"]) == "missing" && !File.ReadAllText(calls).Contains("codex"),
                "Saved external verification required Codex"
            )
            let external = Call(
                binary,
                temp,
                []string{
                    "prepare",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--state",
                    String('a', 40),
                    "--source",
                    "external",
                    "--tools",
                    tools
                },
                "error",
                "missing_tools"
            )
            Check.That(Check.Text(Row(external, "git")["status"]) == "missing", "External preparation omitted Git")
            Check.That(!File.ReadAllText(calls).Contains("codex"), "External preparation needed Codex")
            let managed = Call(
                binary,
                temp,
                []string{
                    "prepare",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--state",
                    String('a', 40),
                    "--source",
                    "tokate"
                },
                "error",
                "missing_tools"
            )
            Check.That(Check.Text(Row(managed, "codex")["status"]) == "missing", "Managed catalog route omitted Codex")
            for command in[]string{"claim", "select"} {
                let words = List[string]{command, "--repo", "owner/project"}
                if command == "claim" {
                    words.AddRange([]string{"--issue", "1"})
                }
                let selection = Call(binary, temp, words.ToArray(), "error", "missing_tools")
                Check.That(
                    Check.Text(Row(selection, "codex")["status"]) == "missing",
                    "Offline catalog route omitted Codex"
                )
            }
            Tool(temp, "gh", "exit 17\n")
            let failedOwner = Call(binary, temp, []string{"doctor", "--owner", "--auth"}, "error", "missing_tools")
            Check.That(
                Check.Text(Row(failedOwner, "gh-auth")["status"]) == "skipped",
                "Failed authentication status passed"
            )
            File.Delete(Path.Combine(temp.Root, "bin/setsid"))
            let noRunner = Call(binary, temp, []string{"doctor", "--owner"}, "error", "missing_tools")
            Check.That(Check.Text(Row(noRunner, "gh")["status"]) == "skipped", "PATH discovery proved readiness")
            Console.WriteLine(
                "PASS scoped diagnostics, conflicts, missing/broken tools, explicit sanitized authentication and offline routes; no inference"
            )
        }

        private func FixedCall(binary string, flow NativeFixture, helper string, words[]string) Result {
            let args = List[string]{
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp",
                "--bind",
                flow.Temp.Root,
                flow.Temp.Root,
                "--ro-bind",
                Path.Combine(flow.Temp.Root, "broken-helper"),
                helper,
                "--",
                binary
            }
            args.AddRange(words)
            args.Add("--json")
            return TestProcess.Run("/usr/bin/bwrap", args.ToArray(), flow.Temp.Env, cwd: flow.Upstream)
        }

        private func Fixed(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            let runner = Path.Combine(flow.Bin, "setsid")
            File.Copy("/usr/bin/setsid", runner)
            File.SetUnixFileMode(runner, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            File.WriteAllText(Path.Combine(flow.Temp.Root, "broken-helper"), "")
            for helper in[]string{
                "/usr/bin/env",
                "/usr/bin/unshare",
                "/usr/bin/setsid",
                "/usr/bin/bwrap",
                "/usr/bin/cp"
            } {
                let cleanup = helper == "/usr/bin/env" || helper == "/usr/bin/unshare"
                let owner = Check.Envelope(
                    FixedCall(binary, flow, helper, []string{"doctor", "--owner"}),
                    "doctor",
                    cleanup ? "error": "ok",
                    cleanup ? "missing_tools": ""
                )
                if cleanup {
                    Check.That(
                        Check.Text(Row(owner, helper)["status"]) == "failed" && Check.Text(
                            Row(owner, "setsid")["status"]
                        ) == "skipped",
                        "Owner diagnostics misattributed a failed cleanup helper"
                    )
                    let discovery = Check.Envelope(
                        FixedCall(binary, flow, helper, []string{"policy"}),
                        "policy",
                        "error",
                        "missing_tools"
                    )
                    Check.Contains(Check.Text(discovery["error"]?["message"]), "PID namespace")
                }
                if helper != "/usr/bin/bwrap" && helper != "/usr/bin/cp" {
                    let selection = Check.Envelope(
                        FixedCall(
                            binary,
                            flow,
                            helper,
                            []string{"select", "--repo", "owner/project", "--non-interactive"}
                        ),
                        "select",
                        "error",
                        "missing_tools"
                    )
                    Check.That(
                        Check.Text(Row(selection, helper)["status"]) == "failed",
                        "Broken fixed catalog helper accepted"
                    )
                }
                let doctorScope = helper == "/usr/bin/env" ? "--managed": "--external"
                let doctor = Check.Envelope(
                    FixedCall(binary, flow, helper, []string{"doctor", doctorScope}),
                    "doctor",
                    "error",
                    "missing_tools"
                )
                Check.That(
                    Check.Text(Row(doctor, helper)["status"]) == "failed" && Check.Text(
                        Row(doctor, "sandbox")["status"]
                    ) == "skipped",
                    "Broken fixed helper was reported as a sandbox failure"
                )
                if helper == "/usr/bin/env" {
                    let external = Check.Envelope(
                        FixedCall(binary, flow, helper, []string{"doctor", "--external"}),
                        "doctor",
                        "error",
                        "missing_tools"
                    )
                    Check.That(
                        Check.Text(Row(external, helper)["status"]) == "failed" && Check.Text(
                            Row(external, "sandbox")["status"]
                        ) == "skipped",
                        "External diagnostics omitted the failed cleanup helper"
                    )
                }
            }
            flow.NoInference()
            Console.WriteLine(
                "PASS fixed cleanup, catalog and sandbox helpers fail before dependent probes; no inference"
            )
        }

        private func Sandboxes(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            let managed = TestProcess.Run(
                binary,
                []string{"doctor", "--managed", "--json"},
                flow.Temp.Env,
                cwd: flow.Upstream
            )
            Check.Envelope(managed, "doctor", "ok")
            flow.Reload()
            Check.That(
                flow.State["login_count"] == nil && flow.State["exec_count"] == nil,
                "Local managed doctor used login or inference"
            )
            flow.State["mode"] = JsonValue.Create("unsupported_sandbox")
            flow.Save()
            let failed = TestProcess.Run(
                binary,
                []string{"doctor", "--managed", "--json"},
                flow.Temp.Env,
                cwd: flow.Upstream
            )
            let failure = Check.Envelope(failed, "doctor", "error", "verification_failed")
            Check.That(Check.Text(Row(failure, "sandbox")["status"]) == "failed", "Failed managed sandbox passed")
            File.Delete(Path.Combine(flow.Bin, "codex"))
            let external = TestProcess.Run(
                binary,
                []string{"doctor", "--external", "--json"},
                flow.Temp.Env,
                cwd: flow.Upstream
            )
            let verification = Check.Envelope(external, "doctor", "ok")
            Check.That(
                Check.Text(Row(verification, "sandbox")["status"]) == "ready",
                "Independent verification probe did not pass"
            )
            flow.Temp.Env["TMPDIR"] = Path.Combine(flow.Temp.Root, "unavailable-temporary-storage")
            let unavailable = Check.Envelope(
                TestProcess.Run(binary, []string{"doctor", "--external", "--json"}, flow.Temp.Env, cwd: flow.Upstream),
                "doctor",
                "error",
                "verification_failed"
            )
            Check.That(
                Check.Text(Row(unavailable, "sandbox")["status"]) == "failed",
                "Failed independent sandbox preparation passed"
            )
            flow.Temp.Env.Remove("TMPDIR")
            File.Copy(
                Path.Combine(Directory.GetCurrentDirectory(), "global.json"),
                Path.Combine(flow.Upstream, "global.json")
            )
            Check.Envelope(
                TestProcess.Run(binary, []string{"doctor", "--external", "--json"}, flow.Temp.Env, cwd: flow.Upstream),
                "doctor",
                "ok"
            )
            File.WriteAllText(
                Path.Combine(flow.Upstream, "global.json"),
                "{\"sdk\":{\"version\":\"99.0.100\",\"rollForward\":\"disable\"}}"
            )
            let pinned = Check.Envelope(
                TestProcess.Run(binary, []string{"doctor", "--external", "--json"}, flow.Temp.Env, cwd: flow.Upstream),
                "doctor",
                "error",
                "missing_tools"
            )
            Check.That(
                Check.Text(Row(pinned, "sandbox")["status"]) == "ready" && Check.Text(
                    Row(pinned, "toolchain")["status"]
                ) == "failed",
                "Toolchain and sandbox failures were conflated"
            )
            flow.NoInference()
            Console.WriteLine(
                "PASS managed and independent sandbox diagnostics, failed isolation and pinned toolchain; no Codex for external verification"
            )
        }

        internal func All(binary string, selected string = "") {
            Check.That(
                selected == "" ||
                    selected == "local" ||
                    selected == "sandbox" ||
                    selected == "fixed" ||
                    selected == "metadata",
                "Unknown diagnostics selector"
            )
            if selected == "" || selected == "local" {
                Local(binary)
            }
            if selected == "" || selected == "sandbox" {
                Sandboxes(binary)
            }
            if selected == "" || selected == "fixed" {
                Fixed(binary)
            }
            if selected == "" || selected == "metadata" {
                Metadata(binary)
            }
        }
    }
}
