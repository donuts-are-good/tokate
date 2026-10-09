package TokateDesktop

import Goo
import Goo.Widgets.Icons
import System
import System.Collections.Generic
import System.IO
import System.Text.Json

partial class Desktop {
    private var donation JsonElement
    private var donationPath string = ""
    private var donationReady bool
    private var donationStarted bool
    private var donationRunning bool
    private var donationOutput string = ""
    private var donationElapsed int32
    private var donationState string = ""
    private var approvalTimer WindowTimer?
    private var approvalRunner CommandRunner?
    private let outputViewport ElementHandle = ElementHandle()
    private var outputRange float64
    private var outputOffset float64
    private var followOutput bool = true
    private var renderedOutput string = ""
    private var renderedTheme float64 = -1
    private var activityLines List[ActivityLine] = List[ActivityLine]()

    private func OpenDonation(value JsonElement, directory string, navigate bool = true) {
        StopSavedUpdates()
        approvalTimer?.Dispose()
        approvalRunner?.Stop()
        approvalRunner = nil
        donation = value
        donationPath = directory
        run = value
        runDirectory = directory
        runActions.Clear()
        donationReady = TextOf(value, "state") == "claimed"
        if donationReady {
            runActions.Add("work")
        }
        if TextOf(value, "state") == "claim_pending" {
            runActions.Add("prepare")
        }
        donationStarted = false
        donationOutput = ""
        donationElapsed = 0
        donationState = donationReady ? "Ready to start": "Waiting for approval"
        if navigate {
            page = "Donate"
        }
        step = 3
        report = ""
        message = ""
        if TextOf(value, "state") == "claim_pending" {
            approvalTimer = host?.SetInterval(() -> CheckDonationApproval(), 5000)
            CheckDonationApproval()
        }
    }

    private func CheckDonationApproval() {
        if busy || page != "Donate" || donationReady || donationStarted || approvalRunner != nil {
            return
        }
        let next = CommandRunner()
        approvalRunner = next
        let directory = donationPath
        let callback = (ready bool, error string) -> {
            if approvalRunner != next || donationPath != directory {
                return
            }
            approvalRunner = nil
            donationReady = ready
            donationState = ready ? "Ready to start": error == "" ? "Waiting for approval": error
            if ready {
                approvalTimer?.Dispose()
                approvalTimer = nil
            }
            Rebuild()
        }
        go ReadReservation(
            next,
            (host ?? throw InvalidOperationException("Window is not attached.")),
            donation,
            directory,
            callback
        )
    }

    private func StartDonation() {
        if !donationReady || busy {
            return
        }
        let value = donation
        let directory = donationPath
        let unbounded = Field(value, "unlimited").ValueKind == JsonValueKind.True
        let tools = Items(Field(value, "tools"))
        let tool = tools.Count > 0 ? TextOf(tools[0], "harness"): TextOf(value, "harness")
        Confirm(
            "Start donation?",
            "",
            () -> {
                donationStarted = true
                donationRunning = true
                donationReady = false
                runActions.Clear()
                donationState = "Donation running"
                outputRange = 0
                outputOffset = 0
                followOutput = true
                Execute(
                    []string{"work", "--run", directory, "--yes"},
                    result -> {
                        let updated = Field(result.Value, "data")
                        if TextOf(updated, "run") != "" {
                            donation = updated
                        }
                    },
                    seconds: unbounded ? 0: Math.Clamp(Number(value, "seconds") + 600, 600, 87000)
                )
            },
            label: "Start this donation",
            content: () -> Container{
                Gap: 16,
                Heading(TextOf(value, "repo") + " #" + TextOf(value, "issue"), 25),
                Row(
                    []Blob{
                        SummaryTile(
                            "Coding",
                            unbounded ? "Unlimited": (Number(value, "coding_seconds") / 60).ToString() + " minutes",
                            "schedule"
                        ),
                        SummaryTile(
                            "Verification",
                            (Number(value, "verification_reserve") / 60).ToString() + " minutes",
                            "verified"
                        ),
                    }
                ),
                ReviewDetail(
                    "Model",
                    (tool == "" ? "": tool + " / ") + TextOf(value, "model") + " / " + TextOf(value, "effort")
                ),
                ReviewDetail("Network", Field(value, "network").ValueKind == JsonValueKind.True ? "Allowed": "Offline"),
            }
        )
    }

    private func Donation() Blob {
        let unbounded = Field(donation, "unlimited").ValueKind == JsonValueKind.True
        let codingTime = unbounded ? "Unlimited": (Number(donation, "coding_seconds") / 60).ToString() + " minutes"
        let verificationTime = (Number(donation, "verification_reserve") / 60).ToString() + " minutes"
        let body = Container{
            Height: donationStarted ? Percent(100): Length.Auto,
            MinHeight: 0,
            Gap: 18,
            DonationHeading(),
            Label(
                donationPath == "" ? selectedRepository +
                    " #" +
                    issue: TextOf(donation, "repo") +
                    " #" +
                    TextOf(donation, "issue"),
                21
            ),
        }
        if !donationStarted {
            let waiting = DonatePanel()
            waiting.Children.Add(
                Row(
                    []Blob{
                        MaterialIcons.Create(donationReady ? "task_alt": "hourglass_top", 32, Accent()),
                        Heading(donationState, 32),
                    }
                )
            )
            if donationPath != "" {
                waiting.Children.Add(
                    Row(
                        []Blob{
                            SummaryTile("Coding", codingTime, "schedule"),
                            SummaryTile("Verification", verificationTime, "verified"),
                        }
                    )
                )
                waiting.Children.Add(
                    ReviewDetail("Model", TextOf(donation, "model") + " / " + TextOf(donation, "effort"))
                )
            }
            if message != "" {
                waiting.Children.Add(Label(message, 17, true))
            }
            waiting.Children.Add(Row([]Blob{Action("Start donation", () -> StartDonation(), true, !donationReady)}))
            if busy && page == activityPage {
                waiting.Children.Add(Row([]Blob{CancelCommand()}))
            }
            if !busy && donationPath == "" {
                waiting.Children.Add(Row([]Blob{Action("Inspect saved work", () -> Navigate("Saved work"))}))
            }
            body.Children.Add(waiting)
            return body
        }
        if renderedOutput != donationOutput || renderedTheme != twilight.Value || activityLines.Count == 0 {
            renderedOutput = donationOutput
            renderedTheme = twilight.Value
            let rows = List[ActivityLine]()
            let lines = (donationOutput == "" ? "Starting donation...": donationOutput).Split('\n')
            for i in 0 ... lines.Length {
                if !String.IsNullOrWhiteSpace(lines[i]) {
                    rows.Add(ActivityLine{Index: i, Content: lines[i].TrimEnd('\r'), Theme: renderedTheme})
                }
            }
            activityLines = rows
        }
        let output = VirtualRows(
            activityLines,
            64,
            (line ActivityLine) -> line.Index.ToString(),
            (line ActivityLine) -> Container{
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.FlexStart,
                Gap: 14,
                Padding: Edges{Left: 22, Right: 22, Top: 16, Bottom: 16},
                BorderWidth: Edges{Bottom: 1},
                BorderColor: Line(),
                MaterialIcons.Create("chevron_right", 18, Accent()),
                Text{
                    Content: line.Content,
                    FontFamily: "Newsreader",
                    FontSize: 18,
                    Color: Ink(),
                    FlexGrow: 1,
                    FlexBasis: 0,
                    MinWidth: 0,
                    Accessibility: Accessibility{Role: AccessibilityRole.Text, Name: "Command output"},
                },
            }
        )
        output.Handle = outputViewport
        output.Accessibility = Accessibility{Role: AccessibilityRole.Generic, Name: "Donation output"}
        output.FlexGrow = 1
        output.FlexBasis = 0
        output.MinHeight = 0
        output.Focusable = true
        output.OnKeyDown = event -> {
            if event.Key == Key.Home {
                followOutput = false
                outputViewport.JumpTo(0, 0)
                event.PreventDefault()
            } else if event.Key == Key.End {
                followOutput = true
                if activityLines.Count > 0 {
                    outputViewport.ScrollToItem(activityLines[activityLines.Count - 1].Index.ToString())
                }
                event.PreventDefault()
            }
        }
        let footer = Container{
            FlexDirection: FlexDirection.Row,
            FlexWrap: FlexWrap.Wrap,
            AlignItems: AlignItems.Center,
            Gap: 16,
            Padding: Edges{Left: 18, Right: 18, Top: 12, Bottom: 12},
            Label("Elapsed " + Elapsed(donationElapsed), 17, true),
            Container{FlexGrow: 1},
        }
        if donationRunning {
            if !followOutput {
                footer.Children.Add(
                    Action(
                        "Follow live",
                        () -> {
                            followOutput = true
                            if activityLines.Count > 0 {
                                outputViewport.ScrollToItem(activityLines[activityLines.Count - 1].Index.ToString())
                            }
                        },
                        allowWhileBusy: true
                    )
                )
            }
            footer.Children.Add(CancelCommand())
        } else {
            footer.Children.Add(
                Action(
                    "New donation",
                    () -> {
                        step = 0
                        donationStarted = false
                        message = ""
                        report = ""
                    }
                )
            )
            footer.Children.Add(
                Action(
                    "View saved work",
                    () -> {
                        runDirectory = donationPath
                        Navigate("Saved work")
                        LoadRun()
                    }
                )
            )
        }
        body.Children.Add(
            Container{
                FlexGrow: 1,
                FlexBasis: 0,
                MinHeight: 0,
                Overflow: Overflow.Hidden,
                BackgroundColor: Surface(),
                BorderWidth: 1,
                BorderColor: Line(),
                BorderRadius: 5,
                Container{
                    Padding: Edges{Left: 18, Right: 18, Top: 14, Bottom: 14},
                    Accessibility: Accessibility{
                        Role: AccessibilityRole.Status,
                        Name: donationState,
                        Busy: donationRunning
                    },
                    Row(
                        []Blob{
                            MaterialIcons.Create(donationRunning ? "auto_awesome": "task_alt", 24, Accent()),
                            Heading(donationState, 28),
                        }
                    ),
                    Label("Coding: " + codingTime + "   /   Verification: " + verificationTime, 16, true),
                },
                Rule(),
                output,
                Rule(),
                footer,
            }
        )
        return body
    }
}

data struct ActivityLine {
    var Index int32
    var Content string
    var Theme float64
}

func Elapsed(seconds int32) string -> (seconds / 3600).ToString("00") + ":" + (seconds / 60 % 60).ToString("00") +
    ":" +
    (seconds % 60).ToString("00")

func ReadReservation(
    runner CommandRunner,
    window Window,
    run JsonElement,
    directory string,
    completed Action[bool, string]
) {
    var ready = false
    var error = ""
    try {
        let path = Path.Combine(directory, "run.json")
        if FileInfo(path).Length > 1048576 {
            throw Exception("Saved claim is too large.")
        }
        using let document = JsonDocument.Parse(File.ReadAllText(path))
        let request = TextOf(Field(document.RootElement, "claim_request"), "uuid")
        if !Guid.TryParse(request, out var uuid) {
            throw Exception("Saved claim identity is missing.")
        }
        let result = runner.Run(
            []string{"coordination", "--repo", TextOf(run, "repo"), "--issue", TextOf(run, "issue")}
        )
        if result.Error != "" || result.ExitCode != 0 {
            throw Exception("Approval check unavailable. Checking again shortly.")
        }
        let state = Field(result.Value, "data")
        let reservation = Field(state, "reservation")
        var expires int64
        ready = TextOf(state, "approval_id") == TextOf(run, "approval") && Field(
            state,
            "revoked"
        ).ValueKind == JsonValueKind.False &&
            TextOf(reservation, "lease") == request &&
            TextOf(reservation, "attempt") == request &&
            TextOf(reservation, "actor") == TextOf(run, "donor_id") &&
            TextOf(reservation, "status") == "active" &&
            Field(reservation, "expires").TryGetInt64(out expires) &&
            expires > DateTimeOffset
            .UtcNow
            .ToUnixTimeSeconds()
    } catch (failure Exception) {
        error = failure.Message
    }
    window.TryPost(() -> completed(ready, error))
}
