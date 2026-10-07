package Tokate

import System
import System.Collections.Generic
import System.IO

internal class ToolCheck {
    internal var Name string = ""
    internal var Path string = ""
    internal var Hint string = ""
    internal var Status string = "missing"
    internal var Detail string = ""
}

internal class Startup {
    shared {
        private func Executable(path string) bool {
            try {
                return File.Exists(path) &&
                    (
                    File.GetUnixFileMode(path) & (
                        UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute
                    )
                ) != 0
            } catch (error IOException) { } catch (error UnauthorizedAccessException) { }
            return false
        }

        internal func Find(name string) string {
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if !Path.IsPathFullyQualified(entry) {
                    continue
                }
                let path = Path.Combine(entry, name)
                if Executable(path) {
                    return path
                }
            }
            return ""
        }

        internal func Scan(names[]string) List[ToolCheck] {
            let tools = List[ToolCheck]()
            for name in names {
                let tool = ToolCheck{Name: name}
                switch name {
                    case "git" {
                        tool.Hint = "Install Git and add git to PATH."
                    }
                    case "gh" {
                        tool.Hint = "Install GitHub CLI and add gh to PATH."
                    }
                    case "codex" {
                        tool.Hint = "Add native Linux x64 Codex or the @openai/codex npm launcher with its matching codex-linux-x64 native runtime to PATH; user-local installations are supported."
                    }
                    case "setsid" {
                        tool.Hint = "Install util-linux and add setsid to PATH."
                    }
                    case "/usr/bin/setsid" {
                        tool.Hint = "Install util-linux at /usr/bin/setsid for catalog probes and independent verification."
                    }
                    case "/usr/bin/env" {
                        tool.Hint = "Install coreutils at /usr/bin/env for command cleanup and managed sandbox probes."
                    }
                    case "/usr/bin/unshare" {
                        tool.Hint = "Install util-linux at /usr/bin/unshare and ensure user namespaces are supported for command cleanup."
                    }
                    case "bwrap" {
                        tool.Hint = "Install bubblewrap and add bwrap to PATH."
                    }
                    case "/usr/bin/bwrap" {
                        tool.Hint = "Install bubblewrap at /usr/bin/bwrap for independent verification."
                    }
                    case "curl" {
                        tool.Hint = "Install curl and add curl to PATH."
                    }
                    case "tar" {
                        tool.Hint = "Install tar and add tar to PATH."
                    }
                }
                tool.Path = name.StartsWith("/") ? (File.Exists(name) ? name: ""): Find(name)
                if tool.Path != "" {
                    tool.Status = "found"
                    tool.Detail = name.StartsWith("/") ?
                    "Found at the required path; execution has not been checked.":
                    "Found on PATH; execution has not been checked."
                } else {
                    tool.Detail = tool.Hint
                }
                if tool.Path != "" && name.StartsWith("/") && !Executable(tool.Path) {
                    tool.Status = "failed"
                    tool.Detail = "Required helper is not executable. " + tool.Hint
                }
                tools.Add(tool)
            }
            return tools
        }

        internal func NeedsCatalog(command string, options Args?) bool -> command == "select" ||
            command == "claim" ||
            command == "work" ||
            (command == "prepare" && options?.Get("source") == "tokate")

        private func Requirements(options Args)[]string {
            let command = options.Command
            if (command == "status" && options.Get("run") != "") || command == "defaults" {
                return []string{}
            }
            let names = List[string]{"setsid", "/usr/bin/env", "/usr/bin/unshare", "gh"}
            let catalog = NeedsCatalog(command, options)
            var pi = options.Get("harness") == "pi"
            if options.Get("run") != "" && command == "work" {
                pi = Data.Load(Path.GetFullPath(options.Need("run"))).Text("harness") == "pi"
            }
            if catalog && !pi {
                names.Add("codex")
            }
            if options.Get("run") != "" && command != "repair" {
                let run = Data.Load(Path.GetFullPath(options.Need("run")))
                if command == "work" && run.Number("version") == 2 && run.Text("source") != "tokate" {
                    throw CliFailure("invalid_state", "External work uses external --run; inference is never launched")
                }
            }
            if command == "work" ||
                command == "claim" ||
                command == "prepare" ||
                command == "external" ||
                command == "publish" ||
                command == "submit" ||
                command == "amend" ||
                command == "reconcile" ||
                command == "repair" ||
                command == "recover" {
                names.Add("git")
            }
            if command == "work" {
                names.Add("bwrap")
            }
            let independent = command == "work" ||
                command == "external" ||
                command == "amend" ||
                command == "repair" ||
                (command == "recover" && options.Get("prepare") != "true")
            if catalog || independent {
                names.Add("/usr/bin/setsid")
            }
            if independent {
                names.Add("/usr/bin/bwrap")
            }
            if command == "coordinator-setup" || command == "init" {
                names.Add("curl")
                names.Add("tar")
            }
            return names.ToArray()
        }

        private func ExecuteChecks(tools List[ToolCheck]) {
            var runner bool
            var cleanup = true
            for tool in tools {
                runner = runner || (tool.Name == "setsid" && tool.Path != "")
                if tool.Name == "/usr/bin/env" || tool.Name == "/usr/bin/unshare" {
                    cleanup = cleanup && tool.Path != "" && tool.Status != "failed"
                }
            }
            runner = runner && cleanup
            for tool in tools {
                if tool.Path == "" || tool.Status == "failed" {
                    continue
                }
                if !runner {
                    tool.Status = "skipped"
                    tool.Detail = "Execution requires working command cleanup helpers. " + tool.Hint
                    continue
                }
                try {
                    let executable = tool.Name == "codex" && Path.GetFileName(
                        LocalPaths.CanonicalPath(tool.Path)
                    ) == "codex.js" ?
                    CodexRuntime.Resolve(): tool.Path
                    let result = Commands.Run(
                        executable,
                        []string{"--version"},
                        seconds: 10,
                        harness: tool.Name == "codex"
                    )
                    if result.Code != 0 || result.Truncated || result.ReadFailed {
                        tool.Status = "failed"
                        tool.Detail = (
                            result.Code == 126 ||
                                result.Code == 127 ? "Tool could not start.": "Tool did not complete --version successfully."
                        ) +
                            " Repair or reinstall it. " +
                            tool.Hint
                    } else {
                        tool.Status = "ready"
                        tool.Detail = "Successfully executed --version."
                    }
                } catch (error CliFailure) {
                    tool.Status = "failed"
                    tool.Detail = error.Summary
                } catch (error Exception) {
                    tool.Status = "failed"
                    tool.Detail = "Tool could not start or complete --version. Repair or reinstall it. " + tool.Hint
                }
                if tool.Name == "setsid" && tool.Status != "ready" {
                    runner = false
                }
            }
        }

        private func Ready(tools List[ToolCheck], name string) bool {
            for tool in tools {
                if tool.Name == name {
                    return tool.Status == "ready"
                }
            }
            return false
        }

        internal func Show(tools List[ToolCheck], error bool = false) {
            for tool in tools {
                let style = tool.Status == "ready" ||
                    tool.Status == "found" ? "green": (tool.Status == "failed" ? "red": "yellow")
                Terminal.Row(tool.Name, tool.Status + " - " + tool.Detail, style, error)
            }
        }

        internal func Check(options Args) {
            let tools = Scan(Requirements(options))
            ExecuteChecks(tools)
            let blockers = List[ToolCheck]()
            for tool in tools {
                if tool.Status != "ready" {
                    blockers.Add(tool)
                }
            }
            if blockers.Count > 0 {
                PublicOutput.Tools(blockers)
                Show(blockers, true)
                throw CliFailure(
                    "missing_tools",
                    "Install or repair the tools needed for this command, then run the relevant tokate doctor scope."
                )
            }
        }

        private func Authentication(tools List[ToolCheck], name string) {
            let codex = name == "codex"
            let check = ToolCheck{
                Name: name + "-auth",
                Status: "skipped",
                Hint: codex ? "Run codex login with your ChatGPT subscription.": "Run gh auth login --hostname github.com with the account for this role.",
                Detail: "Authentication status requires a working " + name + " and setsid."
            }
            if Ready(tools, name) && Ready(tools, "setsid") {
                try {
                    let result = Commands.Run(
                        name,
                        codex ? []string{"login", "status"}: []string{"auth", "status", "--hostname", "github.com"},
                        seconds: 10,
                        harness: codex,
                        github: !codex
                    )
                    if result.Truncated || result.ReadFailed {
                        check.Status = "failed"
                        check.Detail = "Authentication status did not complete reliably. " + check.Hint
                    } else if result.Code == 126 || result.Code == 127 {
                        check.Status = "failed"
                        check.Detail = "Authentication status tool could not start. Repair or reinstall " + name + "."
                    } else if result.Code != 0 ||
                        (codex && !(result.Output + result.Error).Contains("Logged in using ChatGPT")) {
                        check.Status = "authentication_required"
                        check.Detail = check.Hint
                        PublicOutput.Actions.Add(
                            codex ? []string{"codex", "login"}: []string{
                                "gh",
                                "auth",
                                "login",
                                "--hostname",
                                "github.com"
                            }
                        )
                    } else {
                        check.Status = "ready"
                        check.Detail = codex ? "ChatGPT login reported by codex login status.": "GitHub authentication reported by gh auth status for github.com."
                    }
                } catch (error Exception) {
                    check.Status = "failed"
                    check.Detail = "Authentication status could not start or complete. " + check.Hint
                }
            }
            tools.Add(check)
        }

        internal func Doctor(options Args) int32 {
            let doctorScope = options.Get("owner") == "true" ? "owner": (
                options.Get("external") == "true" ? "external": "managed"
            )
            let tools = Scan(
                doctorScope == "owner" ? []string{"setsid", "/usr/bin/env", "/usr/bin/unshare", "gh"}: (
                    doctorScope == "external" ? []string{
                        "setsid",
                        "/usr/bin/env",
                        "/usr/bin/unshare",
                        "git",
                        "gh",
                        "/usr/bin/setsid",
                        "/usr/bin/bwrap"
                    }: []string{
                        "setsid",
                        "/usr/bin/env",
                        "/usr/bin/unshare",
                        "git",
                        "gh",
                        "codex",
                        "/usr/bin/setsid",
                        "bwrap"
                    }
                )
            )
            ExecuteChecks(tools)
            if doctorScope != "owner" {
                let sandbox = ToolCheck{
                    Name: "sandbox",
                    Status: "skipped",
                    Hint: doctorScope == "external" ? "Install /usr/bin/bwrap and ensure independent verification namespaces are supported. Tokate does not change security settings.": "Ensure bubblewrap user namespaces and native Codex permission profiles are supported. Tokate does not change security settings.",
                    Detail: doctorScope == "external" ? "Requires working setsid, /usr/bin/setsid and /usr/bin/bwrap.": "Requires working setsid, /usr/bin/setsid, /usr/bin/env, codex and bwrap."
                }
                var probe = Ready(tools, "setsid") && Ready(tools, "/usr/bin/setsid")
                if probe {
                    probe = doctorScope == "external" ? Ready(tools, "/usr/bin/bwrap"):
                    (Ready(tools, "codex") && Ready(tools, "bwrap") && Ready(tools, "/usr/bin/env"))
                }
                if probe {
                    try {
                        let pinned = doctorScope == "external" ? Verification.Doctor(): Worker.Doctor()
                        sandbox.Status = "ready"
                        sandbox.Detail = doctorScope == "external" ? "Independent verification isolation, checkout writes, read-only Git and private temporary storage checked without Codex.": "Checkout and private /tmp writable. Control files and Git metadata unreadable."
                        if pinned {
                            sandbox.Detail += " Repository global.json SDK/MSBuild starts inside the sandbox."
                        }
                    } catch (error CliFailure) {
                        if error.Code == "missing_tools" {
                            sandbox.Status = "ready"
                            sandbox.Detail = "Sandbox isolation probe passed; pinned toolchain probe failed."
                            tools.Add(
                                ToolCheck{
                                    Name: "toolchain",
                                    Status: "failed",
                                    Hint: error.Summary,
                                    Detail: error.Summary
                                }
                            )
                        } else {
                            sandbox.Status = "failed"
                            sandbox.Detail = error.Summary
                        }
                    } catch (error Exception) {
                        sandbox.Status = "failed"
                        sandbox.Detail = "Sandbox probe could not complete. " +
                            sandbox.Hint +
                            " Ensure temporary storage is writable and repository global.json is a regular file, not a symbolic link."
                    }
                }
                tools.Add(sandbox)
            }
            if options.Get("auth") == "true" {
                Authentication(tools, "gh")
                if doctorScope == "managed" {
                    Authentication(tools, "codex")
                }
            }
            PublicOutput.Tools(tools)
            if PublicOutput.ResultData is Dictionary[string, Object?]fields {
                fields["scope"] = doctorScope
                fields["authentication_requested"] = options.Get("auth") == "true"
            }
            Terminal.Heading("Tokate " + doctorScope + " diagnostics")
            Show(tools)
            Terminal.Message(
                "Checked capabilities are listed above. No inference was run. PATH, startup, login and catalog data do not prove model availability or subscription allowance. Repository dependencies and builds were not checked.",
                "grey"
            )
            var code = ""
            for tool in tools {
                if tool.Status != "ready" {
                    let failure = tool.Status == "authentication_required" ? "authentication_required": (
                        tool.Name == "sandbox" ? "verification_failed": "missing_tools"
                    )
                    if code == "" || failure == "missing_tools" {
                        code = failure
                    }
                }
            }
            if code != "" {
                throw CliFailure(
                    code,
                    code == "verification_failed" ? "Required sandbox diagnostics failed. Follow the sandbox repair instructions above.": PublicOutput.Message(
                        code
                    )
                )
            }
            return 0
        }
    }
}
