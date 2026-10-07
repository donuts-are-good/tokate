package Tokate

import Gsharp.Concurrency
import Spectre.Console
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Text
import System.Text.Json
import System.Text.RegularExpressions

internal class TerminalProgress : IDisposable {
    private let Stop Chan[bool] = Chan[bool](1)
    private let Finished Chan[bool] = Chan[bool](1)
    private let Phase string
    private let Budget RuntimeBudget
    private let Total RuntimeBudget?
    private let Interactive bool

    internal init(phase string, budget RuntimeBudget, total RuntimeBudget? = nil) {
        Phase = Terminal.Clean(phase).Replace('\n', ' ')
        Budget = budget
        Total = total
        Interactive = Terminal.Rich(true) && Terminal.Width(true) >= 80
        Draw()
        go Update()
    }

    private func Draw() {
        let value = Phase + ": " + Budget.Status() + (Total == nil ? "": "; total " + (Total?.Left() ?? "") + " left")
        if Interactive {
            let width = Terminal.Width(true) - 1
            Console.Error.Write("\r\x1b[2K" + value.Substring(0, Math.Min(width, value.Length)))
        } else {
            Terminal.Message(value, "cyan", true)
        }
    }

    private func Update() {
        try {
            var interval int32 = 5
            while true {
                using let tick = after(TimeSpan.FromSeconds(interval))
                select {
                    case <- Stop {
                        return
                    }
                    case <- tick {
                        Draw()
                        if !Interactive {
                            interval = Math.Min(86400, interval * 2)
                        }
                    }
                }
            }
        } catch (error Exception) { } finally {
            Finished <- true
        }
    }

    public func Dispose() {
        Stop <- true
        <-Finished
        if Interactive {
            Console.Error.Write("\r\x1b[2K")
        }
    }
}

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
                    !source.StartsWith("Next: ") && !remaining.StartsWith("tokate ") && !remaining.StartsWith("gh ") {
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

        internal func Foreground() bool -> Array.IndexOf(
            []string{"work", "recover", "external", "amend", "repair", "publish", "submit"},
            PublicOutput.Command
        ) >= 0

        internal func Step(text string) -> Message(text, "cyan", Foreground())

        internal func Command(command JsonElement, flatten bool = true) string {
            let words = StringBuilder()
            if command.ValueKind == JsonValueKind.Array {
                for item in command.EnumerateArray() {
                    AppendWord(words, item.ToString())
                }
            }
            return CommandText(words, flatten)
        }

        internal func Command(command[]string, flatten bool = true) string {
            let words = StringBuilder()
            for word in command {
                AppendWord(words, word)
            }
            return CommandText(words, flatten)
        }

        private func AppendWord(words StringBuilder, word string) {
            if words.Length > 0 {
                words.Append(' ')
            }
            words.Append(
                Regex.IsMatch(word, "^[A-Za-z0-9_./:-]+$") ? word:
                "'" + word.Replace("'", "'\"'\"'") + "'"
            )
        }

        private func CommandText(words StringBuilder, flatten bool) string {
            let text = Clean(words.ToString())
            return flatten ? text.Replace('\n', ' '): text
        }

        internal func Verify(
            storage string,
            results List[Object],
            command JsonElement,
            directory string,
            network bool,
            seconds int32,
            budget RuntimeBudget? = nil,
            progressBudget RuntimeBudget? = nil,
            workspace VerificationWorkspace? = nil
        ) CommandResult {
            let name = "Verification " + (results.Count + 1).ToString() + ": " + PublicOutput.Prose(Command(command))
            let timing = progressBudget ?? budget ?? RuntimeBudget(Stopwatch.StartNew(), seconds)
            try {
                workspace?.CheckCancellation()
                var result CommandResult
                Message(name, "cyan", true)
                {
                    using let progress = TerminalProgress(
                        "Owner verification " + (results.Count + 1).ToString(),
                        timing
                    )
                    result = Verification.Check(
                        storage,
                        results,
                        command,
                        workspace?.Checkout ?? directory,
                        network,
                        seconds,
                        budget,
                        workspace?.Original ?? ""
                    )
                }
                Message(
                    name + " - " + (result.Code == 0 ? "passed": "failed") + " (exit " + result.Code.ToString() +
                        "); " +
                        timing.Status(),
                    result.Code == 0 ? "green": "red",
                    true
                )
                return result
            } catch (error Exception) {
                Message(
                    name + " - interrupted or failed; verification_failed. Details: " + Path.Combine(
                        storage,
                        "verification.json"
                    ),
                    "red",
                    true
                )
                throw error
            }
        }

        internal func RunOutcome(exitCode int32, code string) {
            if PublicOutput.RunDirectory == "" || !Foreground() {
                return
            }
            try {
                let run = Data.Load(PublicOutput.RunDirectory)
                var stage = "Run"
                if code == "inference_failed" {
                    stage = "Inference"
                } else if code == "verification_failed" {
                    stage = "Verification"
                } else if run.Text("state") == "generated" && exitCode != 0 {
                    stage = "Publication"
                }
                var outcome = " failed (" + code + ")"
                var color = "red"
                if exitCode == 0 {
                    outcome = " completed"
                    color = "green"
                } else if exitCode == 8 {
                    outcome = " pending"
                    color = "yellow"
                }
                Message(stage + outcome + ". Run: " + PublicOutput.RunDirectory, color, true)
                let summary = RunSummaryArtifacts(PublicOutput.RunDirectory)
                Message("Saved artifacts: " + summary, "default", true)
                for action in PublicOutput.Actions {
                    Message("Next: " + Command(action), "default", true)
                }
            } catch (error Exception) { }
        }

        private func RunSummaryArtifacts(directory string) string -> String.Join(
            ", ",
            PublicOutput.Artifacts(directory).Keys
        )

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

        internal func InteractiveHeading() {
            if Rich() && Width() >= 40 {
                Message("--< tokate", "green")
            } else {
                Message("tokate", "default")
            }
        }

        private func StatusAction(next JsonElement) {
            Message("Next action: " + J.Text(next, "action"), "default")
            Row("Role", J.Text(next, "role"))
            let command = Command(J.Get(next, "command"))
            if command != "" {
                Row("Command", command)
            }
        }

        internal func SavedRun(value JsonElement) {
            if Console.IsOutputRedirected && !Plain && !Ascii {
                Json(value, "Donor run")
                return
            }
            Heading("Donor run")
            var details = ""
            for action in PublicOutput.Actions {
                if action.Length > 1 {
                    if action[1] == "status" {
                        details = Command(action)
                    } else {
                        Row("Next", Command(Array.FindAll(action, word -> word != "--json")))
                    }
                }
            }
            let state = J.Text(value, "state")
            if state != "" {
                Row("State", state, state == "failed" ? "red": "yellow")
            }
            let repo = J.Text(value, "repo")
            let issue = J.Get(value, "issue").ToString()
            if repo != "" {
                Row("Task", repo + (issue == "" ? "": " #" + issue))
            }
            let checks = J.Items(J.Get(value, "verification"))
            if checks.Count == 0 {
                Row("Verification", "no result recorded")
            } else {
                let check = checks[checks.Count - 1]
                let checkState = J.Text(check, "state")
                Row("Verification", J.Number(value, "verification_count").ToString() + " recorded")
                if checkState != "" {
                    Row("Recorded check", checkState)
                }
                let exitCode = J.Get(check, "exit_code").ToString()
                if exitCode != "" {
                    Row("Exit code", exitCode)
                }
                let command = Command(J.Get(check, "command"))
                if command != "" && exitCode != "0" {
                    Row("Command", command)
                }
            }
            for key in[]string{"run", "donor", "model", "effort", "pr_url"} {
                let text = J.Text(value, key)
                if text != "" {
                    Row(key == "pr_url" ? "PR": Label(key), text)
                }
            }
            if J.Text(value, "model") == "" {
                for tool in J.Items(J.Get(value, "tools")) {
                    let model = J.Text(tool, "model")
                    let effort = J.Text(tool, "effort")
                    if model != "" {
                        Row("Reported model", model + (effort == "" ? "": " / " + effort))
                    }
                }
            }
            let failure = J.Text(J.Get(value, "error"), "message")
            if failure != "" {
                Row("Error", failure, "red")
            }
            let correction = J.Get(value, "correction")
            let correctionState = J.Text(correction, "state")
            if correctionState != "" {
                Row("Correction", correctionState, correctionState == "failed" ? "red": "yellow")
            }
            let correctionFailure = J.Text(J.Get(correction, "error"), "message")
            if correctionFailure != "" {
                Row("Correction error", correctionFailure, "red")
            }
            if J.Bool(value, "truncated") {
                Message("Bounded snapshot: some data was omitted.", "yellow")
            }
            if details != "" {
                Row("Details", details)
            }
        }

        internal func ContributionStatus(value JsonElement) {
            if PublicOutput.Enabled {
                return
            }
            if Console.IsOutputRedirected && !Plain && !Ascii {
                Console.WriteLine(J.Write(value))
                return
            }
            let remote = J.Text(value, "remote_status")
            if remote != "observed" {
                Row("Status", remote == "unavailable" ? "unavailable; partial facts only": remote, "yellow")
            }
            if J.Bool(value, "truncated") {
                Message("Bounded snapshot: some data was omitted.", "yellow")
            }
            let work = J.Items(J.Get(value, "work"))
            let pending = J.Items(J.Get(value, "pending_requests")).Count
            if remote != "observed" || work.Count == 0 || pending > 0 {
                StatusAction(J.Get(value, "next"))
            }
            Row("Repository", J.Text(value, "repo"))
            if pending > 0 {
                Row("Pending access requests", pending.ToString(), "yellow")
            }
            if work.Count == 0 {
                Row("Issue", "none observed")
                if remote == "observed" {
                    Row(
                        "State",
                        pending > 0 ?
                        "access review needed": "no approved work observed"
                    )
                }
            }
            for task in work {
                if remote == "observed" {
                    StatusAction(J.Get(task, "next"))
                }
                let title = Clean(J.Text(task, "title")).Replace('\n', ' ').Trim()
                let prefix = "Issue: #" + J.Number(task, "issue").ToString() + " "
                let limit = Math.Max(4, Math.Min(80, Width() - prefix.Length))
                var length = Math.Min(limit - 3, title.Length)
                if length > 0 && Char.IsHighSurrogate(title[length - 1]) {
                    length--
                }
                Message(prefix + (title.Length > limit ? title.Substring(0, length) + "...": title), "default")
                Message("State: " + J.Text(task, "state").Replace('_', ' '), "yellow")
                Row("Issue URL", J.Text(task, "url"))
                for draft in J.Items(J.Get(task, "drafts")) {
                    Row("PR", J.Text(draft, "url"))
                    Row("Contribution", J.Text(draft, "lifecycle").Replace('_', ' '))
                    Row("Receipt", J.Text(draft, "receipt"))
                }
            }
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
                        Message(label + ":", "default")
                        Line(Command(field.Value, false), "default", false)
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
                    let color = field.Name == "state" || field.Name == "status" || field.Name.EndsWith(
                        "_status",
                        StringComparison.Ordinal
                    ) ? (
                        text == "failed" || text == "ci_failed" ? "red":
                        (
                            text == "passed" ||
                                text == "pass" ||
                                text == "current" ||
                                text == "eligible" ? "green": "yellow"
                        )
                    ): "default"
                    Row(label, text, color)
                }
            }
        }

        internal func Json(value JsonElement, title string) {
            if PublicOutput.Enabled {
                PublicOutput.ResultData = PublicOutput.Select(
                    value,
                    "reservation,lease,donor,actor,expires,status,attempt,pr,url,head"
                )
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
