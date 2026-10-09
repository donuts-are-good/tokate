package TokateDesktop

import Goo
import System
import System.Diagnostics
import System.Text.Json

class DesktopSession {
    var Busy bool
    private var Runner CommandClient?
    private var timer WindowTimer?
    var Title string = ""
    var Elapsed int32
    var Output string = ""
    var ActivePage string = ""
    var ActionName string = ""
    var Visible bool
    var Stopping bool
    var Message string = ""
    var Report string = ""
    var Confirmation Action?
    var ConfirmationTitle string = ""
    var ConfirmationText string = ""
    var ConfirmationLabel string = "Confirm"
    var ConfirmationContent Func[Blob]?
    var Window Window?
    var Page string = "Welcome"
    var Streaming bool
    let Refresh Action
    let Navigate Action[string]
    let RememberRun Action[string]

    init(refresh Action, navigate Action[string], rememberRun Action[string]) {
        Refresh = refresh
        Navigate = navigate
        RememberRun = rememberRun
    }

    func Post(action Action) {
        Window?.TryPost(action)
    }

    func Cancel() {
        Stopping = true
        Runner?.Stop()
    }

    func Confirm(title string, text string, action Action, label string = "Confirm", content Func[Blob]? = nil) {
        ConfirmationTitle = title
        ConfirmationText = text
        Confirmation = action
        ConfirmationLabel = label
        ConfirmationContent = content
    }

    func Execute(
        arguments[]string,
        completed Action[CommandResult],
        tool string = "tokate",
        directory string = "",
        seconds int32 = 120,
        completeOnError bool = false,
        progress Action[int32, string]? = nil
    ) {
        if Busy {
            return
        }
        Busy = true
        if Runner == nil {
            ActivePage = Page
            Visible = false
        }
        Message = ""
        Report = ""
        let next = CommandClient()
        Runner = next
        let window = Window ?? throw InvalidOperationException("The desktop window is not attached.")
        Title = switch arguments[0] {
            case "claim": "Reserving donation"
            case "work": "Donation running"
            case "prepare": "Preparing donation"
            case "select": "Checking model selection"
            case "status": "Loading saved work"
            case "init": "Preparing project setup"
            case "doctor": "Checking prerequisites"
            case "recover": "Verifying contribution"
            case "submit": "Submitting contribution"
            case "publish": "Publishing draft PR"
            case "checks": "Checking pull request"
            default: "Loading contribution details"
        }
        Streaming = progress != nil
        Elapsed = 0
        Output = ""
        Stopping = false
        let elapsed = Stopwatch.StartNew()
        timer = window.SetInterval(
            () -> {
                let seconds = int32(elapsed.Elapsed.TotalSeconds)
                let output = progress != nil ? next.RecentOutput(): ""
                if !Visible || Elapsed != seconds || Output != output {
                    Visible = true
                    Elapsed = seconds
                    Output = output
                    progress?.Invoke(seconds, output)
                    Refresh()
                }
            },
            250
        )
        let callback = (result CommandResult) -> {
            Output = next.RecentOutput()
            Elapsed = int32(elapsed.Elapsed.TotalSeconds)
            progress?.Invoke(Elapsed, Output)
            timer?.Dispose()
            timer = nil
            Busy = false
            Message = result.Error != "" ? result.Error: TextOf(result.Value, "status") == "pending" ?
            "Pending. Another person or the coordinator needs to act.": result.ExitCode != 0 ?
            "This action needs attention.": ""
            if result.Error == "" || completeOnError {
                completed(result)
            }
            if !Busy {
                Runner = nil
                Streaming = false
            }
            Refresh()
        }
        go RunCommand(next, arguments, tool, directory, seconds, result -> Post(() -> callback(result)))
        Refresh()
    }

    func Error(result CommandResult) bool {
        if result.ExitCode == 0 {
            return false
        }
        if Page == "Donate" || Page == "My project" || Page == "Saved work" {
            Message = TextOf(Field(result.Value, "error"), "message")
            if Message == "" {
                Message = result.Diagnostics.Trim().Split('\n')[0]
            }
            if Message == "" {
                Message = "Could not complete this action."
            }
            Report = ""
            return true
        }
        ShowResult(result)
        return true
    }

    func ShowResult(result CommandResult) {
        let data = Field(result.Value, "data")
        let found = TextOf(data, "run")
        if found != "" {
            RememberRun(found)
        }
        let failure = Field(result.Value, "error")
        Report = failure.ValueKind == JsonValueKind.Object ? failure.ToString(): data.ToString()
        if Field(result.Value, "truncated").ValueKind == JsonValueKind.True {
            Report += "\nSome results were omitted by the CLI."
        }
    }
}
