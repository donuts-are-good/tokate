package Tokate

import System
import System.IO

func Main(args[]string) int32 {
    try {
        let options = Args(args)
        if !OperatingSystem.IsLinux() {
            throw Exception("This release supports Linux")
        }
        if options.Command == "--version" {
            options.Allow("")
            Console.WriteLine("tokate " + Data.Version())
            return 0
        }
        if options.Get("help") == "true" || options.Command == "--help" || options.Command == "help" {
            Startup.Check("help")
            Terminal.Help()
            return 0
        }
        if options.Command == "update" || options.Command == "uninstall" {
            options.Allow("")
            return Installation.Run(options.Command)
        }
        if options.Command != "doctor" {
            Startup.Check(options.Command)
        }
        if options.Command == "doctor" {
            options.Allow("")
            return Startup.Doctor()
        } else if options.Command == "init" {
            Workflow.Init(options)
        } else if options.Command == "approve" || options.Command == "assign" {
            Workflow.Approve(options)
        } else if options.Command == "revoke" {
            Workflow.Revoke(options)
        } else if options.Command == "claim" {
            options.Allow("repo,issue,model,effort,seconds,fork,runs,allow-network")
            Workflow.Claim(options)
        } else if options.Command == "work" {
            options.Allow("repo,issue,model,effort,seconds,fork,runs,allow-network,run")
            if options.Get("run") != "" {
                options.Allow("run")
            }
            let directory = options.Get("run") == "" ? Workflow.Claim(options): Path.GetFullPath(options.Need("run"))
            Worker.Execute(directory)
            Publication.Publish(directory)
        } else if options.Command == "recover" {
            options.Allow("run,seconds")
            let directory = Path.GetFullPath(options.Need("run"))
            Recovery.Run(directory, options.Number("seconds", "300"))
            Publication.Publish(directory)
        } else if options.Command == "publish" {
            options.Allow("run")
            Publication.Publish(Path.GetFullPath(options.Need("run")))
        } else if options.Command == "checks" {
            return Publication.Checks(options)
        } else if options.Command == "policy" {
            options.Allow("repo")
            let repo = Data.Repo(options.Need("repo"))
            let info = GitHub.Api("repos/" + repo)
            Terminal.Json(Policy.Load(repo, J.Text(info, "default_branch")).Value, "Repository policy")
        } else if options.Command == "verify-pr" {
            options.Allow("repo,pr")
            Publication.Verify(Data.Repo(options.Need("repo")), options.Number("pr"))
            Terminal.Message("PR receipt matches owner approval and policy. Model usage remains donor-reported.")
        } else if options.Command == "status" {
            options.Allow("run")
            Terminal.Json(Data.Load(Path.GetFullPath(options.Need("run"))).Element(), "Donor run")
        } else {
            throw Exception("Unknown command. Run tokate --help")
        }
        return 0
    } catch (error Exception) {
        Terminal.Message("tokate: " + error.Message, "red", true)
        return 1
    }
}
