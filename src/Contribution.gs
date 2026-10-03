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
            let checkout = Verification.Candidate(Path.Combine(directory, "checkout"))
            if Commands.Git(checkout, "status", "--porcelain") == "" {
                throw Exception("No changes returned. No PR will be opened.")
            }
            let candidate = Snapshot(checkout, run, J.Get(record, "approval"))
            let candidatePath = Path.Combine(directory, "candidate.patch")
            if File.Exists(candidatePath) && File.ReadAllText(candidatePath) != candidate {
                throw Exception("Saved candidate patch changed")
            }
            File.WriteAllText(candidatePath, candidate)
            Terminal.Step("Running independent owner verification...")
            let verification = List[Object]()
            for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                let remaining = seconds - Convert.ToInt32(timer.Elapsed.TotalSeconds)
                if remaining < 1 {
                    throw Exception("Runtime budget exhausted before verification")
                }
                let verifyArgs = List[string]()
                for word in J.Items(command) {
                    verifyArgs.Add(word.GetString() ?? "")
                }
                let check = Verification.Run(
                    checkout,
                    verifyArgs.ToArray(),
                    run.Flag("network") && J.Bool(J.Get(record, "policy"), "allow_network"),
                    remaining
                )
                verification.Add(
                    J.Map("command", command, "exit_code", check.Code, "output", check.Output, "error", check.Error)
                )
                File.WriteAllText(Path.Combine(directory, "verification.json"), J.Write(verification))
                if check.Code != 0 {
                    throw Exception("Owner verification failed. See verification.json. No PR will be opened.")
                }
            }
            run.Fields["verification"] = verification
            let patch = Snapshot(checkout, run, J.Get(record, "approval"))
            if patch != candidate {
                throw Exception("Verification changed the saved patch")
            }
            File.WriteAllText(Path.Combine(directory, "changes.patch"), patch + "\n")
            run.Fields["usage"] = usage
            run.Fields["elapsed_seconds"] = Convert.ToInt32(timer.Elapsed.TotalSeconds)
            run.Fields["state"] = "generated"
            run.Save(directory)
        }

        private func Snapshot(checkout string, run Data, approval JsonElement) string {
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
            for file in Commands.Git(
                checkout,
                "diff",
                "--cached",
                "--no-renames",
                "--name-only",
                "-z",
                run.Text("base")
            )
                .Split('\0') {
                if Decree.Protected(file, approval) {
                    throw Exception("Donor runs cannot change approved root DECREE.md")
                }
                if file.StartsWith(".github/workflows/") || file.StartsWith(".github/tokate") {
                    throw Exception("Donor runs cannot change owner policy, approval, templates, or CI workflows")
                }
            }
            return patch
        }
    }
}
