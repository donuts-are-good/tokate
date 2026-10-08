package Tokate

import Gsharp.Concurrency
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Globalization
import System.Runtime.InteropServices
import System.Text
import System.Text.Json

internal class ModelChoice {
    internal let Model string
    internal let Effort string
    internal let Label string
    internal let Suggested bool
    internal var Selected bool

    internal init(model string, effort string, label string, suggested bool = false) {
        Model = model
        Effort = effort
        Label = label + " | " + model + " / " + effort
        Suggested = suggested
    }
}

internal class ModelChecklist {
    private let Choices List[ModelChoice] = List[ModelChoice]()
    private let Measurement RenderOptions = RenderOptions(
        Terminal.Output(true).Profile.Capabilities,
        Size(int32.MaxValue, 1)
    )
    private var Search string = ""
    private var Cursor int32
    private var Focus int32
    private var Redraw bool = true

    private func Add(model string, effort string, label string, suggested bool = false) {
        for choice in Choices {
            if choice.Model == model && choice.Effort == effort {
                return
            }
        }
        if Choices.Count < 2048 {
            Choices.Add(ModelChoice(model, effort, label, suggested))
        }
    }

    private func Profile(value JsonElement, suggested bool) {
        if !DonorSelection.Supported(value) {
            return
        }
        let harness = J.Text(value, "harness")
        Add(
            J.Text(value, "model"),
            J.Text(value, "effort"),
            J.Text(value, "provider") + " / " + harness + (harness == "pi" ? " [Local]": " [Subscription]"),
            suggested
        )
    }

    private func Discover() {
        try {
            let saved = DonorDefaults.Run(Args([]string{"defaults", "list"}))
            Profile(J.Get(saved, "default"), true)
            for entry in J.Get(saved, "profiles").EnumerateObject() {
                Profile(entry.Value, false)
            }
        } catch (error Exception) {
            Terminal.Message("Saved profiles unavailable; manual model entry remains available.", "yellow", true)
        }
        try {
            for entry in DonorSelection.Capabilities() {
                for effort in entry.Value {
                    Add(entry.Key, effort, "openai / codex [Subscription]")
                }
            }
        } catch (error Exception) {
            Terminal.Message("Offline harness catalog unavailable; model availability is unknown.", "yellow", true)
        }
        Sort()
    }

    private func Sort() -> Choices.Sort(
        (a, b) -> a.Suggested != b.Suggested ?
        (a.Suggested ? -1: 1): StringComparer.Ordinal.Compare(a.Label, b.Label)
    )

    private func Custom() {
        Console.Error.Write("Model name (blank returns): ")
        let model = Console.ReadLine()?.Trim() ?? throw Exception("Setup cancelled")
        if model == "" {
            return
        }
        RequestData.ModelIdentifier(model)
        Console.Error.Write("Allowed efforts, separated by spaces (absent for no effort control): ")
        let efforts = Console.ReadLine() ?? throw Exception("Setup cancelled")
        for effort in efforts.Replace(',', ' ').Split(' ', StringSplitOptions.RemoveEmptyEntries) {
            RequestData.Token(effort)
            Add(model, effort, "Owner entry [route unknown]")
            for choice in Choices {
                if choice.Model == model && choice.Effort == effort {
                    choice.Selected = true
                }
            }
        }
        Sort()
    }

    private func Result() string {
        let models = SortedDictionary[string, List[string]](StringComparer.Ordinal)
        for choice in Choices {
            if choice.Selected {
                if !models.ContainsKey(choice.Model) {
                    models[choice.Model] = List[string]()
                }
                models[choice.Model].Add(choice.Effort)
            }
        }
        let result = map[string, Object?]{}
        for entry in models {
            result[entry.Key] = entry.Value
        }
        return J.Write(result)
    }

    private func Plain() string {
        while true {
            Terminal.Message("Allowed models (availability unknown):", error: true)
            var index int32
            for choice in Choices {
                Terminal.Message(
                    (++ index).ToString() +
                        ") " +
                        (choice.Selected ? "[x] ": "[ ] ") +
                        choice.Label +
                        (choice.Suggested ? " (suggested)": ""),
                    error: true
                )
            }
            Console.Error.Write("Number toggles; add enters another model; Enter finishes; exit cancels: ")
            let answer = Console.ReadLine()?.Trim() ?? throw Exception("Setup cancelled")
            if answer == "" {
                return Result()
            }
            if answer == "exit" {
                throw Exception("Setup cancelled")
            }
            if answer == "add" {
                Custom()
            } else if int32.TryParse(answer, out index) && index > 0 && index <= Choices.Count {
                Choices[index - 1].Selected = !Choices[index - 1].Selected
            }
        }
    }

    private func Invalidate() {
        lock this {
            Redraw = true
        }
    }

    private func Cells(value string) int32 {
        let text IRenderable = Text(value)
        return text.Measure(Measurement, int32.MaxValue).Max
    }

    private func Crop(value string, width int32) string {
        let text = StringBuilder()
        let elements = StringInfo.GetTextElementEnumerator(Terminal.Clean(value).Replace('\n', ' '))
        var used int32
        while elements.MoveNext() {
            let item = elements.GetTextElement()
            let cells = Cells(item)
            if used + cells > width {
                break
            }
            text.Append(item)
            used += cells
        }
        return text.ToString()
    }

    private func Before(position int32) int32 {
        var previous int32
        for boundary in StringInfo.ParseCombiningCharacters(Search) {
            if boundary >= position {
                break
            }
            previous = boundary
        }
        return previous
    }

    private func After(position int32) int32 {
        for boundary in StringInfo.ParseCombiningCharacters(Search) {
            if boundary > position {
                return boundary
            }
        }
        return Search.Length
    }

    private func Screen() bool {
        let oldControl = Console.TreatControlCAsInput
        Console.TreatControlCAsInput = true
        Console.Error.Write("\x1b[?1049h\x1b[0m")
        using let resumed = PosixSignalRegistration.Create(PosixSignal.SIGCONT, context -> Invalidate())
        try {
            var previous = []string{}
            var previousCursor = ""
            var oldWidth int32
            var oldHeight int32
            while true {
                let width = Math.Max(1, Console.WindowWidth)
                let height = Math.Max(1, Console.WindowHeight)
                var full bool
                lock this {
                    full = Redraw || width != oldWidth || height != oldHeight
                    Redraw = false
                }
                oldWidth = width
                oldHeight = height
                let visible = Choices.FindAll(
                    choice -> choice.Label.Contains(Search, StringComparison.OrdinalIgnoreCase)
                )
                Focus = Math.Clamp(Focus, 0, Math.Max(0, visible.Count - 1))
                let count = Choices.FindAll(choice -> choice.Selected).Count
                let small = width < 32 || height < 8
                let rows = List[string]()
                var start = Cursor
                while start > 0 && Cells(Search.Substring(Before(start), Cursor - Before(start))) < width - 10 {
                    start = Before(start)
                }
                var cursorColumn = 9 + Cells(Search.Substring(start, Cursor - start))
                if small {
                    rows.Add("Enlarge terminal; Esc cancels")
                    cursorColumn = 1
                } else {
                    rows.Add("--< tokate | Allowed models")
                    rows.Add(count.ToString() + " selected | availability unknown")
                    rows.Add("Search: " + Search.Substring(start))
                    rows.Add("Arrows move; Space toggles; Enter accepts")
                    rows.Add("F2 adds a model; Esc cancels; Ctrl+L redraws")
                    for index in Focus ... visible.Count {
                        let choice = visible[index]
                        var remaining = (index == Focus ? "> ": "  ") +
                            (choice.Selected ? "[x] ": "[ ] ") +
                            choice.Label +
                            (choice.Suggested ? " (suggested)": "")
                        while remaining != "" && rows.Count < height - 1 {
                            let line = Crop(remaining, width - 1)
                            rows.Add(line)
                            remaining = remaining.Substring(line.Length)
                        }
                        if remaining != "" && index == Focus {
                            rows[rows.Count - 1] = "Enlarge terminal to view this entry"
                        }
                        if rows.Count >= height - 1 {
                            break
                        }
                    }
                    if visible.Count == 0 {
                        rows.Add("No matching models. F2 adds one.")
                    }
                }
                let update = StringBuilder(full ? "\x1b[0m\x1b[2J": "")
                for index in 0 ... Math.Min(height, Math.Max(rows.Count, full ? 0: previous.Length)) {
                    let line = index < rows.Count ? Crop(rows[index], width - 1): ""
                    if full || index >= previous.Length || line != previous[index] {
                        update.Append("\x1b[" + (index + 1).ToString() + ";1H\x1b[0m\x1b[2K" + line)
                    }
                    if index < rows.Count {
                        rows[index] = line
                    }
                }
                let location = "\x1b[" + (small ? "1": "3") + ";" + cursorColumn.ToString() + "H"
                if update.Length > 0 || location != previousCursor {
                    update.Append(location)
                    Console.Error.Write(update.ToString())
                }
                previousCursor = location
                previous = rows.ToArray()
                if !Console.KeyAvailable {
                    using let tick = after(TimeSpan.FromMilliseconds(100))
                    select {
                        case <- tick { }
                    }
                    continue
                }
                let key = Console.ReadKey(true)
                let control = (key.Modifiers & ConsoleModifiers.Control) != 0
                if key.Key == ConsoleKey.Escape || (control && key.Key == ConsoleKey.C) {
                    throw Exception("Setup cancelled")
                }
                if small {
                    continue
                }
                if key.Key == ConsoleKey.Enter {
                    return false
                }
                if key.Key == ConsoleKey.F2 {
                    return true
                }
                if control && key.Key == ConsoleKey.L {
                    Invalidate()
                } else if key.Key == ConsoleKey.UpArrow {
                    Focus = Math.Max(0, Focus - 1)
                } else if key.Key == ConsoleKey.DownArrow {
                    Focus = Math.Min(visible.Count - 1, Focus + 1)
                } else if key.Key == ConsoleKey.Spacebar && visible.Count > 0 {
                    visible[Focus].Selected = !visible[Focus].Selected
                } else if key.Key == ConsoleKey.LeftArrow {
                    Cursor = Before(Cursor)
                } else if key.Key == ConsoleKey.RightArrow {
                    Cursor = After(Cursor)
                } else if key.Key == ConsoleKey.Home || (control && key.Key == ConsoleKey.A) {
                    Cursor = 0
                } else if key.Key == ConsoleKey.End || (control && key.Key == ConsoleKey.E) {
                    Cursor = Search.Length
                } else if key.Key == ConsoleKey.Backspace && Cursor > 0 {
                    let before = Before(Cursor)
                    Search = Search.Remove(before, Cursor - before)
                    Cursor = before
                    Focus = 0
                } else if key.Key == ConsoleKey.Delete && Cursor < Search.Length {
                    Search = Search.Remove(Cursor, After(Cursor) - Cursor)
                    Focus = 0
                } else if control && key.Key == ConsoleKey.U {
                    Search = ""
                    Cursor = 0
                    Focus = 0
                } else if !Char.IsControl(key.KeyChar) && Search.Length < 256 {
                    Search = Search.Insert(Cursor++, key.KeyChar.ToString())
                    Focus = 0
                }
            }
        } finally {
            Console.Error.Write("\x1b[0m\x1b[?1049l")
            Console.TreatControlCAsInput = oldControl
        }
    }

    internal func Run() string {
        Discover()
        if Terminal.Plain || Environment.GetEnvironmentVariable("TERM") == "dumb" ||
            Console.IsInputRedirected ||
            Console.IsErrorRedirected ||
            Console.IsOutputRedirected {
            return Plain()
        }
        while Screen() {
            Custom()
            Invalidate()
        }
        return Result()
    }
}
