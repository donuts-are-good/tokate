package Tokate

import System
import System.ComponentModel
import System.IO
import System.Text
import System.Text.RegularExpressions

internal class CliOption {
    internal let Name string
    internal let Value string
    internal let Description string
    internal let Choices string
    internal init(name string, value string, description string, choices string = "") {
        Name = name
        Value = value
        Description = description
        Choices = choices
    }

    internal func Describe(command string) string -> command == "amend" && Name == "seconds" ?
    "Separate positive verification budget; required, at most the owner limit": Description.Replace(
        "{{seconds}}",
        command == "recover" ? "300": "min(3600, owner limit)"
    )
}

internal class CliCommand {
    internal let Name string
    internal let Options string
    internal let Required string
    internal let Summary string
    internal let Usage string
    internal let Example string
    internal init(name string, options string, required string, summary string, usage string, example string) {
        Name = name
        Options = options
        Required = required
        Summary = summary
        Usage = usage
        Example = example
    }

    internal func Has(name string) bool -> ("," + Options + ",help,traffic,").Contains("," + name + ",")

    internal func Needs(name string) bool -> ("," + Required + ",").Contains("," + name + ",")
}

internal class Cli {
    shared {
        internal let Options[]CliOption = []CliOption{
            CliOption("repo", "OWNER/REPO", "Repository; default: issue URL or unique local GitHub remote"),
            CliOption("issue", "N|URL", "Issue number or GitHub issue URL"),
            CliOption("donor", "LOGIN", "Donor login; @me uses your signed-in account"),
            CliOption("model", "MODEL", "Owner-approved model"),
            CliOption("effort", "EFFORT", "Owner-approved effort", "minimal low medium high xhigh max ultra"),
            CliOption("harness", "HARNESS", "Explicit harness; managed execution supports codex"),
            CliOption("provider", "PROVIDER", "Explicit provider; managed execution supports openai"),
            CliOption(
                "availability",
                "STATUS",
                "Donor report for the candidate model; never an account probe",
                "unknown available unavailable"
            ),
            CliOption("non-interactive", "", "Never prompt; require an eligible default or explicit choice"),
            CliOption("yes", "", "Confirm inference with the selected pair; never accept a substitute"),
            CliOption("seconds", "N", "Budget in seconds, 1..86400; default: {{seconds}}"),
            CliOption("fork", "LOGIN/REPO", "Donor fork; default: your login/upstream name"),
            CliOption("runs", "DIR", "Run storage; default: ~/.local/state/tokate/runs"),
            CliOption("run", "DIR", "Saved run directory"),
            CliOption("allow-network", "", "Allow network if owner permits; default: off"),
            CliOption("path", "DIR", "Repository directory; default: current directory"),
            CliOption("pr", "N", "Positive pull request number"),
            CliOption("watch", "", "Wait for checks; default: off"),
            CliOption("timeout", "N", "Check wait limit, 1..86400 seconds; default: 1200"),
            CliOption("state", "SHA", "Exact coordination-state commit"),
            CliOption("source", "SOURCE", "Coding source", "external tokate"),
            CliOption("tools", "FILE", "Nonsecret JSON tool declarations"),
            CliOption("file", "FILE", "Strict claim or publication request JSON"),
            CliOption("event", "FILE", "Trusted issue_comment event JSON"),
            CliOption("output", "FILE", "New workflow file outside .github"),
            CliOption("commit", "SHA", "Exact candidate commit to verify"),
            CliOption("prepare", "", "Archive original completed work before correction; no checks or publication"),
            CliOption("help", "", "Show help (-h); no tools, network or inference"),
            CliOption("traffic", "", "Print Tokate API counts on stderr; default: off"),
        }
        internal let Commands[]CliCommand = []CliCommand{
            CliCommand("doctor", "", "", "Check tools and sandbox locally; no inference.", "", "doctor"),
            CliCommand("update", "", "", "Download and install latest stable Tokate; no inference.", "", "update"),
            CliCommand("uninstall", "", "", "Remove managed installation offline; keep saved runs.", "", "uninstall"),
            CliCommand(
                "defaults",
                "harness,provider,model,effort",
                "",
                "Set, read or remove donor-entered Tokate defaults locally; no discovery or inference.",
                "set --harness HARNESS --provider PROVIDER --model MODEL --effort EFFORT\n       tokate defaults read|remove",
                "defaults set --harness codex --provider openai --model gpt-6.1-sol --effort high"
            ),
            CliCommand(
                "select",
                "repo,harness,provider,model,effort,availability,non-interactive",
                "repo",
                "Select under current owner policy and offline harness capabilities; no inference or reservation.",
                "[--repo OWNER/REPO] [--model MODEL --effort EFFORT] [options]",
                "select --repo owner/project --non-interactive"
            ),
            CliCommand(
                "init",
                "path",
                "",
                "Create local policy and PR template; no inference or publication.",
                "[--path DIR]",
                "init --path ."
            ),
            CliCommand(
                "coordinator-setup",
                "repo,output",
                "repo,output",
                "Download verified release assets and write a v2 workflow; no inference.",
                "[--repo OWNER/REPO] --output FILE",
                "coordinator-setup --repo owner/project --output coordinator.yml"
            ),
            CliCommand(
                "coordination",
                "repo,issue",
                "repo,issue",
                "Read authoritative v2 issue state from GitHub; no inference or publication.",
                "[--repo OWNER/REPO] --issue N|URL",
                "coordination https://github.com/owner/project/issues/42"
            ),
            CliCommand(
                "request",
                "repo,issue,file",
                "repo,issue,file",
                "Post a v2 claim or publication request to GitHub; no inference.",
                "[--repo OWNER/REPO] --issue N|URL --file FILE",
                "request --repo owner/project --issue 42 --file request.json"
            ),
            CliCommand(
                "prepare",
                "repo,issue,state,source,tools,harness,provider,model,effort,availability,non-interactive,fork,seconds,allow-network,runs",
                "repo,issue,state,source",
                "Save a v2 run for an existing reservation; no inference or publication.",
                "[--repo OWNER/REPO] --issue N|URL --state SHA\n       --source external --tools FILE [options]\n       tokate prepare --issue N --state SHA --source tokate [selection options]",
                "prepare --issue 42 --state SHA --source external --tools tools.json"
            ),
            CliCommand(
                "external",
                "run,commit",
                "run,commit",
                "Fetch and verify an exact external commit in isolation; no inference or publication.",
                "--run DIR --commit SHA",
                "external --run /path/to/run --commit SHA"
            ),
            CliCommand(
                "amend",
                "run,commit,seconds,tools",
                "run,commit,seconds",
                "Verify and publish a same-donor review correction; no inference.",
                "--run DIR --commit SHA --seconds N [--tools FILE]",
                "amend --run /path/to/run --commit SHA --seconds 300"
            ),
            CliCommand(
                "submit",
                "run",
                "run",
                "Push Tokate-coded work and request a coordinated v2 draft PR; no inference.",
                "--run DIR",
                "submit --run /path/to/run"
            ),
            CliCommand(
                "coordinate",
                "repo,event",
                "repo,event",
                "Trusted owner workflow: update v2 state and publish approved requests; no inference.",
                "--repo OWNER/REPO --event FILE",
                "coordinate --repo owner/project --event event.json"
            ),
            CliCommand(
                "policy",
                "repo",
                "repo",
                "Read upstream owner policy from GitHub; no inference.",
                "[--repo OWNER/REPO]",
                "policy --repo owner/project"
            ),
            CliCommand(
                "approve",
                "repo,issue,donor",
                "repo,issue,donor",
                "Write GitHub approval, assignment and label; no inference.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO] --donor LOGIN",
                "approve https://github.com/owner/project/issues/42 --donor donor"
            ),
            CliCommand(
                "assign",
                "repo,issue,donor",
                "repo,issue,donor",
                "Replace approval and donor on an approved issue on GitHub; no inference.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO] --donor LOGIN",
                "assign --repo owner/project --issue 42 --donor donor"
            ),
            CliCommand(
                "revoke",
                "repo,issue",
                "repo,issue",
                "Remove GitHub approval; blocks publication, not active computation.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]",
                "revoke https://github.com/owner/project/issues/42"
            ),
            CliCommand(
                "claim",
                "repo,issue,harness,provider,model,effort,availability,non-interactive,seconds,fork,runs,allow-network",
                "repo,issue",
                "Reserve a v1 GitHub branch and save a claim; no inference or PR publication.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]\n       [--model MODEL --effort EFFORT] [options]",
                "claim https://github.com/owner/project/issues/42 --model gpt-6.1-sol --effort high"
            ),
            CliCommand(
                "work",
                "repo,issue,harness,provider,model,effort,availability,non-interactive,yes,seconds,fork,runs,allow-network,run",
                "repo,issue",
                "Run inference with your Codex allowance and verify.\nV1: publish a draft PR. V2: save a commit, then use submit.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]\n       [--model MODEL --effort EFFORT] [--yes] [options]\n       tokate work --run DIR [--yes] [--non-interactive]",
                "work --repo owner/project --issue 42 --model MODEL --effort high"
            ),
            CliCommand(
                "recover",
                "run,seconds,prepare,commit,tools",
                "run",
                "Recover completed work without inference. Explicit corrections require preparation and a separate budget.",
                "--run DIR [--seconds N]\n       tokate recover --run DIR --prepare\n       tokate recover --run DIR --commit SHA --seconds N [--tools FILE]",
                "recover --run /path/to/run --seconds 300"
            ),
            CliCommand(
                "publish",
                "run",
                "run",
                "Push and publish a v1 draft PR from a successful run; no inference.",
                "--run DIR",
                "publish --run /path/to/run"
            ),
            CliCommand(
                "status",
                "run",
                "run",
                "Read saved run locally; no inference or publication.",
                "--run DIR",
                "status --run /path/to/run"
            ),
            CliCommand(
                "verify-pr",
                "repo,pr",
                "repo,pr",
                "Read GitHub approval and PR receipt; no inference or publication.",
                "[--repo OWNER/REPO] --pr N",
                "verify-pr --repo owner/project --pr 10"
            ),
            CliCommand(
                "checks",
                "run,repo,pr,watch,timeout",
                "repo,pr",
                "Read GitHub PR checks; --run also saves results locally. Exit: 0 passed, 8 pending, 1 failed.",
                "[--repo OWNER/REPO] --pr N [--watch] [--timeout N]\n       tokate checks --run DIR [--watch] [--timeout N]",
                "checks --run /path/to/run --watch"
            ),
            CliCommand(
                "completion",
                "",
                "",
                "Print Bash, Zsh or Fish completion locally; no tool checks or inference.",
                "bash|zsh|fish",
                "completion bash"
            ),
            CliCommand("help", "", "", "Show global or focused command help locally.", "[COMMAND]", "help work"),
            CliCommand("--version", "", "", "Print installed version locally.", "", "--version"),
        }

        internal func Find(name string) CliCommand {
            for command in Commands {
                if command.Name == name {
                    return command
                }
            }
            throw Exception("Unknown command: " + name + ". Run tokate --help")
        }

        internal func OptionFor(command string, name string) CliOption {
            for option in Options {
                if option.Name == name && Find(command).Has(name) {
                    return option
                }
            }
            throw Exception("Unknown option for " + command + ": --" + name)
        }

        internal func Usage(name string) string {
            let command = Find(name)
            return "Usage: tokate " + name + (command.Usage == "" ? "": " " + command.Usage)
        }

        internal func ErrorUsage(args[]string) string {
            var name = args.Length == 0 ? "help": args[0]
            if name == "help" && args.Length > 1 && !args[1].StartsWith("-") {
                name = args[1]
            }
            for command in Commands {
                if command.Name == name {
                    return Usage(name) + "\nRun tokate " + name + " --help for options."
                }
            }
            return "Usage: tokate <command> [options]\nRun tokate --help for commands."
        }

        private func OptionHelp(text StringBuilder, label string, description string) {
            text.AppendLine("  " + label)
            var line = "    "
            for word in description.Split(' ', StringSplitOptions.RemoveEmptyEntries) {
                if line.Length > 4 && line.Length + word.Length + 1 > 78 {
                    text.AppendLine(line)
                    line = "    "
                }
                line += (line.Length == 4 ? "": " ") + word
            }
            text.AppendLine(line)
            text.AppendLine()
        }

        internal func Help(name string = "") string {
            let text = StringBuilder()
            if name == "" {
                text.AppendLine("Tokate " + Data.Version() + " (toh-KAH-teh)")
                text.AppendLine("Donate AI usage to approved GitHub issues.\n\nUsage: tokate <command> [options]\n")
                for command in Commands {
                    text.AppendLine("  " + command.Name.PadRight(18) + command.Summary.Replace("\n", " "))
                }
                text.AppendLine("\nUse tokate <command> --help, tokate help <command>, or -h for details.")
                text.AppendLine(
                    "Value options accept --name=value. Issue URLs and unique local GitHub remotes supply --repo."
                )
                text.AppendLine(
                    "Explicit --repo OWNER/REPO and --issue N remain available. PRs are drafts; owners review and merge."
                )
            } else {
                let command = Find(name)
                text.AppendLine(Usage(name))
                text.AppendLine(command.Summary + "\n")
                for option in Options {
                    if !command.Has(option.Name) {
                        continue
                    }
                    let required = command.Needs(option.Name) && option.Name != "repo" ? " (required)": ""
                    OptionHelp(
                        text,
                        "--" + option.Name + (option.Value == "" ? "": " " + option.Value) + required,
                        option.Describe(name) + (option.Choices == "" ? "": " (" + option.Choices + ")")
                    )
                }
                if command.Has("issue") {
                    text.AppendLine("An issue URL can replace --repo and --issue.")
                }
                if name == "work" || name == "checks" {
                    text.AppendLine(
                        name == "work" ? "For a saved claim, use --run DIR instead of required inputs.":
                        "Use --run DIR instead of --repo/--pr to check a saved run."
                    )
                }
                text.AppendLine("\nExample:\n  tokate " + command.Example)
            }
            return text.ToString().TrimEnd()
        }

        internal func Validate(args Args) {
            let command = Find(args.Command)
            if args.Command == "recover" {
                if args.Get("prepare") == "true" &&
                    (args.Get("commit") != "" || args.Get("seconds") != "" || args.Get("tools") != "") {
                    throw Exception("--prepare excludes --commit, --seconds and --tools")
                }
                if args.Get("commit") != "" && !args.Help {
                    args.Need("seconds")
                }
                if args.Get("tools") != "" && args.Get("commit") == "" {
                    throw Exception("--tools requires an explicit corrected --commit")
                }
            }
            if args.Get("run") != "" && (args.Command == "work" || args.Command == "checks") {
                for key in args.Values.Keys {
                    if key != "--run" &&
                        key != "--help" &&
                        key != "--traffic" &&
                        !(args.Command == "work" && (key == "--yes" || key == "--non-interactive")) &&
                        !(args.Command == "checks" && (key == "--watch" || key == "--timeout")) {
                        throw Exception("--run conflicts with " + key)
                    }
                }
                if args.IssueUrl != "" {
                    throw Exception("--run conflicts with an issue URL")
                }
            }
            for key in[]string{"seconds", "timeout", "pr"} {
                if args.Get(key) != "" {
                    args.Number(key)
                }
            }
            for key in[]string{"repo", "fork"} {
                if args.Get(key) != "" {
                    args.Values["--" + key] = RepositoryInput.Repo(args.Get(key))
                }
            }
            for key in[]string{"path", "run", "runs", "file", "tools", "event", "output"} {
                if args.Get(key) != "" {
                    Path.GetFullPath(args.Get(key))
                }
            }
            if args.Get("donor") != "" && args.Get("donor") != "@me" {
                Data.Login(args.Get("donor"))
            }
            if args.Get("model") != "" && !Regex.IsMatch(args.Get("model"), "^[A-Za-z0-9][A-Za-z0-9._-]*$") {
                throw Exception("Invalid model name: --model")
            }
            for key in[]string{"harness", "provider"} {
                if args.Get(key) != "" && !Regex.IsMatch(args.Get(key), "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
                    throw Exception("Invalid identifier: --" + key)
                }
            }
            for key in[]string{"effort", "source", "availability"} {
                if args.Get(key) != "" && Array.IndexOf(
                    OptionFor(args.Command, key).Choices.Split(' '),
                    args.Get(key)
                ) < 0 {
                    throw Exception("Invalid value for --" + key)
                }
            }
            for key in[]string{"state", "commit"} {
                if args.Get(key) != "" {
                    Data.CommitSha(args.Get(key))
                }
            }
            RepositoryInput.Issue(args)
            if args.Command == "completion" &&
                args.Subject != "bash" &&
                args.Subject != "zsh" &&
                args.Subject != "fish" &&
                (args.Subject != "" || !args.Help) {
                throw Exception("Required shell: bash, zsh or fish")
            }
            if args.Help {
                return
            }
            if args.Command == "defaults" {
                if args.Subject != "set" && args.Subject != "read" && args.Subject != "remove" {
                    throw Exception("Required defaults operation: set, read or remove")
                }
                for key in[]string{"harness", "provider", "model", "effort"} {
                    if args.Subject == "set" {
                        args.Need(key)
                    } else if args.Get(key) != "" {
                        throw Exception("defaults " + args.Subject + " does not take --" + key)
                    }
                }
            }
            if args.Command == "prepare" && args.Get("source") == "external" {
                args.Need("tools")
                for key in[]string{"harness", "provider", "model", "effort", "availability", "non-interactive"} {
                    if args.Get(key) != "" {
                        throw Exception("External declarations use --tools; selection option conflicts: --" + key)
                    }
                }
            }
            if args.Get("run") != "" && (args.Command == "work" || args.Command == "checks") {
                return
            }
            for option in Options {
                if command.Needs(option.Name) && option.Name != "repo" {
                    args.Need(option.Name)
                }
            }
            if command.Needs("repo") && args.Get("repo") == "" {
                args.Values["--repo"] = RepositoryInput.Local()
            }
        }
    }
}

internal class RepositoryInput {
    shared {
        internal func Repo(value string) string {
            var normalized = value
            if value.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase) {
                let uri = Uri(value)
                if uri.Query != "" || uri.Fragment != "" {
                    throw Exception("Use a GitHub repository URL without query or fragment")
                }
                normalized = uri.AbsolutePath.Trim('/')
                if normalized.EndsWith(".git") {
                    normalized = normalized.Substring(0, normalized.Length - 4)
                }
            }
            return Data.Repo(normalized)
        }

        internal func ApplyIssue(args Args, value string) {
            let uri = Uri(value)
            let match = Regex.Match(
                uri.AbsolutePath,
                "^/([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*)/issues/([0-9]+)/?$"
            )
            if uri.Scheme != "https" || !String.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase) ||
                !uri.IsDefaultPort ||
                uri.UserInfo != "" ||
                !match.Success {
                throw Exception("Use a GitHub issue URL: https://github.com/OWNER/REPO/issues/N")
            }
            let repo = Data.Repo(match.Groups[1].Value)
            let number = match.Groups[2].Value
            var parsed int32
            if !int32.TryParse(number, out parsed) || parsed < 1 {
                throw Exception("Invalid positive number in issue URL")
            }
            if args.Get("repo") != "" && !String.Equals(args.Get("repo"), repo, StringComparison.OrdinalIgnoreCase) {
                throw Exception("Issue URL conflicts with --repo")
            }
            if args.Get("issue") != "" && args.Number("issue") != parsed {
                throw Exception("Issue URL conflicts with --issue")
            }
            args.Values["--repo"] = repo
            args.Values["--issue"] = number
            args.Number("issue")
        }

        internal func Issue(args Args) {
            let issue = args.Get("issue")
            if issue.Contains("://") {
                args.Values.Remove("--issue")
                ApplyIssue(args, issue)
            } else if issue != "" {
                args.Number("issue")
            }
            if args.IssueUrl != "" {
                ApplyIssue(args, args.IssueUrl)
            }
        }

        internal func Local() string {
            var result CommandResult
            try {
                result = Commands.Run(
                    "git",
                    []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "remote", "-v"},
                    seconds: 5
                )
            } catch (error Win32Exception) {
                throw Exception("Local Git is unavailable; use --repo OWNER/REPO")
            }
            if result.Code != 0 {
                throw Exception("Cannot determine a local repository; use --repo OWNER/REPO")
            }
            var repo string = ""
            for line in result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries) {
                let fields = line.Split([]char{' ', '\t'}, StringSplitOptions.RemoveEmptyEntries)
                let url = fields.Length >= 2 ? fields[1]: ""
                let match = Regex.Match(
                    url,
                    "^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\\.git)?/?$",
                    RegexOptions.IgnoreCase
                )
                if !match.Success {
                    throw Exception("Ambiguous or unsupported local remotes; use --repo OWNER/REPO")
                }
                let candidate = Data.Repo(match.Groups[1].Value)
                if repo != "" && !String.Equals(repo, candidate, StringComparison.OrdinalIgnoreCase) {
                    throw Exception("Ambiguous local remotes; use --repo OWNER/REPO")
                }
                repo = candidate
            }
            if repo == "" {
                throw Exception("No GitHub remote found; use --repo OWNER/REPO")
            }
            return repo
        }
    }
}
