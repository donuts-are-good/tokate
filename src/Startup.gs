package Tokate

import Spectre.Console
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
        internal func Find(name string) string {
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if !Path.IsPathFullyQualified(entry) {
                    continue
                }
                let path = Path.Combine(entry, name)
                try {
                    if File.Exists(path) &&
                        (
                        File.GetUnixFileMode(path) & (
                            UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute
                        )
                    ) != 0 {
                        return path
                    }
                } catch (error IOException) { } catch (error UnauthorizedAccessException) { }
            }
            return ""
        }

        internal func Scan() List[ToolCheck] {
            let tools = List[ToolCheck]{
                ToolCheck{Name: "git", Hint: "Install Git and add git to PATH."},
                ToolCheck{Name: "gh", Hint: "Install GitHub CLI, then run gh auth login."},
                ToolCheck{
                    Name: "codex",
                    Hint: "Install the native Codex CLI, then run codex login. Needed for donor work."
                },
                ToolCheck{Name: "setsid", Hint: "Install util-linux and add setsid to PATH."},
                ToolCheck{Name: "bwrap", Hint: "Install bubblewrap. Needed for isolated donor temporary storage."},
            }
            for tool in tools {
                tool.Path = Find(tool.Name)
                if tool.Path != "" {
                    tool.Status = "found"
                    tool.Detail = tool.Path
                } else {
                    tool.Detail = tool.Hint
                }
            }
            return tools
        }

        internal func Show(tools List[ToolCheck], error bool = false) {
            if !Terminal.Rich(error) {
                for tool in tools {
                    Terminal.Message(tool.Name + ": " + tool.Status + " - " + tool.Detail, error: error)
                }
                return
            }
            let table = Table()
            table.Border = TableBorder.Rounded
            table.AddColumn("Check")
            table.AddColumn("Status")
            table.AddColumn("Details")
            for tool in tools {
                let style = tool.Status == "ready" ||
                    tool.Status == "found" ? "green": (tool.Status == "skipped" ? "grey": "yellow")
                table.AddRow(
                    Markup.Escape(tool.Name),
                    "[" + style + "]" + Markup.Escape(tool.Status) + "[/]",
                    Markup.Escape(Terminal.Clean(tool.Detail))
                )
            }
            Terminal.Output(error).Write(table)
        }

        internal func Check(command string) {
            let missing = List[ToolCheck]()
            var blocked bool
            for tool in Scan() {
                if tool.Status != "missing" {
                    continue
                }
                missing.Add(tool)
                let offline = command == "help" ||
                    command == "--help" ||
                    command == "--version" ||
                    command == "init" ||
                    command == "status"
                if !offline &&
                    (
                    tool.Name == "setsid" ||
                        tool.Name == "gh" ||
                        command == "work" ||
                        (tool.Name == "git" && command == "publish")
                ) {
                    blocked = true
                }
            }
            if missing.Count > 0 {
                Terminal.Message("Missing tools", "yellow", true)
                Show(missing, true)
                if blocked {
                    throw Exception("Install the tools needed for this command, then run tokate doctor.")
                }
            }
        }

        internal func Doctor() int32 {
            let tools = Scan()
            let runner = Find("setsid") != ""
            var failed bool
            for tool in tools {
                if tool.Path == "" {
                    failed = true
                    continue
                }
                if !runner {
                    continue
                }
                try {
                    let result = Commands.Run(tool.Path, []string{"--version"}, seconds: 10)
                    if result.Code != 0 {
                        throw Exception("Version check failed. " + tool.Hint)
                    }
                    tool.Status = "ready"
                    tool.Detail = result.Output.Trim().Split('\n')[0]
                } catch (error Exception) {
                    tool.Status = "failed"
                    tool.Detail = error.Message
                    failed = true
                }
            }
            let sandbox = ToolCheck{
                Name: "sandbox",
                Status: "skipped",
                Detail: "Requires working codex, setsid, and bubblewrap."
            }
            var canProbe = runner
            for tool in tools {
                if (tool.Name == "codex" || tool.Name == "setsid" || tool.Name == "bwrap") && tool.Status != "ready" {
                    canProbe = false
                }
            }
            if canProbe {
                try {
                    Worker.Doctor()
                    sandbox.Status = "ready"
                    sandbox.Detail = "Checkout and private /tmp writable. Control files and Git metadata unreadable."
                } catch (error Exception) {
                    sandbox.Status = "failed"
                    sandbox.Detail = error.Message
                    failed = true
                }
            }
            tools.Add(sandbox)
            Terminal.Message("Tokate environment", "bold cyan")
            Show(tools)
            Terminal.Message("No inference was run. Authentication is checked when a command needs it.", "grey")
            return failed ? 1: 0
        }
    }
}
