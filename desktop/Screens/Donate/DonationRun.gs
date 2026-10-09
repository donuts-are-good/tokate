package TokateDesktop

import Goo
import System
import System.Text.Json

partial class DonationScreen {
    func OpenDonation(value JsonElement, directory string, navigate bool = true) {
        rememberRun(directory)
        approvalTimer?.Dispose()
        approvalRunner?.Stop()
        approvalRunner = nil
        donation = value
        donationPath = directory
        donationReady = TextOf(value, "state") == "claimed"
        donationStarted = false
        donationOutput = ""
        donationElapsed = 0
        donationState = donationReady ? "Ready to start": "Waiting for approval"
        if navigate {
            app.Navigate("Donate")
        }
        step = 3
        app.Report = ""
        app.Message = ""
        if TextOf(value, "state") == "claim_pending" {
            approvalTimer = app.Window?.SetInterval(() -> CheckDonationApproval(), 5000)
            CheckDonationApproval()
        }
    }

    private func CheckDonationApproval() {
        if app.Busy || app.Page != "Donate" || donationReady || donationStarted || approvalRunner != nil {
            return
        }
        let next = CommandClient()
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
            app.Refresh()
        }
        go ReadReservation(
            next,
            donation,
            directory,
            (ready bool, error string) -> app.Post(() -> callback(ready, error))
        )
    }

    func StartDonation() {
        if !donationReady || app.Busy {
            return
        }
        let value = donation
        let directory = donationPath
        let unbounded = Field(value, "unlimited").ValueKind == JsonValueKind.True
        let tools = Items(Field(value, "tools"))
        let tool = tools.Count > 0 ? TextOf(tools[0], "harness"): TextOf(value, "harness")
        app.Confirm(
            "Start donation?",
            "",
            () -> {
                donationStarted = true
                donationRunning = true
                donationReady = false
                donationState = "Donation running"
                outputRange = 0
                outputOffset = 0
                followOutput = true
                app.Execute(
                    []string{"work", "--run", directory, "--yes"},
                    result -> {
                        donationRunning = false
                        donationState = app.Stopping ? "Donation stopped": result.Error != "" ||
                            result.ExitCode != 0 ? "Donation needs attention": "Donation finished"
                        if result.Error != "" {
                            donationOutput += "\n" + result.Error
                            return
                        }
                        let updated = Field(result.Value, "data")
                        if TextOf(updated, "run") != "" {
                            donation = updated
                        }
                    },
                    seconds: unbounded ? 0: Math.Clamp(Number(value, "seconds") + 600, 600, 87000),
                    completeOnError: true,
                    progress: (seconds int32, output string) -> {
                        donationElapsed = seconds
                        donationOutput = output
                    }
                )
            },
            label: "Start this donation",
            content: () -> Container{
                Gap: 16,
                ui.Heading(TextOf(value, "repo") + " #" + TextOf(value, "issue"), 25),
                ui.Row(
                    []Blob{
                        ui.SummaryTile(
                            "Coding",
                            unbounded ? "Unlimited": (Number(value, "coding_seconds") / 60).ToString() + " minutes",
                            "schedule"
                        ),
                        ui.SummaryTile(
                            "Verification",
                            (Number(value, "verification_reserve") / 60).ToString() + " minutes",
                            "verified"
                        ),
                    }
                ),
                ui.ReviewDetail(
                    "Model",
                    (tool == "" ? "": tool + " / ") + TextOf(value, "model") + " / " + TextOf(value, "effort")
                ),
                ui.ReviewDetail(
                    "Network",
                    Field(value, "network").ValueKind == JsonValueKind.True ? "Allowed": "Offline"
                ),
            }
        )
    }
}

func Elapsed(seconds int32) string -> (seconds / 3600).ToString("00") + ":" + (seconds / 60 % 60).ToString("00") +
    ":" +
    (seconds % 60).ToString("00")
