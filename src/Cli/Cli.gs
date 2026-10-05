package Tokate

import System
import System.Collections.Generic
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
    internal let Effects string
    internal init(
        name string,
        options string,
        required string,
        summary string,
        usage string,
        example string,
        effects string = "local_read"
    ) {
        Name = name
        Options = options
        Required = required
        Summary = summary
        Usage = usage
        Example = example
        Effects = effects
    }

    internal func Has(name string) bool -> ("," + Options + ",help,traffic,json,plain,ascii,").Contains(
        "," + name + ","
    )

    internal func Needs(name string) bool -> ("," + Required + ",").Contains("," + name + ",")

    internal func ConflictsWithRun(name string) bool -> name != "run" &&
        name != "help" &&
        name != "traffic" &&
        name != "json" &&
        name != "plain" &&
        name != "ascii" &&
        (
        (Name == "work" && name != "yes" && name != "non-interactive") ||
            (Name == "checks" && name != "watch" && name != "timeout") ||
            Name == "prepare"
    )
}

internal class Cli {
    shared {
        internal let Options[]CliOption = []CliOption{
            CliOption("owner", "", "Diagnose owner GitHub tooling without Codex or donor sandboxes"),
            CliOption("managed", "", "Diagnose managed Codex donor tools and sandbox; default scope"),
            CliOption("external", "", "Diagnose external donor tools and independent verification without Codex"),
            CliOption("auth", "", "Explicitly check tool-owned authentication status; never print credential values"),
            CliOption("repo", "OWNER/REPO", "Repository; default: issue URL or unique local GitHub remote"),
            CliOption("issue", "N|URL", "Issue number or GitHub issue URL"),
            CliOption("operation", "ACTION", "Access operation", "init trust untrust grant remove deny restore check"),
            CliOption("donor", "LOGIN", "Donor login; @me uses your signed-in account"),
            CliOption(
                "base-branch",
                "BRANCH",
                "Owner-selected target; default: upstream default branch (prompt on a terminal)"
            ),
            CliOption("model", "MODEL", "Owner-approved model"),
            CliOption("effort", "EFFORT", "Owner-approved effort", "minimal low medium high xhigh max ultra absent"),
            CliOption("harness", "HARNESS", "Managed harness: codex or pi"),
            CliOption("endpoint", "URL", "Private pi no-auth loopback Chat Completions base URL"),
            CliOption("pi-root", "DIR", "Donor-installed pi node_modules directory; no installation"),
            CliOption("node", "FILE", "Donor-installed Node executable for pi"),
            CliOption("provider", "PROVIDER", "Managed provider: openai or local-chat-completions"),
            CliOption(
                "availability",
                "STATUS",
                "Donor report for the candidate model; never an account probe",
                "unknown available unavailable"
            ),
            CliOption("non-interactive", "", "Never prompt; require an eligible default or explicit choice"),
            CliOption("yes", "", "Confirm inference with the selected pair; never accept a substitute"),
            CliOption("seconds", "N", "Budget in seconds, 1..86400; default: {{seconds}}"),
            CliOption(
                "verification-reserve",
                "N",
                "Managed verification reserve in seconds; positive and smaller than total; default: 0"
            ),
            CliOption("fork", "LOGIN/REPO", "Explicit donor fork; otherwise discover one or create it once"),
            CliOption("runs", "DIR", "Run storage; default: ~/.local/state/tokate/runs"),
            CliOption("run", "DIR", "Saved run directory"),
            CliOption("allow-network", "", "Allow network if owner permits; default: off"),
            CliOption("path", "DIR", "Repository directory; default: current directory"),
            CliOption("pr", "N", "Positive pull request number"),
            CliOption("prs", "N,N", "Explicit selection of 2 to 16 unique positive PR numbers"),
            CliOption("watch", "", "Wait for checks; default: off"),
            CliOption("timeout", "N", "Check wait limit, 1..86400 seconds; default: 1200"),
            CliOption("state", "SHA", "Exact coordination-state commit"),
            CliOption("source", "SOURCE", "Coding source", "external tokate"),
            CliOption("tools", "FILE", "Nonsecret JSON tool declarations"),
            CliOption("file", "FILE", "Strict claim or publication request JSON"),
            CliOption("event", "FILE", "Trusted issue_comment event JSON"),
            CliOption("output", "FILE", "New workflow file outside .github"),
            CliOption("sync", "SHA", "Exact live owner synchronization grant"),
            CliOption("grant", "SHA", "Synchronization grant to revoke"),
            CliOption("upstream", "SHA", "Exact current trusted target revision"),
            CliOption("commit", "SHA", "Exact candidate commit to verify"),
            CliOption("prepare", "", "Archive original completed work before correction; no checks or publication"),
            CliOption("help", "", "Show help (-h); no tools, network or inference"),
            CliOption("traffic", "", "Print Tokate API counts on stderr; default: off"),
            CliOption("json", "", "Emit one schema-version-1 result on stdout; diagnostics on stderr"),
            CliOption("plain", "", "Plain human output without color, ornament or animation; --json takes precedence"),
            CliOption("ascii", "", "Use ASCII ornaments; preserve names and URLs verbatim"),
        }
        internal let Commands[]CliCommand = []CliCommand{
            CliCommand(
                "doctor",
                "owner,managed,external,auth,non-interactive",
                "",
                "Check the selected role locally; no login required unless --auth, no inference.",
                "[--owner|--managed|--external] [--auth] [--non-interactive]",
                "doctor",
                effects: "local_read local_write"
            ),
            CliCommand(
                "update",
                "",
                "",
                "Download and install latest stable Tokate; no inference.",
                "",
                "update",
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "uninstall",
                "",
                "",
                "Remove managed installation offline; keep saved runs.",
                "",
                "uninstall",
                effects: "local_read local_write"
            ),
            CliCommand(
                "defaults",
                "harness,provider,model,effort",
                "",
                "Set, read or remove donor-entered Tokate defaults locally; no discovery or inference.",
                "set --harness HARNESS --provider PROVIDER --model MODEL --effort EFFORT\n       tokate defaults read|remove",
                "defaults set --harness codex --provider openai --model gpt-6.1-sol --effort high",
                effects: "local_read local_write"
            ),
            CliCommand(
                "select",
                "repo,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive",
                "repo",
                "Select under current owner policy and offline harness capabilities; no inference or reservation.",
                "[--repo OWNER/REPO] [--model MODEL --effort EFFORT] [options]",
                "select --repo owner/project --non-interactive",
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "init",
                "path",
                "",
                "Create local policy and PR template; no inference or publication.",
                "[--path DIR]",
                "init --path ."
                ,
                effects: "local_read local_write"
            ),
            CliCommand(
                "coordinator-setup",
                "repo,output",
                "repo,output",
                "Download verified release assets and write a v2 workflow; no inference.",
                "[--repo OWNER/REPO] --output FILE",
                "coordinator-setup --repo owner/project --output coordinator.yml"
                ,
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "access",
                "repo,donor,issue,operation",
                "repo,operation",
                "Owner: mutate numeric donor membership, or check current task eligibility; no inference.",
                "--repo OWNER/REPO --operation ACTION [--donor LOGIN] [--issue N]",
                "access --repo owner/project --operation trust --donor donor",
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "coordination",
                "repo,issue",
                "repo,issue",
                "Read authoritative v2 issue state from GitHub; no inference or publication.",
                "[--repo OWNER/REPO] --issue N|URL",
                "coordination https://github.com/owner/project/issues/42"
                ,
                effects: "local_read github_read"
            ),
            CliCommand(
                "request",
                "repo,issue,file",
                "repo,issue,file",
                "Post a v2 claim or publication request to GitHub; no inference.",
                "[--repo OWNER/REPO] --issue N|URL --file FILE",
                "request --repo owner/project --issue 42 --file request.json"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "prepare",
                "run,repo,issue,state,source,tools,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive,fork,seconds,verification-reserve,allow-network,runs",
                "repo,issue,state,source",
                "Prepare a fresh reserved v2 contribution, or resume recorded preparation; no inference, checks or publication.",
                "[--repo OWNER/REPO] --issue N|URL --state SHA\n       --source external --tools FILE [options]\n       tokate prepare --issue N --state SHA --source tokate [selection options]\n       tokate prepare --run DIR",
                "prepare --issue 42 --state SHA --source external --tools tools.json"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "external",
                "run,commit",
                "run,commit",
                "Fetch and verify an exact external commit in isolation; no inference or publication.",
                "--run DIR --commit SHA",
                "external --run /path/to/run --commit SHA"
                ,
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "authorize-sync",
                "repo,pr,commit,upstream",
                "repo,pr,commit,upstream",
                "Owner: grant an exact candidate synchronization; no candidate inspection or acceptance.",
                "--repo OWNER/REPO --pr N --commit SHA --upstream SHA",
                "authorize-sync --repo owner/project --pr 10 --commit C --upstream U",
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "revoke-sync",
                "repo,grant",
                "repo,grant",
                "Owner: preserve and revoke a synchronization grant by nonforce ref advance.",
                "--repo OWNER/REPO --grant SHA",
                "revoke-sync --repo owner/project --grant G",
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "amend",
                "run,commit,seconds,tools,sync",
                "run,commit,seconds",
                "Verify and publish a same-donor review correction; no inference.",
                "--run DIR --commit SHA --seconds N [--tools FILE] [--sync GRANT]",
                "amend --run /path/to/run --commit SHA --seconds 300",
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "submit",
                "run",
                "run",
                "Push Tokate-coded work and request a coordinated v2 draft PR; no inference.",
                "--run DIR",
                "submit --run /path/to/run"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "coordinate",
                "repo,event",
                "repo,event",
                "Trusted owner workflow: update v2 state and publish approved requests; no inference.",
                "--repo OWNER/REPO --event FILE",
                "coordinate --repo owner/project --event event.json"
                ,
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "policy",
                "repo",
                "repo",
                "Read upstream owner policy from GitHub; no inference.",
                "[--repo OWNER/REPO]",
                "policy --repo owner/project"
                ,
                effects: "local_read github_read"
            ),
            CliCommand(
                "approve",
                "repo,issue,donor,base-branch",
                "repo,issue",
                "Write GitHub task approval and label; legacy scope also requires one donor assignment.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO] [--donor LOGIN] [--base-branch BRANCH]",
                "approve https://github.com/owner/project/issues/42 --donor donor"
                ,
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "assign",
                "repo,issue,donor,base-branch",
                "repo,issue,donor",
                "Replace approval and donor on an approved issue on GitHub; no inference.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO] --donor LOGIN [--base-branch BRANCH]",
                "assign --repo owner/project --issue 42 --donor donor"
                ,
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "revoke",
                "repo,issue",
                "repo,issue",
                "Remove GitHub approval; blocks publication, not active computation.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]",
                "revoke https://github.com/owner/project/issues/42"
                ,
                effects: "local_read github_read github_write"
            ),
            CliCommand(
                "claim",
                "repo,issue,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive,seconds,verification-reserve,fork,runs,allow-network",
                "repo,issue",
                "Reserve a v1 GitHub branch and save a claim; no inference or PR publication.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]\n       [--model MODEL --effort EFFORT] [options]",
                "claim https://github.com/owner/project/issues/42 --model gpt-6.1-sol --effort high"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "work",
                "repo,issue,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive,yes,seconds,verification-reserve,fork,runs,allow-network,run",
                "repo,issue",
                "Run the saved managed harness selection and verify.\nV1: publish a draft PR. V2: save a commit, then use submit.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]\n       [--model MODEL --effort EFFORT] [--yes] [options]\n       tokate work --run DIR [--yes] [--non-interactive]",
                "work --repo owner/project --issue 42 --model MODEL --effort high"
                ,
                effects: "local_read local_write github_read github_write inference"
            ),
            CliCommand(
                "recover",
                "run,seconds,prepare,commit,tools",
                "run",
                "Recover completed work without inference. Explicit corrections require preparation and a separate budget.",
                "--run DIR [--seconds N]\n       tokate recover --run DIR --prepare\n       tokate recover --run DIR --commit SHA --seconds N [--tools FILE]",
                "recover --run /path/to/run --seconds 300"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "publish",
                "run",
                "run",
                "Push and publish a v1 draft PR from a successful run; no inference.",
                "--run DIR",
                "publish --run /path/to/run"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "status",
                "run",
                "run",
                "Read saved run locally; no inference or publication.",
                "--run DIR",
                "status --run /path/to/run"
                ,
                effects: "local_read"
            ),
            CliCommand(
                "verify-pr",
                "repo,pr",
                "repo,pr",
                "Read GitHub approval and PR receipt; no inference or publication.",
                "[--repo OWNER/REPO] --pr N",
                "verify-pr --repo owner/project --pr 10"
                ,
                effects: "local_read github_read"
            ),
            CliCommand(
                "overlaps",
                "repo,prs",
                "repo,prs",
                "Read selected contribution filename overlap and native issue dependencies; advisory only.",
                "--repo OWNER/REPO --prs N,N",
                "overlaps --repo owner/project --prs 12,34",
                effects: "local_read github_read"
            ),
            CliCommand(
                "checks",
                "run,repo,pr,watch,timeout",
                "repo,pr",
                "Read GitHub PR checks; --run also saves results locally. Exit: 0 passed, 8 pending, 1 failed.",
                "[--repo OWNER/REPO] --pr N [--watch] [--timeout N]\n       tokate checks --run DIR [--watch] [--timeout N]",
                "checks --run /path/to/run --watch"
                ,
                effects: "local_read local_write github_read"
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

        internal func Metadata(name string = "") Object {
            let commands = List[Object]()
            for command in Commands {
                if name != "" && command.Name != name {
                    continue
                }
                let options = List[Object]()
                for option in Options {
                    if command.Has(option.Name) {
                        options.Add(
                            J.Map(
                                "name",
                                "--" + option.Name,
                                "value",
                                option.Value,
                                "description",
                                option.Describe(command.Name),
                                "choices",
                                option.Choices == "" ? []string{}: option.Choices.Split(' ')
                            )
                        )
                    }
                }
                let inputs = List[Object]()
                let conflicts = List[Object]()
                for option in command.Options.Split(',', StringSplitOptions.RemoveEmptyEntries) {
                    if command.ConflictsWithRun(option) {
                        conflicts.Add(option)
                    }
                }
                inputs.Add(command.Required == "" ? []string{}: command.Required.Split(','))
                if command.Name == "work" || command.Name == "checks" || command.Name == "prepare" {
                    inputs.Add([]string{"run"})
                }
                let effects = J.Map()
                for effect in[]string{"local_read", "local_write", "github_read", "github_write"} {
                    effects[effect] = Array.IndexOf(command.Effects.Split(' '), effect) >= 0
                }
                let modes = List[Object]()
                if command.Name == "defaults" {
                    for mode in[]string{"set", "read", "remove"} {
                        modes.Add(
                            J.Map(
                                "name",
                                mode,
                                "required_inputs",
                                mode == "set" ? []string{"harness", "provider", "model", "effort"}: []string{},
                                "effects",
                                J.Map(
                                    "local_read",
                                    true,
                                    "local_write",
                                    mode != "read",
                                    "github_read",
                                    false,
                                    "github_write",
                                    false
                                )
                            )
                        )
                    }
                }
                let positional = command.Name == "defaults" ? []string{"set|read|remove"}: (
                    command.Name == "help" ? []string{"COMMAND"}:
                    (
                        command.Name == "completion" ? []string{"bash|zsh|fish"}:
                        (command.Has("issue") ? []string{"ISSUE_URL"}: []string{})
                    )
                )
                commands.Add(
                    J.Map(
                        "command",
                        command.Name,
                        "summary",
                        command.Summary,
                        "arguments",
                        options,
                        "positional_arguments",
                        positional,
                        "operations",
                        modes,
                        "required_inputs",
                        inputs,
                        "repository_inputs",
                        command.Has("repo") ? (
                            command.Has("issue") ? []string{"repo", "issue_url", "local_github_remote"}: []string{
                                "repo",
                                "local_github_remote"
                            }
                        ): []string{},
                        "exclusive_run_inputs",
                        conflicts,
                        "effects",
                        effects,
                        "inference",
                        command.Effects.Contains("inference"),
                        "noninteractive",
                        true
                    )
                )
            }
            return J.Map("version", ApplicationInfo.Version(), "subject", name, "commands", commands)
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

        private func OptionHelp(text StringBuilder, label string, description string, width int32) {
            text.AppendLine("  " + label)
            var line = "    "
            for word in description.Split(' ', StringSplitOptions.RemoveEmptyEntries) {
                if line.Length > 4 && line.Length + word.Length + 1 > width - 2 {
                    text.AppendLine(line)
                    line = "    "
                }
                line += (line.Length == 4 ? "": " ") + word
            }
            text.AppendLine(line)
            text.AppendLine()
        }

        internal func Help(name string = "", width int32 = 80) string {
            let text = StringBuilder()
            if name == "" {
                text.AppendLine("Tokate " + ApplicationInfo.Version() + " (toh-KAH-teh)")
                text.AppendLine("Donate AI usage to approved GitHub issues.\n\nUsage: tokate <command> [options]\n")
                for command in Commands {
                    if width < 80 {
                        OptionHelp(text, command.Name, command.Summary.Replace("\n", " "), width)
                    } else {
                        text.AppendLine("  " + command.Name.PadRight(18) + command.Summary.Replace("\n", " "))
                    }
                }
                text.AppendLine("\nUse tokate <command> --help, tokate help <command>, or -h for details.")
                text.AppendLine(
                    "Value options accept --name=value. Issue URLs and unique local GitHub remotes supply --repo."
                )
                text.AppendLine(
                    "Explicit --repo OWNER/REPO and --issue N remain available. PRs are drafts; owners review and merge."
                )
                text.AppendLine(
                    "Human output: --plain or --ascii. NO_COLOR and TERM=dumb select plain text in terminals."
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
                        option.Describe(name) + (option.Choices == "" ? "": " (" + option.Choices + ")"),
                        width
                    )
                }
                if command.Has("issue") {
                    text.AppendLine("An issue URL can replace --repo and --issue.")
                }
                if name == "work" || name == "checks" || name == "prepare" {
                    text.AppendLine(
                        name == "prepare" ? "Use --run DIR only for recorded preparation before coding; it never resumes coding.":
                        name == "work" ? "For a saved claim, use --run DIR instead of required inputs.":
                        "Use --run DIR instead of --repo/--pr to check a saved run."
                    )
                }
                text.AppendLine("\nExample:\n  tokate " + command.Example)
            }
            return text.ToString().TrimEnd()
        }

        internal func PullNumbers(value string) List[int32] {
            let parts = value.Split(',')
            if parts.Length < 2 || parts.Length > 16 {
                throw Exception("--prs requires 2 to 16 unique positive PR numbers")
            }
            let numbers = List[int32]()
            let seen = HashSet[int32]()
            for part in parts {
                var number int32
                if !Regex.IsMatch(part, "^[0-9]+\\z") || !Int32.TryParse(part, out number) || number < 1 || !seen.Add(
                    number
                ) {
                    throw Exception("--prs requires 2 to 16 unique positive PR numbers")
                }
                numbers.Add(number)
            }
            return numbers
        }

        internal func Validate(args Args) {
            let command = Find(args.Command)
            if args.Command == "doctor" {
                var scopes int32
                for key in[]string{"owner", "managed", "external"} {
                    if args.Get(key) == "true" {
                        scopes++
                    }
                }
                if scopes > 1 {
                    throw Exception("Choose one doctor scope: --owner, --managed or --external")
                }
            }
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
            if args.Get("run") != "" &&
                (args.Command == "work" || args.Command == "checks" || args.Command == "prepare") {
                for key in args.Values.Keys {
                    if command.ConflictsWithRun(key.Substring(2)) {
                        throw Exception("--run conflicts with " + key)
                    }
                }
                if args.IssueUrl != "" {
                    throw Exception("--run conflicts with an issue URL")
                }
            }
            if args.Get("verification-reserve") != "" && args.Command == "prepare" && args.Get("source") != "tokate" {
                throw Exception("--verification-reserve requires --source tokate")
            }
            if args.Get("prs") != "" {
                PullNumbers(args.Get("prs"))
            }
            for key in[]string{"seconds", "verification-reserve", "timeout", "pr"} {
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
                RepositoryIdentity.Login(args.Get("donor"))
            }
            if args.Get("base-branch") != "" {
                RepositoryIdentity.Branch(args.Get("base-branch"))
            }
            if args.Get("model") != "" && !Regex.IsMatch(
                args.Get("model"),
                args.Get("harness") == "pi" ? "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$": "^[A-Za-z0-9][A-Za-z0-9._-]*$"
            ) {
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
            for key in[]string{"state", "commit", "grant", "upstream", "sync"} {
                if args.Get(key) != "" {
                    RepositoryIdentity.CommitSha(args.Get(key))
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
                for key in[]string{
                    "harness",
                    "provider",
                    "model",
                    "effort",
                    "endpoint",
                    "pi-root",
                    "node",
                    "availability",
                    "non-interactive"
                } {
                    if args.Get(key) != "" {
                        throw Exception("External declarations use --tools; selection option conflicts: --" + key)
                    }
                }
            }
            if args.Get("run") != "" &&
                (args.Command == "work" || args.Command == "checks" || args.Command == "prepare") {
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
