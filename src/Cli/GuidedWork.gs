package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class GuidedWork {
    shared {
        private func Answer(prompt string, fallback string = "") string {
            Terminal.Message(prompt + (fallback == "" ? "": " [" + fallback + "]"), "default", true)
            Console.Error.Write("> ")
            let value = Console.ReadLine()?.Trim()
            if value == nil || value == "exit" || (value == "" && fallback == "") {
                throw Exception("Cancelled. No contribution was started.")
            }
            return value == "" ? fallback: value
        }

        private func Task(args Args) {
            let options = Args([]string{"status", "--repo", args.Need("repo")})
            Cli.Validate(options)
            Startup.Check(options)
            let snapshot = ContributionStatus.Snapshot(options)
            let value = J.Parse(J.Write(snapshot.Result))
            if let failure = snapshot.Failure {
                throw failure
            }
            let choices = HashSet[string](StringComparer.Ordinal)
            for row in J.Items(J.Get(value, "work")) {
                let state = J.Text(row, "state")
                if J.Text(row, "eligibility_status") == "eligible" &&
                    (state == "reservation_needed" || state == "donor_work" || state == "lease_expired_or_released") {
                    let issue = J.Number(row, "issue").ToString()
                    choices.Add(issue)
                    Terminal.Message("#" + issue + " " + J.Text(row, "title"), "default", true)
                }
            }
            if choices.Count == 0 {
                Terminal.ContributionStatus(value)
                throw Exception(
                    "No available approved issues were found for this account. Inspect status or request owner access."
                )
            }
            if J.Bool(value, "truncated") {
                Terminal.Message(
                    "This list is bounded. Use an issue URL to select work not shown here.",
                    "yellow",
                    true
                )
            }
            while true {
                let choice = Answer("Issue number (blank cancels)").TrimStart('#')
                if choices.Contains(choice) {
                    args.Values["--issue"] = choice
                    return
                }
                Terminal.Message("Choose one of the listed issue numbers.", "yellow", true)
            }
        }

        private func Eligible(value JsonElement, policy Policy) bool ->
        DonorSelection.Supported(value) && policy.Allows(J.Text(value, "model"), J.Text(value, "effort")) &&
            (
            J.Number(policy.Value, "version") == 1 ? J.Text(value, "harness") == "codex":
            policy.AllowsTool(J.Text(value, "harness"), J.Text(value, "provider"))
        )

        private func Profile(args Args) {
            if args.Get("profile") != "" || args.Get("harness") != "" || args.Get("provider") != "" || args.Get(
                "model"
            ) != "" {
                return
            }
            let saved = DonorDefaults.Run(Args([]string{"defaults", "list"}))
            let repo = args.Need("repo")
            let info = GitHub.Api("repos/" + repo)
            let policy = Policy.Load(repo, J.Text(info, "default_branch"))
            if Eligible(J.Get(saved, "default"), policy) {
                return
            }
            let profiles = J.Get(saved, "profiles")
            let names = HashSet[string](StringComparer.Ordinal)
            for entry in profiles.EnumerateObject() {
                if !Eligible(entry.Value, policy) {
                    continue
                }
                let harness = J.Text(entry.Value, "harness")
                names.Add(entry.Name)
                Terminal.Message(
                    entry.Name + ": " + harness + " / " + J.Text(entry.Value, "provider") + " / " + J.Text(
                        entry.Value,
                        "model"
                    ) +
                        " / " +
                        J.Text(entry.Value, "effort") +
                        (harness == "pi" ? " (Local)": " (Subscription)") +
                        "; availability unknown",
                    "default",
                    true
                )
            }
            if names.Count > 0 {
                let name = Answer("Profile name (blank cancels)")
                if !names.Contains(name) {
                    throw Exception("Choose a listed donor profile. No contribution was started.")
                }
                args.Values["--profile"] = name
            } else {
                let harness = Answer("Tool: codex (Subscription) or pi (Local), blank cancels").ToLowerInvariant()
                if harness != "codex" && harness != "pi" {
                    throw Exception("Choose codex or pi. No contribution was started.")
                }
                args.Values["--harness"] = harness
                DonorDefaults.NormalizePair(args)
                if harness == "pi" {
                    args.Values["--model"] = Answer("Exact model ID configured in Pi")
                    args.Values["--effort"] = "absent"
                    args.Values["--endpoint"] = Answer("Existing no-auth loopback endpoint URL")
                }
            }
            args.Guided = true
        }

        internal func Fill(args Args) {
            if args.Help || !DonorSelection.Interactive(args) || args.Get("run") != "" || args.Get(
                "continue-from"
            ) != "" ||
                (args.Command != "work" && args.Command != "claim") {
                return
            }
            if args.Get("repo") == "" {
                let repo = Interactive.Repository()
                if repo == "" {
                    throw Exception("Cancelled. No contribution was started.")
                }
                args.Values["--repo"] = repo
                args.Guided = true
            }
            if args.Get("issue") == "" {
                Task(args)
                args.Guided = true
            }
            Profile(args)
            if args.Get("seconds") == "" {
                args.Values["--seconds"] = Answer("Total budget in seconds for coding and verification (blank cancels)")
                args.Number("seconds")
                if args.Get("verification-reserve") == "" {
                    let reserve = Answer("Seconds reserved for verification; 0 keeps the whole budget shared", "0")
                    if reserve != "0" {
                        args.Values["--verification-reserve"] = reserve
                        RuntimeBudget.Reserve(args, args.Number("seconds"))
                    }
                }
                args.Guided = true
            }
            if args.Guided && args.Get("allow-network") == "" {
                let network = Answer("Allow project commands to access the network if the owner permits it? y/N", "n")
                if String.Equals(network, "y", StringComparison.OrdinalIgnoreCase) {
                    args.Values["--allow-network"] = "true"
                } else if !String.Equals(network, "n", StringComparison.OrdinalIgnoreCase) {
                    throw Exception("Choose y or n. No contribution was started.")
                }
            }
        }
    }
}
