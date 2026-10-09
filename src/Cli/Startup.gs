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
        internal func Scan(names[]string, harnessPath string = "") List[ToolCheck] {
            let tools = List[ToolCheck]()
            for name in names {
                let tool = ToolCheck{
                    Name: name,
                    Hint: switch name {
                        case "git": "Install Git and add git to PATH."
                        case "gh": "Install GitHub CLI and add gh to PATH."
                        case "codex": "Add native Linux x64 Codex or the @openai/codex npm launcher with its matching codex-linux-x64 native runtime to PATH; user-local installations are supported. Use --harness-path FILE for a custom location."
                        case "setsid": "Install util-linux and add setsid to PATH."
                        case "/usr/bin/setsid": "Install util-linux at /usr/bin/setsid for catalog probes and independent verification."
                        case "/usr/bin/env": "Install coreutils at /usr/bin/env for command cleanup and managed sandbox probes."
                        case "/usr/bin/unshare": "Install util-linux at /usr/bin/unshare and ensure user namespaces are supported for command cleanup."
                        case "bwrap": "Install bubblewrap and add bwrap to PATH."
                        case "/usr/bin/bwrap": "Install bubblewrap at /usr/bin/bwrap for independent verification."
                        case "curl": "Install curl and add curl to PATH."
                        case "tar": "Install tar and add tar to PATH."
                        case "/usr/bin/cp": "Install GNU coreutils at /usr/bin/cp for independent verification."
                        default: ""
                    }
                }
                tool.Path = name == "codex" ? LocalPaths.Harness(name, harnessPath): name.StartsWith("/") ? (
                    File.Exists(name) ? name: ""
                ): LocalPaths.Find(name)
                if tool.Path != "" {
                    tool.Status = "found"
                    tool.Detail = name.StartsWith("/") ?
                    "Found at the required path; execution has not been checked.":
                    "Found on PATH; execution has not been checked."
                } else {
                    tool.Detail = tool.Hint
                }
                if tool.Path != "" && name.StartsWith("/") && !LocalPaths.Executable(tool.Path) {
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

        internal func Requirements(options Args)[]string {
            let command = options.Command
            if command == "doctor" {
                let selected = Args(
                    []string{
                        options.Get("owner") == "true" ? "init": options.Get("external") == "true" ? "external": "work"
                    }
                )
                for key in[]string{"harness", "harness-path", "pi-root", "node"} {
                    if options.Get(key) != "" {
                        selected.Values["--" + key] = options.Get(key)
                    }
                }
                return Requirements(selected)
            }
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
            if options.Get("run") != "" {
                let run = Data.Load(Path.GetFullPath(options.Need("run")))
                if command == "work" && (run.Number("version") != 2 || run.Text("source") != "tokate") {
                    throw CliFailure("invalid_state", "External work uses external --run; inference is never launched")
                }
            }
            if command == "init" ||
                command == "work" ||
                command == "claim" ||
                command == "prepare" ||
                command == "external" ||
                command == "submit" ||
                command == "amend" ||
                command == "reconcile" ||
                command == "recover" {
                names.Add("git")
            }
            if command == "work" || command == "claim" {
                names.Add("bwrap")
            }
            let independent = command == "work" ||
                command == "claim" ||
                command == "external" ||
                command == "amend" ||
                (command == "recover" && options.Get("prepare") != "true")
            if catalog || independent {
                names.Add("/usr/bin/setsid")
            }
            if independent {
                names.Add("/usr/bin/bwrap")
                names.Add("/usr/bin/cp")
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
                    CodexRuntime.Resolve(tool.Path): tool.Path
                    tool.Path = executable
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

        internal func Inspect(options Args) List[ToolCheck] {
            let harnessPath = options.Get("run") != "" && options.Command == "work" ?
            Data.Load(Path.GetFullPath(options.Need("run"))).Text("harness_path"): options.Get("harness-path")
            let tools = Scan(Requirements(options), harnessPath)
            ExecuteChecks(tools)
            return tools
        }

        internal func Check(options Args) {
            let tools = Inspect(options)
            let blockers = List[ToolCheck]()
            for tool in tools {
                if tool.Status != "ready" {
                    blockers.Add(tool)
                }
            }
            if blockers.Count > 0 {
                if MachineSetup.TryFix(options, blockers) {
                    Check(options)
                    return
                }
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
                    var executable = name
                    for tool in tools {
                        if tool.Name == name {
                            executable = tool.Path
                        }
                    }
                    let result = Commands.Run(
                        executable,
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
            let pi = doctorScope == "managed" && options.Get("harness") == "pi"
            let tools = Inspect(options)
            if options.Get("fix") == "true" && MachineSetup.TryFix(options, tools) {
                return Doctor(options)
            }
            if doctorScope != "owner" {
                let sandbox = ToolCheck{
                    Name: "sandbox",
                    Status: "skipped",
                    Hint: doctorScope == "external" ||
                        pi ? "Install /usr/bin/bwrap and ensure independent verification namespaces are supported. Tokate does not change security settings.": "Ensure bubblewrap user namespaces and native Codex permission profiles are supported. Tokate does not change security settings.",
                    Detail: doctorScope == "external" ||
                        pi ? "Requires working setsid, /usr/bin/setsid and /usr/bin/bwrap.": "Requires working setsid, /usr/bin/setsid, /usr/bin/env, codex and bwrap."
                }
                var probe = Ready(tools, "setsid") &&
                    Ready(tools, "/usr/bin/setsid") &&
                    Ready(tools, "/usr/bin/bwrap") &&
                    Ready(tools, "/usr/bin/cp")
                if probe {
                    probe = doctorScope == "external" || pi ? Ready(tools, "/usr/bin/bwrap"):
                    (Ready(tools, "codex") && Ready(tools, "bwrap") && Ready(tools, "/usr/bin/env"))
                }
                if pi && probe {
                    let runtime = ToolCheck{
                        Name: "pi",
                        Hint: "Use --harness-path FILE, or --pi-root DIR and --node FILE for an existing installation."
                    }
                    let missingPi = options.Get("pi-root") == "" && options.Get("harness-path") == "" &&
                        LocalPaths.Harness("pi") == ""
                    try {
                        PiHarness.Runtime(options)
                        let versions = PiBoundary.Probe(options.Need("pi-root"), options.Need("node"))
                        runtime.Path = options.Need("pi-root")
                        runtime.Status = "ready"
                        runtime.Detail = "Pi " + J.Text(versions, "version") + ", Node " + J.Text(versions, "node")
                    } catch (error Exception) {
                        runtime.Status = "failed"
                        runtime.Detail = error.Message +
                            (SetupUserId() == 0 ? ". If running as root, retry as a regular user.": "")
                        if options.Get("fix") == "true" {
                            Terminal.Message(error.Message, "yellow", true)
                        }
                        if options.Get("fix") == "true" && missingPi && MachineSetup.Harness(options) {
                            return Doctor(options)
                        }
                        probe = false
                    }
                    tools.Add(runtime)
                }
                if probe {
                    try {
                        let pinned = doctorScope == "external" || pi ? Verification.Doctor(): Worker.Doctor(
                            options.Get("harness-path")
                        )
                        sandbox.Status = "ready"
                        sandbox.Detail = doctorScope == "external" ||
                            pi ? "Independent verification isolation, checkout writes, read-only Git and private temporary storage checked without Codex.": "Checkout and private /tmp writable. Control files and Git metadata unreadable."
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
                if doctorScope == "managed" && !pi {
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
                if code == "missing_tools" && options.Get("fix") != "true" {
                    let action = List[string]{"tokate", "doctor", "--" + doctorScope, "--fix"}
                    if options.Get("harness") != "" {
                        action.AddRange([]string{"--harness", options.Get("harness")})
                    }
                    PublicOutput.Actions.Add(action.ToArray())
                }
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
