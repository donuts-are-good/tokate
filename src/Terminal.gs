package Tokate

import Spectre.Console
import System
import System.Globalization
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class Terminal {
    shared {
        internal var Plain bool
        internal var Ascii bool
        private let Parchment string = "#f3e7d4"
        private let Gold string = "#89723f"
        private let Sage string = "#697459"
        private let Terracotta string = "#97492e"
        private let Blue string = "#50688e"

        internal func Initialize() {
            let term = Environment.GetEnvironmentVariable("TERM")
            try {
                Environment.SetEnvironmentVariable("TERM", "dumb")
                Console.WindowWidth.ToString()
            } finally {
                Environment.SetEnvironmentVariable("TERM", term)
            }
        }

        internal func Clean(value string) string {
            let stripped = Regex.Replace(
                value,
                "(?:\\x1b\\[|\\x9b)[0-?]*[ -/]*[@-~]|(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c]*(?:\\x07|\\x1b\\\\|\\x9c)|\\x1b[@-_]",
                ""
            )
            let text = StringBuilder()
            for c in stripped {
                if c == '\t' {
                    text.Append("    ")
                } else if c == '\n' || (!Char.IsControl(c) && Char.GetUnicodeCategory(c) != UnicodeCategory.Format) {
                    text.Append(c)
                }
            }
            return text.ToString()
        }

        internal func Rich(error bool = false) bool -> !PublicOutput.Enabled &&
            !Plain &&
            !(error ? Console.IsErrorRedirected: Console.IsOutputRedirected) &&
            Environment.GetEnvironmentVariable("NO_COLOR") == nil && Environment.GetEnvironmentVariable(
            "TERM"
        ) != "dumb"

        internal func Output(error bool = false) IAnsiConsole -> AnsiConsole.Create(
            AnsiConsoleSettings{
                Out: AnsiConsoleOutput(error ? Console.Error: Console.Out),
                Ansi: Rich(error) ? AnsiSupport.Yes: AnsiSupport.No,
                ColorSystem: Depth(),
                Interactive: InteractionSupport.No,
            }
        )

        private func Depth() ColorSystemSupport {
            let color = Environment.GetEnvironmentVariable("COLORTERM") ?? ""
            let term = Environment.GetEnvironmentVariable("TERM") ?? ""
            if color == "truecolor" || color == "24bit" || term.Contains("direct") || term.Contains("truecolor") {
                return ColorSystemSupport.TrueColor
            }
            return term.Contains("256color") ? ColorSystemSupport.EightBit: ColorSystemSupport.Legacy
        }

        internal func Width(error bool = false) int32 {
            if error ? Console.IsErrorRedirected: Console.IsOutputRedirected {
                return 80
            }
            return Math.Max(20, Output(error).Profile.Width)
        }

        private func Accent(color string) string {
            let background = Environment.GetEnvironmentVariable("COLORFGBG") ?? ""
            let dark = background.EndsWith(";0") || background.EndsWith(";8")
            switch color {
                case "green" {
                    return dark ? "#b0bfa6": Sage
                }
                case "red" {
                    return dark ? "#d99a7d": Terracotta
                }
                case "yellow" {
                    return dark ? "#e2bb80": Gold
                }
                case "cyan" {
                    return dark ? "#a9bdd9": Blue
                }
                default {
                    return "default"
                }
            }
        }

        private func Line(value string, color string, error bool) {
            if Rich(error) {
                let console = Output(error)
                console.Profile.Width = Math.Max(console.Profile.Width, value.Length + 1)
                let split = value.IndexOf(' ', value.Length - value.TrimStart().Length)
                let length = split < 0 ? value.Length: split
                console.Write(
                    value.Substring(0, length),
                    Style.Parse((value.EndsWith(":") ? "bold ": "") + Accent(color))
                )
                console.WriteLine(value.Substring(length))
            } else if error {
                Console.Error.WriteLine(value)
            } else {
                Console.WriteLine(value)
            }
        }

        internal func Message(text string, color string = "green", error bool = false) {
            let stderr = error || PublicOutput.Enabled
            let value = Clean(PublicOutput.Enabled ? PublicOutput.Prose(text): text)
            let width = (stderr ? Console.IsErrorRedirected: Console.IsOutputRedirected) ? int32.MaxValue: Width(stderr)
            for source in value.Split('\n') {
                let indent = source.Length - source.TrimStart().Length
                let prefix = source.Substring(0, indent)
                var remaining = source.Substring(indent)
                while width > indent && remaining.Length + indent > width && !source.Contains(" Run: ") &&
                    !remaining.StartsWith("tokate ") && !remaining.StartsWith("gh ") {
                    var split = remaining.LastIndexOf(' ', Math.Min(remaining.Length - 1, width - indent))
                    if split <= 0 {
                        split = remaining.IndexOf(' ', Math.Min(remaining.Length - 1, width - indent))
                    }
                    if split <= 0 {
                        break
                    }
                    Line(prefix + remaining.Substring(0, split), color, stderr)
                    remaining = remaining.Substring(split + 1)
                }
                Line(prefix + remaining, color, stderr)
            }
        }

        internal func Step(text string) -> Message(text, "cyan")

        internal func Heading(title string, error bool = false) {
            if Rich(error) {
                let console = Output(error)
                let ascii = Ascii || !console.Profile.Capabilities.Unicode
                console.Write(ascii ? "* ": "☼ ", Style.Parse(Accent("yellow")))
                console.WriteLine("Tokate", Style.Parse("bold " + Parchment + " on " + Blue))
                console.WriteLine(String(ascii ? '-': '─', Math.Min(Width(error), 32)), Style.Parse(Accent("yellow")))
            }
            if Rich(error) {
                Output(error).WriteLine(Clean(title), Style.Parse("bold"))
            } else {
                Message(title, "default", error)
            }
        }

        internal func Help(command string = "") {
            Heading(command == "" ? "Commands": "Command: " + command)
            Message(Cli.Help(command, Width()), "default")
        }

        internal func Row(label string, value string, color string = "default", error bool = false) {
            let name = Clean(label)
            let text = Clean(value)
            let redirected = error ? Console.IsErrorRedirected: Console.IsOutputRedirected
            if redirected || (name.Length + text.Length + 2 <= Width(error) && !text.Contains('\n')) {
                Message(name + ": " + text, color, error)
            } else {
                Message(name + ":", color, error)
                for line in text.Split('\n') {
                    Line(line, "default", error)
                }
            }
        }

        private func Label(name string) string {
            let text = name.Replace('_', ' ')
            return text.Length == 0 ? text: Char.ToUpperInvariant(text[0]).ToString() + text.Substring(1)
        }

        private func Fields(value JsonElement, prefix string = "") {
            for field in value.EnumerateObject() {
                let label = prefix + Label(field.Name)
                if field.Value.ValueKind == JsonValueKind.Object {
                    Message(label + ":", "default")
                    Fields(field.Value, "  ")
                } else if field.Value.ValueKind == JsonValueKind.Array {
                    let items = J.Items(field.Value)
                    if field.Name == "command" {
                        let words = StringBuilder()
                        for item in items {
                            if words.Length > 0 {
                                words.Append(' ')
                            }
                            let word = item.ToString()
                            words.Append(
                                Regex.IsMatch(word, "^[A-Za-z0-9_./:-]+$") ? word:
                                "'" + word.Replace("'", "'\"'\"'") + "'"
                            )
                        }
                        Message(label + ":", "default")
                        Line(Clean(words.ToString()), "default", false)
                        continue
                    }
                    Message(label + ":" + (items.Count == 0 ? " none": ""), "default")
                    for i in 0 ... items.Count {
                        if items[i].ValueKind == JsonValueKind.Object {
                            Message("  " + (i + 1).ToString() + ".", "default")
                            Fields(items[i], "    ")
                        } else {
                            Message("  " + items[i].ToString(), "default")
                        }
                    }
                } else {
                    let text = field.Value.ValueKind == JsonValueKind.String ? field.Value.GetString() ?? "":
                    field.Value.GetRawText()
                    let color = field.Name == "state" ||
                        field.Name == "status" ? (
                        text == "failed" ? "red": (text == "pending" ? "yellow": "green")
                    ): "default"
                    Row(label, text, color)
                }
            }
        }

        internal func Json(value JsonElement, title string) {
            if PublicOutput.Enabled {
                PublicOutput.ResultData = PublicOutput.Select(value, "reservation,donor,actor,expires,pr,url,head")
                return
            }
            if Console.IsOutputRedirected && !Plain && !Ascii {
                Console.WriteLine(J.Write(value))
                return
            }
            Heading(title)
            Fields(value)
        }

        internal func Checks(rows JsonElement) {
            for check in J.Items(rows) {
                var state = J.Text(check, "bucket")
                if state == "" {
                    state = J.Text(check, "state")
                }
                if state == "" {
                    state = "unknown"
                }
                Row(J.Text(check, "name"), state, state == "pass" ? "green": (state == "fail" ? "red": "yellow"))
                let link = J.Text(check, "link")
                if link != "" {
                    Message(link, "default")
                }
            }
        }
    }
}
