package Tokate

import Gsharp.Concurrency
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Globalization
import System.Runtime.InteropServices
import System.Text

internal class WizardHome : Exception { }

internal class WizardScreen {
    shared {
        private var Opened bool

        internal func Available() bool -> Interactive.Available() &&
            !Terminal.Plain &&
            Environment.GetEnvironmentVariable("TERM") != "dumb"

        internal func Open() {
            if !Opened && Available() {
                Console.Error.Write("\x1b[?1049h")
                Opened = true
            }
        }

        internal func Close() {
            if Opened {
                Console.Error.Write("\x1b[0m\x1b[?1049l")
                Opened = false
            }
        }

        internal func Pending(text string = "Loading next step...") bool {
            if !Opened {
                return false
            }
            Console.Error.Write(
                "\r" +
                    Color("paper") +
                    Color("muted") +
                    Clip(Terminal.Clean(text).Replace('\n', ' '), Math.Max(1, Console.WindowWidth - 1)) +
                    "\x1b[K"
            )
            return true
        }

        internal func Color(name string) string {
            if Terminal.Plain || Environment.GetEnvironmentVariable("NO_COLOR") != nil ||
                Environment.GetEnvironmentVariable("TERM") == "dumb" {
                return ""
            }
            let rich = Terminal.Output(true).Profile.Supports(ColorSystem.TrueColor)
            let code = switch name {
                case "gold": rich ? "38;2;226;187;128": "93"
                case "sage": rich ? "38;2;176;191;166": "92"
                case "muted": rich ? "38;2;193;198;203": "37"
                case "paper": rich ? "48;2;35;50;75": "44"
                default: rich ? "38;2;238;229;207": "97"
            }
            return "\x1b[" + code + "m"
        }

        internal func Cells(value string) int32 {
            let text IRenderable = Text(value)
            return text.Measure(
                RenderOptions(Terminal.Output(true).Profile.Capabilities, Size(int32.MaxValue, 1)),
                int32.MaxValue
            )
                .Max
        }

        internal func Clip(value string, width int32) string {
            let text = StringBuilder()
            let measurement = RenderOptions(Terminal.Output(true).Profile.Capabilities, Size(int32.MaxValue, 1))
            let elements = StringInfo.GetTextElementEnumerator(value)
            var used int32
            while elements.MoveNext() {
                let item = elements.GetTextElement()
                let rendered IRenderable = Text(item)
                let cells = rendered.Measure(measurement, int32.MaxValue).Max
                if used + cells > width {
                    break
                }
                text.Append(item)
                used += cells
            }
            return text.ToString()
        }

        internal func Before(value string, position int32) int32 {
            var previous int32
            for boundary in StringInfo.ParseCombiningCharacters(value) {
                if boundary >= position {
                    break
                }
                previous = boundary
            }
            return previous
        }

        internal func After(value string, position int32) int32 {
            for boundary in StringInfo.ParseCombiningCharacters(value) {
                if boundary > position {
                    return boundary
                }
            }
            return value.Length
        }

        private func Lines(title string, body string, width int32, height int32) List[string] {
            let rows = List[string]()
            if title == "Welcome" && width >= 64 && height >= 19 {
                let sprig = []string{
                    "       .-.    ",
                    "  .-. ( /     ",
                    "  (  \\ / .-.  ",
                    "   `-.Y ( /   ",
                    " .-. /.-'     "
                }
                let logo = []string{
                    "   _        _         _",
                    "  | |_ ___ | | ____ _| |_ ___",
                    "  | __/ _ \\| |/ / _` | __/ _ \\",
                    "  | || (_) |   < (_| | ||  __/",
                    "   \\__\\___/|_|\\_\\__,_|\\__\\___|"
                }
                for i in 0 ... logo.Length {
                    rows.Add(Color("sage") + sprig[i] + Color("gold") + logo[i])
                }
                rows.Add(Color("sage") + "(  _/         " + Color("muted") + " . . . . . . . . . . . . . .")
                rows.Add(Color("sage") + " `-/          " + Color("ink") + " Give your inference a purpose.")
            } else {
                rows.Add(
                    Color("gold") + (title == "Welcome" ? "--<()<()-- tokate": "tokate / " + Terminal.Clean(title))
                )
                if title == "Welcome" {
                    rows.Add(Color("ink") + "Give your inference a purpose.")
                }
            }
            rows.Add("")
            for paragraph in Terminal.Clean(body).Split('\n') {
                var remaining = paragraph.Replace('\t', ' ')
                if remaining == "" {
                    rows.Add("")
                }
                while remaining != "" {
                    let line = Clip(remaining, width - 1)
                    if line == "" {
                        break
                    }
                    rows.Add(Color("ink") + line)
                    remaining = remaining.Substring(line.Length)
                }
            }
            rows.Add(Color("muted") + "h Home   q Quit   ? Explain")
            return rows
        }

        private func Input(title string, body string, prompt string, fallback string) string {
            let prefix = Terminal.Clean(prompt + (fallback == "" ? "": " [" + fallback + "]") + ": ")
            if !Available() {
                Console.Error.WriteLine("\ntokate / " + Terminal.Clean(title) + "\n" + Terminal.Clean(body))
                Console.Error.WriteLine("h Home   q Quit   ? Explain")
                Console.Error.Write(Terminal.Clean(prefix))
                return Console.ReadLine() ?? throw OperationCanceledException("Cancelled")
            }
            let oldControl = Console.TreatControlCAsInput
            Console.TreatControlCAsInput = true
            Open()
            var redraw = true
            let gate = Object()
            using let resumed = PosixSignalRegistration.Create(
                PosixSignal.SIGCONT,
                context -> {
                    lock gate {
                        redraw = true
                    }
                }
            )
            var value = ""
            var cursor int32
            var previous = []string{}
            var location = ""
            var oldWidth int32
            var oldHeight int32
            var scroll int32
            try {
                while true {
                    let width = Math.Max(1, Console.WindowWidth)
                    let height = Math.Max(1, Console.WindowHeight)
                    var full bool
                    lock gate {
                        full = redraw || width != oldWidth || height != oldHeight
                        redraw = false
                    }
                    oldWidth = width
                    oldHeight = height
                    let small = width < 32 || height < 8
                    let longPrompt = Cells(prefix) > Math.Max(1, width / 2)
                    let content = small ? List[string]{Clip("Enlarge terminal. Esc returns home.", width - 1)}: Lines(
                        title,
                        body + (longPrompt ? "\n\n" + prefix: ""),
                        width,
                        height
                    )
                    let page = Math.Max(1, height - 3)
                    scroll = Math.Clamp(scroll, 0, Math.Max(0, content.Count - page))
                    let rows = content.GetRange(scroll, Math.Min(page, content.Count - scroll))
                    var start = cursor
                    let label = longPrompt ? "Value: ": prefix
                    let available = Math.Max(1, width - Cells(label) - 1)
                    while start > 0 &&
                        Cells(value.Substring(Before(value, start), cursor - Before(value, start))) < available {
                        start = Before(value, start)
                    }
                    var column = 1
                    if !small {
                        if content.Count > page {
                            rows.Add(
                                Color("muted") + "PgUp/PgDn scroll  " + (scroll + 1).ToString() +
                                    "/" +
                                    content
                                    .Count
                                    .ToString()
                            )
                        }
                        rows.Add(Color("gold") + label + Color("ink") + Clip(value.Substring(start), available))
                        column = Cells(label) + Cells(value.Substring(start, cursor - start)) + 1
                    }
                    let output = StringBuilder(full ? Color("paper") + "\x1b[H\x1b[2J": "")
                    for i in 0 ... Math.Min(height, Math.Max(rows.Count, previous.Length)) {
                        let line = i < rows.Count ? rows[i]: ""
                        if full || i >= previous.Length || line != previous[i] {
                            output.Append(
                                "\x1b[" + (i + 1).ToString() +
                                    ";1H" +
                                    Color("paper") +
                                    Color("ink") +
                                    line +
                                    Color("paper") +
                                    "\x1b[K"
                            )
                        }
                    }
                    let next = "\x1b[" + rows.Count.ToString() + ";" + column.ToString() + "H"
                    if output.Length > 0 || location != next {
                        Console.Error.Write(output.Append(next).ToString())
                    }
                    previous = rows.ToArray()
                    location = next
                    if !Console.KeyAvailable {
                        using let timer = after(TimeSpan.FromMilliseconds(100))
                        select {
                            case <- timer { }
                        }
                        continue
                    }
                    let key = Console.ReadKey(true)
                    let control = (key.Modifiers & ConsoleModifiers.Control) != 0
                    if control && (key.Key == ConsoleKey.C || key.Key == ConsoleKey.D) {
                        throw OperationCanceledException("Cancelled")
                    }
                    if key.Key == ConsoleKey.Escape {
                        throw WizardHome()
                    }
                    if small {
                        continue
                    }
                    if key.Key == ConsoleKey.Enter {
                        return value
                    }
                    if key.Key == ConsoleKey.PageUp {
                        scroll = Math.Max(0, scroll - page)
                    } else if key.Key == ConsoleKey.PageDown {
                        scroll = Math.Min(content.Count - page, scroll + page)
                    } else if control && key.Key == ConsoleKey.L {
                        lock gate {
                            redraw = true
                        }
                    } else if key.Key == ConsoleKey.LeftArrow {
                        cursor = Before(value, cursor)
                    } else if key.Key == ConsoleKey.RightArrow {
                        cursor = After(value, cursor)
                    } else if key.Key == ConsoleKey.Home {
                        cursor = 0
                    } else if key.Key == ConsoleKey.End {
                        cursor = value.Length
                    } else if key.Key == ConsoleKey.Backspace && cursor > 0 {
                        let before = Before(value, cursor)
                        value = value.Remove(before, cursor - before)
                        cursor = before
                    } else if key.Key == ConsoleKey.Delete && cursor < value.Length {
                        value = value.Remove(cursor, After(value, cursor) - cursor)
                    } else if control && key.Key == ConsoleKey.U {
                        value = ""
                        cursor = 0
                    } else if !Char.IsControl(key.KeyChar) && value.Length < 4096 {
                        value = value.Insert(cursor++, key.KeyChar.ToString())
                    }
                }
            } finally {
                Console.TreatControlCAsInput = oldControl
                Pending()
            }
        }

        internal func Read(title string, body string, prompt string, fallback string = "", help string = "") string {
            var note = ""
            while true {
                let value = Input(title, body + (note == "" ? "": "\n\n" + note), prompt, fallback).Trim()
                if value == "q" || value == "exit" {
                    throw OperationCanceledException("Cancelled")
                }
                if value == "h" {
                    throw WizardHome()
                }
                if value == "?" {
                    note = help == "" ? "Choose the next action. Nothing starts without confirmation.": help
                } else {
                    return value == "" ? fallback: value
                }
            }
        }

        internal func Choose(title string, body string, options[]string, help string = "", selected int32 = 0) int32 {
            let text = StringBuilder(body + "\n\n")
            for i in 0 ... options.Length {
                text.AppendLine((i + 1).ToString() + "  " + options[i])
            }
            var note = ""
            while true {
                let answer = Read(
                    title,
                    text.ToString() + note,
                    "Choice",
                    selected == 0 ? "": selected.ToString(),
                    help
                )
                var choice int32
                if int32.TryParse(answer, out choice) && choice > 0 && choice <= options.Length {
                    return choice
                }
                note = "Choose a number from 1 to " + options.Length.ToString() + "."
            }
        }
    }
}
