package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Runtime.InteropServices
import System.Text

internal class DonationView {
    private let Gate Object = Object()
    private let Stop Chan[bool] = Chan[bool](1)
    private let Finished Chan[bool] = Chan[bool](1)
    private let Transcript List[string] = List[string]()
    private var Footer string = "Starting donation..."
    private var Dirty bool = true
    private var Redraw bool = true
    private var Scroll int32
    private var Width int32
    private var Height int32
    private var Previous[]string = []string{}
    private let Content List[string] = List[string]()
    private var ContentDirty bool = true

    private func Draw() {
        let width = Math.Max(1, Console.WindowWidth)
        let height = Math.Max(1, Console.WindowHeight)
        let full = Redraw || width != Width || height != Height
        if !Dirty && !full {
            return
        }
        Width = width
        Height = height
        Redraw = false
        Dirty = false
        let rows = List[string]()
        let page = Math.Max(1, height - 4)
        if ContentDirty || full {
            let previousCount = Content.Count
            Content.Clear()
            for line in Transcript {
                var remaining = line
                if remaining == "" {
                    Content.Add("")
                }
                while remaining != "" {
                    let part = WizardScreen.Clip(remaining, Math.Max(1, width - 1))
                    if part == "" {
                        break
                    }
                    Content.Add(part)
                    remaining = remaining.Substring(part.Length)
                }
            }
            if Scroll > 0 && ContentDirty {
                Scroll += Math.Max(0, Content.Count - previousCount)
            }
            ContentDirty = false
        }
        Scroll = Math.Clamp(Scroll, 0, Math.Max(0, Content.Count - page))
        let start = Math.Max(0, Content.Count - page - Scroll)
        rows.Add(WizardScreen.Color("gold") + WizardScreen.Clip("tokate / Donation", width - 1))
        for i in 0 ... page {
            rows.Add(WizardScreen.Color("ink") + (start + i < Content.Count ? Content[start + i]: ""))
        }
        rows.Add(
            WizardScreen.Color("muted") + WizardScreen.Clip("PgUp/PgDn scroll   End follow   Ctrl+C stop", width - 1)
        )
        rows.Add(WizardScreen.Color("sage") + WizardScreen.Clip(Footer, width - 1))
        let output = StringBuilder(full ? WizardScreen.Color("paper") + "\x1b[H\x1b[2J": "")
        for i in 0 ... Math.Min(height, rows.Count) {
            let row = rows[i]
            if full || i >= Previous.Length || row != Previous[i] {
                output.Append(
                    "\x1b[" + (i + 1).ToString() + ";1H" + WizardScreen.Color("paper") + WizardScreen.Color("ink") +
                        row +
                        "\x1b[K"
                )
            }
        }
        if output.Length > 0 {
            Console.Error.Write(output.Append("\x1b[" + height.ToString() + ";1H").ToString())
        }
        Previous = rows.ToArray()
    }

    private func Update() {
        try {
            using let resumed = PosixSignalRegistration.Create(
                PosixSignal.SIGCONT,
                context -> {
                    lock Gate {
                        Redraw = true
                    }
                }
            )
            while true {
                lock Gate {
                    while Console.KeyAvailable {
                        let key = Console.ReadKey(true)
                        if key.Key == ConsoleKey.PageUp {
                            Scroll += Math.Max(1, Height - 4)
                        } else if key.Key == ConsoleKey.PageDown {
                            Scroll = Math.Max(0, Scroll - Math.Max(1, Height - 4))
                        } else if key.Key == ConsoleKey.End {
                            Scroll = 0
                        } else if key.Key == ConsoleKey.L && (key.Modifiers & ConsoleModifiers.Control) != 0 {
                            Redraw = true
                        }
                        Dirty = true
                    }
                    Draw()
                }
                using let tick = after(TimeSpan.FromMilliseconds(100))
                select {
                    case <- Stop {
                        return
                    }
                    case <- tick { }
                }
            }
        } catch (error Exception) { } finally {
            Finished <- true
        }
    }

    shared {
        private var Current DonationView?

        internal func Active() bool -> Current != nil

        internal func Start() bool {
            if !WizardScreen.Available() {
                return false
            }
            if Current == nil {
                WizardScreen.Open()
                let view = DonationView()
                Current = view
                go view.Update()
            }
            return true
        }

        internal func Append(text string) {
            if let view = Current {
                let safe = Terminal.Clean(text)
                lock view.Gate {
                    for line in safe.Split('\n') {
                        view.Transcript.Add(line.Substring(0, Math.Min(line.Length, 4096)))
                    }
                    if view.Transcript.Count > 500 {
                        view.Transcript.RemoveRange(0, view.Transcript.Count - 500)
                    }
                    view.Dirty = true
                    view.ContentDirty = true
                }
            }
        }

        internal func Status(text string) {
            if let view = Current {
                lock view.Gate {
                    view.Footer = Terminal.Clean(text)
                    view.Dirty = true
                }
            }
        }

        internal func Close() {
            if let view = Current {
                view.Stop <- true
                <-view.Finished
                lock view.Gate {
                    view.Draw()
                }
                Current = nil
                WizardScreen.Close()
            }
        }
    }
}
