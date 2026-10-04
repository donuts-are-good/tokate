package Tokate

import System
import System.Diagnostics
import System.IO

internal class Recovery {
    shared {
        internal func Run(directory string, seconds int32) {
            using let lease = File.Open(
                Path.Combine(directory, ".lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            )
            let run = Data.Load(directory)
            if run.Number("version") != 1 {
                throw Exception(
                    "Version-1 recovery does not reinterpret version-2 contributions; request fresh owner approval"
                )
            }
            if File.Exists(Path.Combine(directory, "correction.json")) {
                throw Exception("Explicit corrections use recover --commit with their saved budget and provenance")
            }
            if !Eligible(run) {
                throw CliFailure(
                    "invalid_state",
                    "Recovery requires a completed agent turn with failed owner verification"
                )
            }
            let record = ContributionClaim.Recheck(run)
            if seconds > J.Number(J.Get(record, "policy"), "max_seconds") {
                throw Exception("Recovery budget exceeds owner limit")
            }
            let usage = Correction.Completed(directory, run)
            let checkout = Verification.Validate(Path.Combine(directory, "checkout"))
            let archive = Path.Combine(directory, "recovery-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(archive)
            File.Copy(Path.Combine(directory, "run.json"), Path.Combine(archive, "run.json"))
            File.Copy(Path.Combine(directory, "verification.json"), Path.Combine(archive, "verification.json"))
            let scratch = Path.Combine(checkout, ".tokate-scratch")
            if FileInfo(scratch).LinkTarget != nil {
                throw Exception("Legacy scratch must not be a symbolic link")
            }
            if Directory.Exists(scratch) {
                let exclude = Path.Combine(checkout, ".git/info/exclude")
                if Commands.Git(checkout, "ls-files", "--", ".tokate-scratch") != "" || !File.Exists(exclude) ||
                    !File
                    .ReadAllText(exclude).Contains("\n.tokate-scratch/\n") {
                    throw Exception("Refusing to move repository-owned scratch files")
                }
                Directory.Move(scratch, Path.Combine(archive, "legacy-scratch"))
            }
            run.Fields["recovered"] = true
            run.Fields["recovery_seconds"] = seconds
            let timer = Stopwatch.StartNew()
            try {
                Terminal.Step("Recovering with independent verification only. No inference will run.")
                Contribution.Finish(directory, run, record, usage, timer, seconds)
                run.Fields.Remove("error")
                run.Fields.Remove("failure_reason")
                run.Save(directory)
            } catch (error Exception) {
                run.Fields["state"] = "failed"
                run.Fields["error"] = error.Message
                run.Save(directory)
                throw error
            }
        }

        internal func Eligible(run Data) bool -> run.Number("version") == 1 && run.Text("state") == "failed" &&
            (
            run.Text("failure_reason") == "verification_failed" ||
                (
                run.Text("failure_reason") == "" && run.Text(
                    "error"
                ) == "Owner verification failed. See verification.json. No PR will be opened."
            )
        )
    }
}
