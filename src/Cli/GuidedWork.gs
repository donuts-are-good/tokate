package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class GuidedWork {
    shared {
        internal func Repository(args Args) {
            var inferred = args.Get("repo")
            if inferred == "" {
                try {
                    inferred = RepositoryInput.Local()
                } catch (error Exception) { }
            }
            var note = "Paste a GitHub repository or issue link, or enter owner/repo."
            while true {
                let value = WizardScreen.Read(
                    "Choose a project",
                    note,
                    "Project",
                    inferred,
                    "A repository lists approved work. An issue link selects that task directly. You can correct the suggested repository."
                )
                if value == "" {
                    throw OperationCanceledException("Cancelled")
                }
                try {
                    let selected = Args([]string{args.Command, value})
                    RepositoryInput.Issue(selected)
                    args.Values["--repo"] = selected.Need("repo")
                    if selected.Get("issue") != "" {
                        args.Values["--issue"] = selected.Get("issue")
                    }
                    return
                } catch (error Exception) {
                    note = error.Message
                }
            }
        }

        private func Task(args Args) {
            Terminal.Step("Reading approved issues...")
            let repo = args.Need("repo")
            let issues = GitHub.Api(
                "repos/" +
                    repo +
                    "/issues?state=open&labels=tokate%3Aapproved&sort=updated&direction=desc&per_page=20&page=1"
            )
            if issues.ValueKind != JsonValueKind.Array || issues.GetArrayLength() > 20 {
                throw Exception("Cannot read approved issues")
            }
            let numbers = List[string]()
            let choices = List[string]()
            for task in J.Items(issues) {
                if J.Get(task, "pull_request").ValueKind != JsonValueKind.Undefined || J.Text(
                    task,
                    "state"
                ) != "open" ||
                    !GitHub.HasLabel(task) {
                    continue
                }
                numbers.Add(J.Number(task, "number").ToString())
                choices.Add("#" + numbers[numbers.Count - 1] + "  " + J.Text(task, "title"))
            }
            if choices.Count == 0 {
                throw Exception("No approved issues were found. The owner must approve a task before donation.")
            }
            let choice = WizardScreen.Choose(
                "Choose an issue",
                repo + "\nApproved tasks. Current access and availability are checked before a claim.",
                choices.ToArray(),
                "Choose an issue. For work outside this bounded list, return home and enter its issue link."
            )
            args.Values["--issue"] = numbers[choice - 1]
        }

        private func Eligible(value JsonElement, policy Policy) bool ->
        DonorSelection.Supported(value) && policy.Allows(J.Text(value, "model"), J.Text(value, "effort")) &&
            (
            J.Number(policy.Value, "version") == 1 ? J.Text(value, "harness") == "codex": policy.AllowsTool(
                J.Text(value, "harness"),
                J.Text(value, "provider")
            )
        )

        internal func Profile(args Args, policy Policy) {
            for key in[]string{"profile", "harness", "provider", "model", "effort", "endpoint", "pi-root", "node"} {
                args.Values.Remove("--" + key)
            }
            args.SavedDefaults = JsonElement{}
            let saved = DonorDefaults.Run(Args([]string{"defaults", "list"}))
            let names = List[string]()
            let labels = List[string]()
            let defaults = J.Get(saved, "default")
            if Eligible(defaults, policy) {
                names.Add("")
                labels.Add(Label(defaults, "Saved default"))
            }
            for entry in J.Get(saved, "profiles").EnumerateObject() {
                if Eligible(entry.Value, policy) {
                    names.Add(entry.Name)
                    labels.Add(Label(entry.Value, entry.Name))
                }
            }
            if labels.Count > 0 {
                labels.Add("Set up another coding tool")
                let selected = ModelChecklist.Pick(labels.ToArray())
                if selected < names.Count {
                    let value = DonorDefaults.Read(names[selected])
                    for field in value.EnumerateObject() {
                        if field.Name != "harness-path" || args.Get("harness-path") == "" {
                            args.Values["--" + field.Name] = field.Value.GetString() ?? ""
                        }
                    }
                    return
                }
            }
            let tools = List[string]()
            let routes = List[string]()
            if J.Number(policy.Value, "version") == 1 || policy.AllowsTool("codex", "openai") {
                tools.Add("Codex | Subscription")
                routes.Add("codex")
            }
            if J.Number(policy.Value, "version") == 2 && policy.AllowsTool("pi", "local-chat-completions") {
                tools.Add("Pi | Local")
                routes.Add("pi")
            }
            if tools.Count == 0 {
                throw Exception("The owner policy allows no supported managed coding tools")
            }
            let tool = WizardScreen.Choose(
                "Your coding tool",
                "Choose one permitted tool. Availability is checked before starting.",
                tools.ToArray()
            )
            args.Values["--harness"] = routes[tool - 1]
            DonorDefaults.NormalizePair(args)
            Startup.Check(args)
            if args.Need("harness") == "pi" {
                if args.Get("pi-root") == "" && args.Get("harness-path") == "" && LocalPaths.Harness("pi") == "" {
                    MachineSetup.Harness(args)
                }
                args.Values["--endpoint"] = WizardScreen.Read(
                    "Local model",
                    "Use your existing model server or local tunnel.",
                    "Endpoint URL",
                    "",
                    "No-auth loopback Chat Completions URL, including /v1. Tokate does not start a server."
                )
                args.Values["--model"] = WizardScreen.Read(
                    "Local model",
                    "Choose the exact model configured in Pi and advertised by your server.",
                    "Model ID"
                )
                PiHarness.Runtime(args)
                let settings = PiBoundary.ModelSettings(
                    args.Need("pi-root"),
                    args.Need("node"),
                    args.Need("model"),
                    PiBoundary.Endpoint(args.Need("endpoint"))
                )
                let efforts = List[string]()
                for level in J.Items(J.Get(settings, "efforts")) {
                    let effort = level.GetString() ?? ""
                    if policy.Allows(args.Need("model"), effort) {
                        efforts.Add(effort)
                    }
                }
                if efforts.Count == 0 {
                    throw Exception("The owner policy permits none of this Pi model's supported reasoning levels")
                }
                args.Values["--effort"] = efforts[
                    WizardScreen.Choose(
                        "Reasoning effort",
                        "Choose a level supported by Pi and permitted by the project.",
                        efforts.ToArray()
                    ) - 1
                ]
            } else {
                let models = List[string]()
                let efforts = List[string]()
                labels.Clear()
                for entry in CodexRuntime.Capabilities(args.Get("harness-path")) {
                    for effort in entry.Value {
                        if policy.Allows(entry.Key, effort) {
                            models.Add(entry.Key)
                            efforts.Add(effort)
                            labels.Add("OpenAI | Codex | Subscription | " + entry.Key + " / " + effort)
                        }
                    }
                }
                if labels.Count == 0 {
                    throw Exception("No permitted model and effort are advertised by the installed Codex")
                }
                let selected = ModelChecklist.Pick(labels.ToArray())
                args.Values["--model"] = models[selected]
                args.Values["--effort"] = efforts[selected]
            }
        }

        private func Label(value JsonElement, name string) string -> name + " | " + J.Text(value, "provider") +
            " / " +
            J.Text(value, "harness") +
            (J.Text(value, "harness") == "pi" ? " | Local | ": " | Subscription | ") +
            J.Text(value, "model") + " / " + J.Text(value, "effort") + " | availability unknown"

        internal func Budget(args Args, limit int32 = 86400, allowUnlimited bool = false) {
            if args.Get("unlimited") == "true" && !allowUnlimited {
                throw Exception("Repository policy does not allow unlimited coding")
            }
            while true {
                let answer = WizardScreen.Read(
                    "Set your limit",
                    allowUnlimited ? "Choose coding minutes, or type unlimited. Verification keeps a separate time limit.": "Choose your coding time in minutes. Verification has a separate reserve.",
                    allowUnlimited ? "Coding minutes or unlimited": "Coding minutes",
                    args.Get("unlimited") == "true" ? "unlimited": "30",
                    "This is a client time limit, not a token, billing or server-resource cap."
                )
                let unlimited = allowUnlimited && answer.Trim().Equals("unlimited", StringComparison.OrdinalIgnoreCase)
                var coding int32
                var reserve int32
                let verification = WizardScreen.Read(
                    "Verification time",
                    "Reserve time for the owner's independent checks after coding.",
                    "Verification minutes",
                    "30"
                )
                if int32.TryParse(verification, out reserve) &&
                    reserve > 0 &&
                    reserve <= 1440 &&
                    reserve * 60 <= limit &&
                    (
                    unlimited ||
                        (
                        int32.TryParse(answer, out coding) &&
                            coding > 0 &&
                            coding <= 1440 &&
                            (coding + reserve) * 60 <= limit
                    )
                ) {
                    if unlimited {
                        args.Values["--unlimited"] = "true"
                        args.Values.Remove("--seconds")
                    } else {
                        args.Values.Remove("--unlimited")
                        args.Values["--seconds"] = ((coding + reserve) * 60).ToString()
                    }
                    args.Values["--verification-reserve"] = (reserve * 60).ToString()
                    return
                }
                WizardScreen.Read(
                    "Time limit",
                    "Use positive whole minutes. The combined owner limit is " + limit.ToString() + " seconds.",
                    "Enter to try again"
                )
            }
        }

        private func Network(args Args, policy Policy) {
            args.Values.Remove("--allow-network")
            if !J.Bool(policy.Value, "allow_network") {
                return
            }
            if WizardScreen.Choose(
                "Project network",
                "Model connectivity is separate. Project commands may need network access to download build dependencies.",
                []string{"Keep project commands offline", "Allow project command network access"},
                selected: 1
            ) == 2 {
                args.Values["--allow-network"] = "true"
            }
        }

        internal func Fill(args Args) {
            if args.Help || !DonorSelection.Interactive(args) || args.Get("run") != "" || args.Get(
                "continue-from"
            ) != "" ||
                (args.Command != "work" && args.Command != "claim") {
                return
            }
            let guided = args.Get("repo") == "" || args.Get("issue") == "" ||
                (args.Get("seconds") == "" && args.Get("unlimited") != "true") ||
                (args.Get("unlimited") == "true" && args.Get("verification-reserve") == "") ||
                (args.Get("profile") == "" && args.Get("harness") == "" && args.Get("model") == "")
            if !guided {
                return
            }
            args.Guided = true
            if args.Get("repo") == "" {
                Repository(args)
            }
            Startup.Check(Args([]string{"status", "--repo", args.Need("repo")}))
            if args.Get("issue") == "" {
                Task(args)
            }
            let repo = args.Need("repo")
            let viewer = GitHub.Api("user")
            let donor = RepositoryIdentity.Login(J.Text(viewer, "login"))
            let info = GitHub.Api("repos/" + repo)
            let policy = Policy.Load(repo, J.Text(info, "default_branch"))
            if J.Number(policy.Value, "version") == 2 {
                CoordinationState.Load(repo, args.Number("issue")).Check(
                    repo,
                    args.Number("issue"),
                    donor,
                    J.Get(viewer, "id")
                )
            } else {
                OwnerApproval.Approved(repo, args.Number("issue"), donor)
            }
            let allowUnlimited = J.Number(policy.Value, "version") == 2 && J.Bool(policy.Value, "allow_unlimited")
            if (args.Get("seconds") == "" && args.Get("unlimited") != "true") ||
                (args.Get("unlimited") == "true" && args.Get("verification-reserve") == "") {
                Budget(args, J.Number(policy.Value, "max_seconds"), allowUnlimited)
            }
            if args.Get("profile") == "" && args.Get("harness") == "" && args.Get("model") == "" {
                Profile(args, policy)
            }
            if args.Get("allow-network") == "" {
                Network(args, policy)
            }
            DonorSelection.ApplyDefaults(args)
            while true {
                Terminal.Step("Checking the selected coding tool...")
                Startup.Check(args)
                let selection = DonorSelection.Resolve(args, policy)
                let reserve = RuntimeBudget.Reserve(args, RuntimeBudget.ReadSeconds(args))
                args.Values["--verification-reserve"] = reserve.ToString()
                let body = repo + " #" + args.Need("issue") + "\n\nTool     " + J.Text(selection, "harness") +
                    " / " +
                    J.Text(selection, "provider") + "\nModel    " + J.Text(selection, "model") + " / " + J.Text(
                    selection,
                    "effort"
                ) +
                    "\nCoding   " +
                    (
                    args.Get("unlimited") == "true" ? "No time limit": (
                        (RuntimeBudget.ReadSeconds(args) - reserve) / 60.0
                    ).ToString("0.##") + " minutes"
                ) +
                    "\nChecks   " +
                    (reserve / 60.0).ToString("0.##") +
                    " minutes reserved" +
                    "\nNetwork  " +
                    (args.Get("allow-network") == "true" ? "Project commands allowed": "Project commands offline") +
                    "\n\n" +
                    (
                    J.Text(
                        selection,
                        "harness"
                    ) == "pi" ? "Local inference uses your existing runtime and compute.": "Uses your Codex subscription. Extra-charge status is unknown."
                ) +
                    "\nAvailability: " +
                    J.Text(selection, "availability")
                let options = args.Command == "claim" ? []string{
                    "Reserve for later, without starting AI",
                    "Change tool or time limit",
                    "Change network permission"
                }:
                []string{
                    "Start donation",
                    "Change tool or time limit",
                    "Reserve for later, without starting AI",
                    "Change network permission"
                }
                let action = WizardScreen.Choose(
                    "Review donation",
                    body,
                    options,
                    "Starting rechecks authority, prepares your fork and runs the selected tool. Reserving spends no inference. You can return home without posting anything."
                )
                if action == 1 || (args.Command == "work" && action == 3) {
                    if action == 3 {
                        args.Command = "claim"
                    }
                    args.Values["--yes"] = "true"
                    return
                }
                if action == 2 {
                    let change = WizardScreen.Choose(
                        "Change donation",
                        "Only change what you need.",
                        []string{"Coding tool and model", "Time limit", "Back to review"}
                    )
                    if change == 1 {
                        Profile(args, policy)
                    }
                    if change == 2 {
                        Budget(args, J.Number(policy.Value, "max_seconds"), allowUnlimited)
                    }
                } else {
                    Network(args, policy)
                }
            }
        }
    }
}
