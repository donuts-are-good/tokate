package Tokate

import Spectre.Console
import System
import System.IO
import System.Text
import System.Text.Json

internal class Terminal {
    shared {
        internal func Clean(value string) string {
            let text = StringBuilder()
            for c in value {
                if !Char.IsControl(c) || c == '\n' || c == '\t' {
                    text.Append(c)
                }
            }
            return text.ToString()
        }

        internal func Rich(error bool = false) bool -> !(
            error ? Console.IsErrorRedirected: Console.IsOutputRedirected
        ) &&
            Environment.GetEnvironmentVariable("TERM") != "dumb"

        internal func Output(error bool = false) IAnsiConsole -> AnsiConsole.Create(
            AnsiConsoleSettings{
                Out: AnsiConsoleOutput(error ? Console.Error: Console.Out),
                Ansi: Rich(error) && Environment.GetEnvironmentVariable(
                    "NO_COLOR"
                ) == nil ? AnsiSupport.Yes: AnsiSupport.No,
                Interactive: InteractionSupport.No,
            }
        )

        internal func Message(text string, color string = "green", error bool = false) {
            let value = Clean(text)
            if Rich(error) {
                Output(error).MarkupLine("[" + color + "]" + Markup.Escape(value) + "[/]")
            } else if error {
                Console.Error.WriteLine(value)
            } else {
                Console.WriteLine(value)
            }
        }

        internal func Step(text string) -> Message(text, "cyan")

        internal func Help() {
            if !Rich() {
                Console.WriteLine(Data.Resource("help.txt"))
                return
            }
            for line in Data.Resource("help.txt").Split('\n') {
                let style = line.StartsWith("Tokate") ? "bold cyan": (line.EndsWith(":") ? "bold": "default")
                Message(line, style)
            }
        }

        internal func Json(value JsonElement, title string) {
            if !Rich() {
                Console.WriteLine(J.Write(value))
                return
            }
            let table = Table()
            table.Border = TableBorder.Rounded
            table.AddColumn("Field")
            table.AddColumn("Value")
            for field in value.EnumerateObject() {
                var text = field.Value.ValueKind == JsonValueKind.String ? field.Value.GetString() ?? "": field
                    .Value
                    .GetRawText()
                if title == "Donor run" && field.Name == "verification" {
                    text = J.Items(field.Value).Count.ToString() + " commands. See verification.json."
                }
                table.AddRow(Markup.Escape(Clean(field.Name)), Markup.Escape(Clean(text)))
            }
            Message(title, "bold cyan")
            Output().Write(table)
        }
    }
}
