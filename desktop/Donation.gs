package TokateDesktop

import Goo
import System
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

    private func OpenDonation(value JsonElement, directory string, navigate bool = true) {
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
        let description = TextOf(value, "repo") +
            " #" +
            TextOf(value, "issue") +
            (tool == "" ? "": "\nTool: " + tool) +
            "\nModel: " +
            TextOf(value, "model") +
            " / " +
            TextOf(value, "effort") +
            "\nCoding: " +
            (unbounded ? "Unlimited": (Number(value, "coding_seconds") / 60).ToString() + " minutes") +
            "\nVerification: " +
            (Number(value, "verification_reserve") / 60).ToString() +
            " minutes" +
            "\nProject network: " +
            (Field(value, "network").ValueKind == JsonValueKind.True ? "allowed": "offline")
        Confirm(
            "Start donation?",
            description,
            () -> {
                donationStarted = true
                donationRunning = true
                donationReady = false
                runActions.Clear()
                donationState = "Donation running"
                outputRange = 0
                outputOffset = 0
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
            }
        )
    }

    private func Donation() Blob {
        let numeral = Heading("IV")
        numeral.Color = Accent()
        numeral.Width = 54
        let body = Container{
            Height: Percent(100),
            MinHeight: 0,
            Gap: 18,
            Row([]Blob{numeral, Heading("Donation")}),
            Rule(),
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
            body.Children.Add(Label(donationState, 20, true))
            if message != "" {
                body.Children.Add(Label(message, 17, true))
            }
            body.Children.Add(Row([]Blob{Action("Start donation", () -> StartDonation(), true, !donationReady)}))
            if !busy && donationPath == "" {
                body.Children.Add(Row([]Blob{Action("Inspect saved work", () -> Navigate("Saved work"))}))
            }
            return body
        }
        let output = Container{
            Handle: outputViewport,
            Accessibility: Accessibility{Role: AccessibilityRole.Generic, Name: "Donation output"},
            FlexGrow: 1,
            FlexBasis: 0,
            MinHeight: 0,
            OverflowY: Overflow.Scroll,
            OverflowX: Overflow.Hidden,
            Padding: 18,
            Text{
                Content: donationOutput == "" ? "Starting donation...": donationOutput,
                FontFamily: "monospace",
                FontSize: 14,
                Color: Ink(),
                FlexShrink: 0,
                Accessibility: Accessibility{Role: AccessibilityRole.Text, Name: "Command output"},
            },
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
                    Label(donationState, 20),
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
