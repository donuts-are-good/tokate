package Tokate

import System
import System.IO

func Main(args[]string) int32 {
    for argument in args {
        PublicOutput.Enabled = PublicOutput.Enabled || argument == "--json" || argument.StartsWith("--json=")
    }
    PublicOutput.Command = args.Length == 0 || args[0] == "--help" || args[0] == "-h" ? "help": args[0]
    var traffic bool
    var validated bool
    var options Args? = nil
    var code string = ""
    var message string = ""
    var exitCode int32
    try {
        options = Args(args)
        traffic = options.Get("traffic") == "true"
        Cli.Validate(options)
        validated = true
        PublicOutput.Command = options.Command
        if options.Get("run") != "" {
            PublicOutput.RunDirectory = Path.GetFullPath(options.Need("run"))
            PublicOutput.FailureCode = "invalid_state"
        }
        PublicOutput.ResultData = PublicOutput.Select(
            J.Parse(
                J.Write(
                    J.Map(
                        "repo",
                        options.Get("repo"),
                        "issue",
                        options.Get("issue"),
                        "donor",
                        options.Get("donor"),
                        "pr",
                        options.Get("pr")
                    )
                )
            ),
            "repo,issue,donor,pr"
        )
        exitCode = Dispatch(options)
        if exitCode == 1 {
            code = options.Command == "doctor" ? "missing_tools": (
                options.Command == "checks" ? "verification_failed": "command_failed"
            )
        }
    } catch (error Exception) {
        exitCode = 1
        code = !validated ? "invalid_arguments": PublicOutput.FailureCode
        if error is CliFailure failure {
            code = failure.Code
            message = failure.Message
            if failure.Action.Length > 0 {
                PublicOutput.Actions.Add(failure.Action)
            }
        } else {
            message = !validated ? error.Message: PublicOutput.Message(code)
        }
        PublicOutput.Truncated = PublicOutput.Truncated || code == "output_too_large"
        Terminal.Message("tokate: " + (PublicOutput.Enabled ? message: error.Message), "red", true)
        if !validated && !PublicOutput.Enabled {
            Terminal.Message(Cli.ErrorUsage(args), error: true)
        }
    } finally {
        if traffic {
            ApiTransport.Report()
        }
    }
    if PublicOutput.Enabled {
        PublicOutput.Next(options, code)
        return PublicOutput.Emit(exitCode, code, message)
    }
    return exitCode
}

func Dispatch(options Args) int32 {
    if options.Help {
        if PublicOutput.Enabled {
            PublicOutput.ResultData = Cli.Metadata(options.Command == "help" ? options.Subject: options.Command)
        } else {
            Terminal.Help(options.Command == "help" ? options.Subject: options.Command)
        }
        return 0
    }
    if options.Command == "completion" {
        let script = Completion.Script(options.Subject)
        if PublicOutput.Enabled {
            PublicOutput.ResultData = J.Map("shell", options.Subject, "script", script)
        } else {
            Console.Write(script)
        }
        return 0
    }
    if !OperatingSystem.IsLinux() {
        throw Exception("This release supports Linux")
    }
    if options.Command == "--version" {
        if PublicOutput.Enabled {
            PublicOutput.ResultData = J.Map("version", Data.Version())
        } else {
            Console.WriteLine("tokate " + Data.Version())
        }
        return 0
    }
    if options.Command == "update" || options.Command == "uninstall" {
        PublicOutput.ResultData = J.Map("version", Data.Version(), "installation", options.Command)
        return Installation.Run(options.Command)
    }
    if options.Command != "doctor" {
        Startup.Check(options.Command)
    }
    if options.Command == "doctor" {
        return Startup.Doctor()
    } else if options.Command == "init" {
        Workflow.Init(options)
        let root = Path.GetFullPath(options.Get("path", "."))
        PublicOutput.ResultData = J.Map(
            "path",
            root,
            "policy",
            Path.Combine(root, ".github/tokate.json"),
            "template",
            Path.Combine(root, ".github/tokate-pr.md")
        )
    } else if options.Command == "coordinator-setup" {
        CoordinatorSetup.Run(options)
        PublicOutput.ResultData = J.Map("repo", options.Get("repo"), "output", Path.GetFullPath(options.Need("output")))
    } else if options.Command == "coordinate" {
        Coordinator.Run(options)
    } else if options.Command == "coordination" {
        let state = CoordinationState.Load(Data.Repo(options.Need("repo")), options.Number("issue"))
        if PublicOutput.Enabled {
            PublicOutput.ResultData = PublicOutput.Coordination(state.Value(), state.Sha)
        } else {
            Terminal.Json(
                J.Parse(J.Write(J.Map("sha", state.Sha, "state", state.Value()))),
                "Contribution coordination"
            )
        }
    } else if options.Command == "request" {
        V2Contribution.Request(options)
    } else if options.Command == "prepare" {
        V2Contribution.Prepare(options)
    } else if options.Command == "external" {
        V2Contribution.External(options)
    } else if options.Command == "submit" {
        V2Contribution.Submit(options)
    } else if options.Command == "approve" || options.Command == "assign" {
        Workflow.Approve(options)
    } else if options.Command == "revoke" {
        Workflow.Revoke(options)
    } else if options.Command == "claim" {
        Workflow.Claim(options)
    } else if options.Command == "work" {
        let directory = options.Get("run") == "" ? Workflow.Claim(options): Path.GetFullPath(options.Need("run"))
        PublicOutput.RunDirectory = directory
        Worker.Execute(directory)
        PublicOutput.FailureCode = "command_failed"
        if Data.Load(directory).Number("version") == 2 {
            V2Contribution.Commit(directory)
        } else {
            Publication.Publish(directory)
        }
    } else if options.Command == "recover" {
        let directory = Path.GetFullPath(options.Need("run"))
        Recovery.Run(directory, options.Number("seconds", "300"))
        PublicOutput.FailureCode = "command_failed"
        Publication.Publish(directory)
    } else if options.Command == "publish" {
        Publication.Publish(Path.GetFullPath(options.Need("run")))
    } else if options.Command == "checks" {
        return Publication.Checks(options)
    } else if options.Command == "policy" {
        let repo = Data.Repo(options.Need("repo"))
        let info = GitHub.Api("repos/" + repo)
        let value = Policy.Load(repo, J.Text(info, "default_branch")).Value
        if PublicOutput.Enabled {
            PublicOutput.ResultData = J.Map("repo", repo, "policy", PublicOutput.Policy(value))
        } else {
            Terminal.Json(value, "Repository policy")
        }
    } else if options.Command == "verify-pr" {
        let run = Publication.Verify(Data.Repo(options.Need("repo")), options.Number("pr"))
        PublicOutput.ResultData = PublicOutput.Select(run.Element(), "repo,pr,pr_url,commit")
        Terminal.Message("PR receipt matches owner approval and policy. Model usage remains donor-reported.")
    } else if options.Command == "status" {
        let summary = PublicOutput.RunSummary(Path.GetFullPath(options.Need("run")))
        if PublicOutput.Enabled {
            PublicOutput.ResultData = summary
        } else {
            summary["truncated"] = PublicOutput.Truncated
            Terminal.Json(J.Parse(J.Write(summary)), "Donor run")
        }
    }
    if PublicOutput.Enabled && PublicOutput.RunDirectory != "" {
        PublicOutput.ResultData = PublicOutput.RunSummary(PublicOutput.RunDirectory)
    }
    return 0
}
