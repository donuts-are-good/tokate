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

    internal func Describe(command string) string {
        if (command == "init" || command == "coordinator-setup") && Name == "yes" {
            return "Apply the reviewed configuration files; no inference"
        }
        if (command == "init" || command == "coordinator-setup") && Name == "non-interactive" {
            return "Never prompt; supply missing choices explicitly; preview unless --yes is given"
        }
        if command == "external" && Name == "seconds" {
            return "Separate positive verification budget, at most the owner limit; required only for correction"
        }
        if command == "external" && Name == "tools" {
            return "Complete cumulative donor-reported tools JSON; retain prior rows, required only for correction"
        }
        if command == "repair" && Name == "run" {
            return "Separate saved repair evidence directory; initially empty, reused on explicit resume"
        }
        if command == "repair" && Name == "path" {
            return "Clean, self-contained candidate checkout; default current directory; separate from repair evidence"
        }
        if command == "repair" && Name == "commit" {
            return "Exact candidate; default from the selected owner synchronization grant; conflicts are refused"
        }
        if (command == "work" || command == "claim") && Name == "seconds" {
            return "Budget 1..86400 seconds; v2 required; v1 default: min(3600, owner limit)"
        }
        return (command == "amend" || command == "repair") && Name == "seconds" ?
        "Separate positive verification budget; required, at most the owner limit": Description.Replace(
            "{{seconds}}",
            command == "recover" ? "300": "min(3600, owner limit)"
        )
    }
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
        (Name == "work" && name != "yes" && name != "non-interactive" && name != "continue-truncated") ||
            (Name == "checks" && name != "watch" && name != "timeout") ||
            Name == "prepare" ||
            Name == "status"
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
            CliOption(
                "operation",
                "ACTION",
                "Access operation",
                "init trust untrust grant remove deny restore check request list history"
            ),
            CliOption(
                "model-policy",
                "MODE",
                "Explicit model access choice; existing restrictions are preserved",
                "unrestricted whitelist"
            ),
            CliOption(
                "models",
                "JSON",
                "Whitelist map of exact models to effort arrays; absent declares no effort control"
            ),
            CliOption(
                "allowed-tools",
                "TOOLS",
                "Allowed managed tools, comma-separated: codex (Subscription), pi (Local); omitted preserves policy"
            ),
            CliOption(
                "eligibility",
                "MODE",
                "Task eligibility; new repositories default to trusted",
                "open trusted manual"
            ),
            CliOption("verification", "JSON", "Existing project verification commands as JSON argv arrays"),
            CliOption("required-checks", "JSON", "Required GitHub check names as a JSON array"),
            CliOption("network", "MODE", "Owner command network permission; default deny", "allow deny"),
            CliOption("reservation-seconds", "N", "Reservation lifetime from 300 to 604800 seconds"),
            CliOption("pr-text", "TEXT", "Optional literal owner text appended to PRs; no template expressions"),
            CliOption(
                "close-message",
                "TEXT",
                "Optional literal admission message reserved for later admission integration"
            ),
            CliOption(
                "upgrade",
                "",
                "Explicitly upgrade legacy policy to task-scoped version 2 while preserving restrictions"
            ),
            CliOption("scope", "SCOPE", "Requested donor access; default issue", "issue trust"),
            CliOption("donor", "LOGIN", "Donor login; @me uses your signed-in account"),
            CliOption(
                "base-branch",
                "BRANCH",
                "Owner-selected target; default: upstream default branch (prompt on a terminal)"
            ),
            CliOption("model", "MODEL", "Owner-approved model"),
            CliOption("effort", "EFFORT", "Owner-approved effort", "minimal low medium high xhigh max ultra absent"),
            CliOption("harness", "HARNESS", "Managed harness: codex or pi"),
            CliOption("profile", "NAME", "Named local donor profile; explicit compatible choices override it"),
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
            CliOption(
                "continue-truncated",
                "",
                "Continue one truncated Pi response in this session and budget; default: off"
            ),
            CliOption("seconds", "N", "Budget in seconds, 1..86400; default: {{seconds}}"),
            CliOption(
                "unlimited",
                "",
                "No coding time limit when owner permits; requires --verification-reserve and excludes --seconds"
            ),
            CliOption(
                "verification-reserve",
                "N",
                "Verification seconds; required with --unlimited, otherwise reserved within --seconds; default: 0"
            ),
            CliOption("fork", "LOGIN/REPO", "Explicit donor fork; otherwise discover one or create it once"),
            CliOption(
                "runs",
                "DIR",
                "Run storage; default: tokate/runs under XDG_STATE_HOME, or ~/.local/state/tokate/runs"
            ),
            CliOption("run", "DIR", "Saved run directory"),
            CliOption(
                "continue-from",
                "DIR",
                "Import stopped unpublished same-donor managed work; v2 prepare requires a fresh active attempt"
            ),
            CliOption(
                "continue-approval",
                "SHA",
                "Owner v1 continuation grant naming the current unrevoked predecessor approval; preserves its original base"
            ),
            CliOption("allow-network", "", "Allow network if owner permits; default: off"),
            CliOption("path", "DIR", "Repository directory; default: current directory"),
            CliOption("pr", "N", "Positive pull request number"),
            CliOption("prs", "N,N", "Explicit selection of 2 to 16 unique positive PR numbers"),
            CliOption("watch", "", "Wait for checks; default: off"),
            CliOption("timeout", "N", "Check wait limit, 1..86400 seconds; default: 1200"),
            CliOption("state", "SHA", "Exact coordination-state commit"),
            CliOption("source", "SOURCE", "Coding source", "external tokate"),
            CliOption("tools", "FILE", "Nonsecret JSON tool declarations"),
            CliOption("summary", "FILE", "Bounded public JSON summary for the exact candidate commit"),
            CliOption("file", "FILE", "Strict claim or publication request JSON"),
            CliOption("event", "FILE", "Trusted GitHub event JSON"),
            CliOption("output", "FILE", "New workflow file outside .github"),
            CliOption("sync", "SHA", "Exact live owner synchronization grant"),
            CliOption(
                "resume",
                "",
                "Inspect saved reconciliation intent and physical Git state without repeating a merge"
            ),
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
                "owner,managed,external,auth",
                "",
                "Check the selected role locally; no login required unless --auth, no inference.",
                "[--owner|--managed|--external] [--auth]",
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
                "profile,harness,provider,model,effort,endpoint,pi-root,node",
                "",
                "Local nonsecret donor choices; set infers known harness/provider pairs, default codex/openai; no discovery or inference.",
                "set [--profile NAME] --model MODEL --effort EFFORT [options]\n       tokate defaults read|remove [--profile NAME]\n       tokate defaults list",
                "defaults set --model gpt-6.1-sol --effort high",
                effects: "local_read local_write"
            ),
            CliCommand(
                "select",
                "repo,profile,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive",
                "repo",
                "Select under current owner policy and offline harness capabilities; no inference or reservation.",
                "[--repo OWNER/REPO] [--model MODEL --effort EFFORT] [options]",
                "select --repo owner/project --non-interactive",
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "init",
                "repo,path,model-policy,models,allowed-tools,eligibility,verification,required-checks,base-branch,network,seconds,reservation-seconds,pr-text,close-message,upgrade,non-interactive,yes",
                "repo",
                "Preview and confirm owner policy and a pinned shared workflow; preserve existing customization.",
                "[--repo OWNER/REPO] [--path DIR] [options]",
                "init --repo owner/project"
                ,
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "coordinator-setup",
                "repo,output,non-interactive,yes",
                "repo,output",
                "Preview a shared workflow entry using verified matching release assets; no inference.",
                "[--repo OWNER/REPO] --output FILE",
                "coordinator-setup --repo owner/project --output coordinator.yml"
                ,
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "access",
                "repo,donor,issue,operation,scope",
                "repo,operation",
                "Request access, inspect pending requests and history, or manage existing numeric donor membership; no scoring.",
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
                "Post a v2 claim, lease transition or publication request; no inference.",
                "[--repo OWNER/REPO] --issue N|URL --file FILE",
                "request --repo owner/project --issue 42 --file request.json"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "prepare",
                "run,repo,issue,state,source,tools,profile,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive,fork,seconds,verification-reserve,unlimited,allow-network,runs,continue-from,yes",
                "repo,issue,state,source",
                "Prepare a fresh reserved v2 contribution, or resume recorded preparation; no inference, checks or publication.",
                "[--repo OWNER/REPO] --issue N|URL --state SHA\n       --source external --tools FILE [options]\n       tokate prepare --issue N --state SHA --source tokate [selection options]\n       [--continue-from DIR --seconds N --verification-reserve N --yes]\n       tokate prepare --run DIR",
                "prepare --issue 42 --state SHA --source external --tools tools.json"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "external",
                "run,commit,summary,seconds,tools",
                "run,commit",
                "Fetch and verify an exact external commit in isolation; no inference or publication.",
                "--run DIR --commit SHA [--summary FILE]\n       tokate external --run DIR --commit NEW --seconds N --tools FILE",
                "external --run /path/to/run --commit SHA"
                ,
                effects: "local_read local_write github_read"
            ),
            CliCommand(
                "reconcile",
                "run,resume",
                "run",
                "Merge the exact current target in a saved published workspace; no inference, checks or publication.",
                "--run DIR [--resume]",
                "reconcile --run /path/to/run",
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
                "repair",
                "repo,pr,run,path,commit,sync,seconds,allow-network",
                "repo,pr,run,sync,seconds",
                "Verify and repair a v1 draft PR when original private state is unavailable; no inference.",
                "--repo OWNER/REPO --pr N --run EVIDENCE_DIR --sync GRANT --seconds N\n       [--path CHECKOUT] [--commit SHA] [--allow-network]",
                "repair --repo owner/project --pr 10 --run /path/to/repair --sync G --seconds 300",
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "amend",
                "run,commit,seconds,tools,sync,summary",
                "run,commit,seconds",
                "Verify and publish a same-donor review correction; no inference.",
                "--run DIR --commit SHA --seconds N [--tools FILE] [--summary FILE] [--sync GRANT]",
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
                "admit",
                "repo,event",
                "repo,event",
                "Trusted owner workflow: close PRs without current owner authorization; no inference.",
                "--repo OWNER/REPO --event FILE",
                "admit --repo owner/project --event event.json",
                effects: "local_read github_read github_write"
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
                "repo,issue,donor,base-branch,continue-approval",
                "repo,issue",
                "Write GitHub task approval and label; legacy scope also requires one donor assignment.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO] [--donor LOGIN] [--base-branch BRANCH | --continue-approval SHA]",
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
                "repo,issue,profile,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive,seconds,verification-reserve,unlimited,fork,runs,allow-network,continue-from",
                "repo,issue",
                "Check donor readiness, reserve approved work and prepare a saved claim; no inference or PR publication.",
                "[ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]\n       [--model MODEL --effort EFFORT] [options]\n       [--continue-from DIR --seconds N --verification-reserve N]",
                "claim https://github.com/owner/project/issues/42 --model gpt-6.1-sol --effort high"
                ,
                effects: "local_read local_write github_read github_write"
            ),
            CliCommand(
                "work",
                "repo,issue,profile,harness,provider,model,effort,endpoint,pi-root,node,availability,non-interactive,yes,continue-truncated,seconds,verification-reserve,unlimited,fork,runs,allow-network,run,continue-from",
                "repo,issue",
                "Run the selected coding harness, verify work and show the publication step. Uses donor inference.",
                "[OWNER/REPO | ISSUE_URL | --issue N|URL] [--repo OWNER/REPO]\n       [--profile NAME | --model MODEL --effort EFFORT] [--seconds N] [options]\n       tokate work --run DIR [--yes] [--non-interactive] [--continue-truncated]",
                "work --repo owner/project --issue 42 --model MODEL --effort high"
                ,
                effects: "local_read local_write github_read github_write inference"
            ),
            CliCommand(
                "recover",
                "run,seconds,prepare,commit,tools,summary",
                "run",
                "Recover completed work without inference. Explicit corrections require preparation and a separate budget.",
                "--run DIR [--seconds N]\n       tokate recover --run DIR --prepare\n       tokate recover --run DIR --commit SHA --seconds N [--tools FILE] [--summary FILE]",
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
                "run,repo,issue",
                "repo",
                "Read contribution state and the responsible role remotely, or a saved run offline; no writes or inference.",
                "--repo OWNER/REPO [--issue N]\n       tokate status --run DIR",
                "status --repo owner/project --issue 42"
                ,
                effects: "local_read github_read"
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
                "Read receipt, public report, exact-head CI, dependency and freshness gates with required owner actions; --run also saves results locally. Exit: 0 machine gates passed, 8 pending, 1 failed. Owners retain acceptance and merge.",
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
                            map[string, Object?]{
                                "name": "--" + option.Name,
                                "value": option.Value,
                                "description": option.Describe(command.Name),
                                "choices": option.Choices == "" ? []string{}: option.Choices.Split(' ')
                            }
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
                if command.Name == "work" ||
                    command.Name == "checks" ||
                    command.Name == "prepare" ||
                    command.Name == "status" {
                    inputs.Add([]string{"run"})
                }
                let effects = map[string, Object?]{}
                let declaredEffects = command.Effects.Split(' ')
                for effect in[]string{"local_read", "local_write", "github_read", "github_write"} {
                    effects[effect] = Array.IndexOf(declaredEffects, effect) >= 0
                }
                let modes = List[Object]()
                if command.Name == "defaults" {
                    for mode in[]string{"set", "read", "remove", "list"} {
                        modes.Add(
                            map[string, Object?]{
                                "name": mode,
                                "required_inputs": mode == "set" ? []string{"model", "effort"}: []string{},
                                "effects": map[string, Object?]{
                                    "local_read": true,
                                    "local_write": mode == "set" || mode == "remove",
                                    "github_read": false,
                                    "github_write": false
                                }
                            }
                        )
                    }
                }
                if command.Name == "status" {
                    for mode in[]string{"repository", "run"} {
                        modes.Add(
                            map[string, Object?]{
                                "name": mode,
                                "required_inputs": []string{mode == "run" ? "run": "repo"},
                                "effects": map[string, Object?]{
                                    "local_read": true,
                                    "local_write": false,
                                    "github_read": mode == "repository",
                                    "github_write": false
                                }
                            }
                        )
                    }
                }
                let positional = if command.Name == "defaults" {
                    []string{"set|read|remove|list"}
                } else if command.Name == "help" {
                    []string{"COMMAND"}
                } else if command.Name == "completion" {
                    []string{"bash|zsh|fish"}
                } else if command.Has("issue") {
                    []string{"OWNER/REPO|REPO_URL|ISSUE_URL"}
                } else if command.Has("pr") {
                    []string{"OWNER/REPO|REPO_URL|PR_URL"}
                } else if command.Has("repo") {
                    []string{"OWNER/REPO|REPO_URL"}
                } else {
                    []string{}
                }
                commands.Add(
                    map[string, Object?]{
                        "command": command.Name,
                        "summary": command.Summary,
                        "arguments": options,
                        "positional_arguments": positional,
                        "operations": modes,
                        "required_inputs": inputs,
                        "repository_inputs": command.Has("repo") ? (
                            command.Has("issue") ? []string{
                                "repo",
                                "repository_argument",
                                "issue_url",
                                "local_github_remote"
                            }:
                            command.Has("pr") ? []string{
                                "repo",
                                "repository_argument",
                                "pr_url",
                                "local_github_remote"
                            }:
                            []string{"repo", "repository_argument", "local_github_remote"}
                        ): []string{},
                        "exclusive_run_inputs": conflicts,
                        "effects": effects,
                        "inference": command.Effects.Contains("inference"),
                        "noninteractive": true
                    }
                )
            }
            return map[string, Object?]{"version": ApplicationInfo.Version(), "subject": name, "commands": commands}
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
                text.AppendLine("Run tokate for guided setup, donations and saved work.\n")
                let common = HashSet[string](
                    "init work claim submit status checks access defaults doctor update".Split(' ')
                )
                let specialist = List[string]()
                for command in Commands {
                    if !common.Contains(command.Name) {
                        specialist.Add(command.Name)
                        continue
                    }
                    if width < 80 {
                        OptionHelp(text, command.Name, command.Summary.Replace("\n", " "), width)
                    } else {
                        text.AppendLine("  " + command.Name.PadRight(18) + command.Summary.Replace("\n", " "))
                    }
                }
                text.AppendLine("\nMore commands: " + String.Join(", ", specialist) + ".")
                text.AppendLine("\nUse tokate <command> --help, tokate help <command>, or -h for details.")
                text.AppendLine("Use OWNER/REPO, a GitHub issue/PR URL, or a unique local GitHub remote for context.")
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
                if command.Has("pr") {
                    text.AppendLine("A PR URL can replace --repo and --pr.")
                }
                if command.Has("repo") {
                    text.AppendLine("OWNER/REPO or a repository URL can replace --repo.")
                }
                if name == "work" || name == "claim" {
                    text.AppendLine(
                        "In a terminal, missing task, tool and budget choices are guided. Redirected input and --json never prompt."
                    )
                }
                if name == "work" || name == "checks" || name == "prepare" || name == "status" {
                    text.AppendLine(
                        name == "status" ? "Use --run DIR alone for offline status without GitHub or harness tools. Repository status is bounded and may report truncation; blocked work and failed CI still exit 0 after a successful read.":
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

        internal func Validate(args Args, guided bool = false) {
            let command = Find(args.Command)
            if args.Get("unlimited") == "true" {
                if args.Get("seconds") != "" || args.Get("continue-from") != "" ||
                    (args.Command == "prepare" && args.Get("source") != "tokate") {
                    throw Exception(
                        "--unlimited requires fresh managed work and excludes --seconds and --continue-from"
                    )
                }
                if !guided && !args.Help {
                    args.Need("verification-reserve")
                }
            }
            if args.Get("continue-approval") != "" && args.Get("base-branch") != "" {
                throw Exception("--continue-approval derives its original target and excludes --base-branch")
            }
            if args.Get("continue-from") != "" && !args.Help {
                args.Need("seconds")
                args.Need("verification-reserve")
                if args.Command == "prepare" && args.Get("source") != "tokate" {
                    throw Exception("--continue-from requires --source tokate")
                }
            }
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
                    (
                    args.Get("commit") != "" || args.Get("seconds") != "" || args.Get("tools") != "" || args.Get(
                        "summary"
                    ) != ""
                ) {
                    throw Exception("--prepare excludes --commit, --seconds, --tools and --summary")
                }
                if args.Get("commit") != "" && !args.Help {
                    args.Need("seconds")
                }
                if args.Get("summary") != "" && args.Get("commit") == "" {
                    throw Exception("--summary requires an explicit corrected --commit")
                }
                if args.Get("tools") != "" && args.Get("commit") == "" {
                    throw Exception("--tools requires an explicit corrected --commit")
                }
            }
            if args.Get("run") != "" &&
                (
                args.Command == "work" ||
                    args.Command == "checks" ||
                    args.Command == "prepare" ||
                    args.Command == "status"
            ) {
                for key in args.Values.Keys {
                    if command.ConflictsWithRun(key.Substring(2)) {
                        throw Exception("--run conflicts with " + key)
                    }
                }
                if args.Target != "" {
                    throw Exception("--run conflicts with a repository or task argument")
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
            for key in[]string{"path", "run", "runs", "file", "tools", "summary", "event", "output", "continue-from"} {
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
                args.Get("harness") == "pi" || args.Get("harness") == "" || args.Get(
                    "profile"
                ) != "" ? "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$": "^[A-Za-z0-9][A-Za-z0-9._-]*$"
            ) {
                throw Exception("Invalid model name: --model")
            }
            if args.Get("profile") != "" {
                DonorDefaults.Name(args.Get("profile"))
            }
            for key in[]string{"harness", "provider"} {
                if args.Get(key) != "" && !Regex.IsMatch(args.Get(key), "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
                    throw Exception("Invalid identifier: --" + key)
                }
            }
            for key in[]string{"effort", "source", "availability", "model-policy", "eligibility", "network", "scope"} {
                if args.Get(key) != "" && Array.IndexOf(
                    OptionFor(args.Command, key).Choices.Split(' '),
                    args.Get(key)
                ) < 0 {
                    throw Exception("Invalid value for --" + key)
                }
            }
            for key in[]string{"state", "commit", "grant", "upstream", "sync", "continue-approval"} {
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
                if args.Subject != "set" &&
                    args.Subject != "read" &&
                    args.Subject != "remove" &&
                    args.Subject != "list" {
                    throw Exception("Required defaults operation: set, read, list or remove")
                }
                if args.Subject == "list" && args.Get("profile") != "" {
                    throw Exception("defaults list does not take --profile")
                }
                if args.Subject == "set" {
                    DonorDefaults.NormalizePair(args)
                }
                for key in[]string{"harness", "provider", "model", "effort", "endpoint", "pi-root", "node"} {
                    if args.Subject == "set" {
                        if key == "harness" || key == "provider" || key == "model" || key == "effort" {
                            args.Need(key)
                        } else if args.Get("harness") != "pi" && args.Get(key) != "" {
                            throw Exception("Pi runtime options require the pi harness")
                        }
                    } else if args.Get(key) != "" {
                        throw Exception("defaults " + args.Subject + " does not take --" + key)
                    }
                }
            }
            if args.Command == "prepare" && args.Get("source") == "external" {
                args.Need("tools")
                for key in[]string{
                    "profile",
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
                (
                args.Command == "work" ||
                    args.Command == "checks" ||
                    args.Command == "prepare" ||
                    args.Command == "status"
            ) {
                return
            }
            if guided && (args.Command == "work" || args.Command == "claim") && args.Get("continue-from") == "" {
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
