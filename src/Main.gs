package Tokate

import System
import System.IO

func Main(args[]string) int32 {
    var traffic bool
    var validated bool
    try {
        let options = Args(args)
        traffic = options.Get("traffic") == "true"
        Cli.Validate(options)
        validated = true
        if options.Help {
            Terminal.Help(options.Command == "help" ? options.Subject: options.Command)
            return 0
        }
        if options.Command == "completion" {
            Console.Write(Completion.Script(options.Subject))
            return 0
        }
        if !OperatingSystem.IsLinux() {
            throw Exception("This release supports Linux")
        }
        if options.Command == "--version" {
            Console.WriteLine("tokate " + Data.Version())
            return 0
        }
        if options.Command == "update" || options.Command == "uninstall" {
            return Installation.Run(options.Command)
        }
        if options.Command != "doctor" {
            Startup.Check(options.Command)
        }
        if options.Command == "doctor" {
            return Startup.Doctor()
        } else if options.Command == "init" {
            Workflow.Init(options)
        } else if options.Command == "coordinator-setup" {
            CoordinatorSetup.Run(options)
        } else if options.Command == "coordinate" {
            Coordinator.Run(options)
        } else if options.Command == "coordination" {
            let state = CoordinationState.Load(Data.Repo(options.Need("repo")), options.Number("issue"))
            Terminal.Json(
                J.Parse(J.Write(J.Map("sha", state.Sha, "state", state.Value()))),
                "Contribution coordination"
            )
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
            Worker.Execute(directory)
            if Data.Load(directory).Number("version") == 2 {
                V2Contribution.Commit(directory)
            } else {
                Publication.Publish(directory)
            }
        } else if options.Command == "recover" {
            let directory = Path.GetFullPath(options.Need("run"))
            Recovery.Run(directory, options.Number("seconds", "300"))
            Publication.Publish(directory)
        } else if options.Command == "publish" {
            Publication.Publish(Path.GetFullPath(options.Need("run")))
        } else if options.Command == "checks" {
            return Publication.Checks(options)
        } else if options.Command == "policy" {
            let repo = Data.Repo(options.Need("repo"))
            let info = GitHub.Api("repos/" + repo)
            Terminal.Json(Policy.Load(repo, J.Text(info, "default_branch")).Value, "Repository policy")
        } else if options.Command == "verify-pr" {
            Publication.Verify(Data.Repo(options.Need("repo")), options.Number("pr"))
            Terminal.Message("PR receipt matches owner approval and policy. Model usage remains donor-reported.")
        } else if options.Command == "status" {
            Terminal.Json(Data.Load(Path.GetFullPath(options.Need("run"))).Element(), "Donor run")
        } else {
            throw Exception("Unknown command. Run tokate --help")
        }
        return 0
    } catch (error Exception) {
        Terminal.Message("tokate: " + error.Message, "red", true)
        if !validated {
            Terminal.Message(Cli.ErrorUsage(args), error: true)
        }
        return 1
    } finally {
        if traffic {
            ApiTransport.Report()
        }
    }
}
