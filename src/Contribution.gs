package Tokate

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json

internal class Contribution {
    shared {
        internal func Finish(
            directory string,
            run Data,
            record JsonElement,
            usage Dictionary[string, Object?],
            timer Stopwatch,
            seconds int32
        ) {
            run.Fields["failure_stage"] = "candidate_validation"
            run.Fields["failure_reason"] = "candidate_invalid"
            let checkout = Verification.Candidate(Path.Combine(directory, "checkout"))
            if Commands.Git(checkout, "status", "--porcelain") == "" {
                throw Exception("No changes returned. No PR will be opened.")
            }
            let candidate = Snapshot(checkout, run)
            let candidatePath = Path.Combine(directory, "candidate.patch")
            if !File.Exists(candidatePath) {
                File.WriteAllText(candidatePath, candidate)
            }
            ProtectedPaths.Local(checkout, J.Get(record, "policy"), J.Get(record, "approval"), run.Text("base"))
            if File.ReadAllText(candidatePath) != candidate {
                throw Exception("Saved candidate patch changed")
            }
            Terminal.Step("Running independent owner verification...")
            PublicOutput.FailureCode = "verification_failed"
            run.Fields["failure_stage"] = "owner_verification"
            run.Fields["failure_reason"] = "verification_failed"
            let verification = List[Object]()
            run.Fields["verification"] = verification
            run.Save(directory)
            for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                if remaining < 1 {
                    throw Exception("Runtime budget exhausted before verification")
                }
                run.Fields["verification"] = verification
                run.Save(directory)
                let check = Verification.Check(
                    directory,
                    verification,
                    command,
                    checkout,
                    run.Flag("network") && J.Bool(J.Get(record, "policy"), "allow_network"),
                    remaining
                )
                if check.Code != 0 {
                    run.Fields["failure_reason"] = "verification_failed"
                    throw CliFailure(
                        "verification_failed",
                        "Owner verification failed. Inspect the private verification.json artifact before explicit recovery."
                    )
                }
            }
            run.Fields["verification"] = verification
            PublicOutput.FailureCode = "invalid_state"
            run.Fields["failure_stage"] = "changed_candidate"
            run.Fields["failure_reason"] = "candidate_changed"
            let patch = Snapshot(checkout, run)
            ProtectedPaths.Local(checkout, J.Get(record, "policy"), J.Get(record, "approval"), run.Text("base"))
            if patch != candidate {
                throw Exception("Verification changed the saved patch")
            }
            File.WriteAllText(Path.Combine(directory, "changes.patch"), patch + "\n")
            run.Fields["usage"] = usage
            run.Fields["elapsed_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
            run.Fields["state"] = "generated"
            run.Fields.Remove("failure_reason")
            run.Fields.Remove("failure_stage")
            run.Save(directory)
        }

        private func Snapshot(checkout string, run Data) string {
            Verification.Candidate(checkout)
            if Commands.Git(checkout, "rev-parse", "HEAD") != run.Text("base") {
                throw Exception("Agent changed Git history")
            }
            Commands.Git(checkout, "add", "-A")
            Commands.Git(checkout, "diff", "--cached", "--check")
            let patch = Commands.Git(checkout, "diff", "--cached", "--binary", run.Text("base"))
            if patch == "" {
                throw Exception("No changes returned. No PR will be opened.")
            }
            return patch
        }
    }
}
