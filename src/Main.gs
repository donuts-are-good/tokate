package Tokate

import System
import System.IO

func Main(args[]string) int32 {
    try {
        let options = Args(args)
        if !OperatingSystem.IsLinux() {
            throw Exception("This release supports Linux")
        }
        if options.Get("help") == "true" || options.Command == "--help" || options.Command == "help" {
            Console.WriteLine(Data.Resource("help.txt"))
            return 0
        }
        if options.Command == "doctor" {
            options.Allow("")
            Worker.Doctor()
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
        } else if options.Command == "publish" {
            options.Allow("run")
            Publication.Publish(Path.GetFullPath(options.Need("run")))
        } else if options.Command == "checks" {
            return Publication.Checks(options)
        } else if options.Command == "policy" {
            options.Allow("repo")
            let repo = Data.Repo(options.Need("repo"))
            let info = GitHub.Api("repos/" + repo)
            Console.WriteLine(J.Write(Policy.Load(repo, J.Text(info, "default_branch")).Value))
        } else if options.Command == "verify-pr" {
            options.Allow("repo,pr")
            Publication.Verify(Data.Repo(options.Need("repo")), options.Number("pr"))
            Console.WriteLine("PR receipt matches owner approval and policy. Model usage remains donor-reported.")
        } else if options.Command == "status" {
            options.Allow("run")
            Console.WriteLine(J.Write(Data.Load(Path.GetFullPath(options.Need("run"))).Fields))
        } else if options.Command == "--version" {
            Console.WriteLine("tokate 0.2.0")
        } else {
            throw Exception("Unknown command. Run tokate --help")
        }
        return 0
    } catch (error Exception) {
        Console.Error.WriteLine("tokate: " + error.Message)
        return 1
    }
}
