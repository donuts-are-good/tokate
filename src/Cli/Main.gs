package Tokate

import System
import System.IO

func Main(args[]string) int32 {
    Terminal.Initialize()
    for argument in args {
        PublicOutput.Enabled = PublicOutput.Enabled || argument == "--json" || argument.StartsWith("--json=")
        Terminal.Plain = Terminal.Plain || argument == "--plain" || argument.StartsWith("--plain=")
        Terminal.Ascii = Terminal.Ascii || argument == "--ascii"
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
        if options.Get("run") != "" && options.Command != "repair" {
            PublicOutput.RunDirectory = Path.GetFullPath(options.Need("run"))
            PublicOutput.FailureCode = "invalid_state"
        }
        PublicOutput.ResultData = map[string, Object?]{
            "repo": options.Get("repo"),
            "issue": options.Get("issue"),
            "donor": options.Get("donor"),
            "pr": options.Get("pr")
        }
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
            message = failure.Summary
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
    if PublicOutput.Enabled || (PublicOutput.RunDirectory != "" && Terminal.Foreground()) {
        PublicOutput.Next(options, code)
        if options?.Help != true {
            Terminal.RunOutcome(exitCode, code)
        }
    }
    if PublicOutput.Enabled {
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
            PublicOutput.ResultData = map[string, Object?]{"shell": options.Subject, "script": script}
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
            PublicOutput.ResultData = map[string, Object?]{"version": ApplicationInfo.Version()}
        } else {
            Console.WriteLine("tokate " + ApplicationInfo.Version())
        }
        return 0
    }
    if options.Command == "update" || options.Command == "uninstall" {
        PublicOutput.ResultData = map[string, Object?]{
            "version": ApplicationInfo.Version(),
            "installation": options.Command
        }
        return Installation.Run(options.Command)
    }
    if options.Command != "doctor" && options.Command != "defaults" {
        Startup.Check(options)
    }
    if options.Command == "doctor" {
        return Startup.Doctor(options)
    } else if options.Command == "defaults" {
        let value = DonorDefaults.Run(options)
        if PublicOutput.Enabled {
            PublicOutput.ResultData = value
        } else {
            Terminal.Json(value, "Donor defaults")
        }
    } else if options.Command == "select" {
        let repo = RepositoryIdentity.Repo(options.Need("repo"))
        let info = GitHub.Api("repos/" + repo)
        let selection = DonorSelection.Resolve(options, Policy.Load(repo, J.Text(info, "default_branch")))
        if PublicOutput.Enabled {
            PublicOutput.ResultData = PublicOutput.Select(
                selection,
                "harness,provider,model,effort,source,policy_hash,policy_eligible,capability,availability,availability_evidence"
            )
        } else {
            Terminal.Json(selection, "Donor selection")
        }
    } else if options.Command == "init" {
        OwnerSetup.Run(options)
    } else if options.Command == "coordinator-setup" {
        CoordinatorSetup.Run(options)
        PublicOutput.ResultData = map[string, Object?]{
            "repo": options.Get("repo"),
            "output": Path.GetFullPath(options.Need("output"))
        }
    } else if options.Command == "access" {
        AccessState.Run(options)
    } else if options.Command == "coordinate" {
        Coordinator.Run(options)
    } else if options.Command == "admit" {
        Admission.Run(options)
    } else if options.Command == "coordination" {
        let state = CoordinationState.Load(RepositoryIdentity.Repo(options.Need("repo")), options.Number("issue"))
        if PublicOutput.Enabled {
            PublicOutput.ResultData = PublicOutput.Coordination(state.Value(), state.Sha)
        } else {
            Terminal.Json(
                J.Parse(J.Write(map[string, Object?]{"sha": state.Sha, "state": state.Value()})),
                "Contribution coordination"
            )
        }
    } else if options.Command == "request" {
        Submission.Request(options)
    } else if options.Command == "prepare" {
        V2Preparation.Prepare(options)
    } else if options.Command == "external" {
        ExternalContribution.External(options)
    } else if options.Command == "reconcile" {
        Reconciliation.Run(options)
        return 0
    } else if options.Command == "authorize-sync" {
        Synchronization.Authorize(options)
    } else if options.Command == "revoke-sync" {
        Synchronization.Revoke(options)
    } else if options.Command == "amend" {
        Amendment.Run(options)
    } else if options.Command == "repair" {
        Repair.Run(options)
    } else if options.Command == "submit" {
        Submission.Submit(options)
    } else if options.Command == "approve" || options.Command == "assign" {
        OwnerApproval.Approve(options)
    } else if options.Command == "revoke" {
        OwnerApproval.Revoke(options)
    } else if options.Command == "claim" {
        ContributionClaim.Claim(options)
    } else if options.Command == "work" {
        let directory = options.Get("run") == "" ? ContributionClaim.Claim(options): Path.GetFullPath(
            options.Need("run")
        )
        PublicOutput.RunDirectory = directory
        Worker.Execute(directory, options)
        PublicOutput.FailureCode = "command_failed"
        if Data.Load(directory).Number("version") == 2 {
            Submission.Commit(directory)
        } else {
            Publication.Publish(directory)
        }
    } else if options.Command == "recover" {
        let directory = Path.GetFullPath(options.Need("run"))
        if options.Get("prepare") == "true" || options.Get("commit") != "" {
            Correction.Recover(options)
        } else {
            Recovery.Run(directory, options.Number("seconds", "300"))
            PublicOutput.FailureCode = "command_failed"
            Publication.Publish(directory)
        }
    } else if options.Command == "publish" {
        Publication.Publish(Path.GetFullPath(options.Need("run")))
    } else if options.Command == "overlaps" {
        Overlaps.Run(options)
    } else if options.Command == "checks" {
        return Checks.Run(options)
    } else if options.Command == "policy" {
        let repo = RepositoryIdentity.Repo(options.Need("repo"))
        let info = GitHub.Api("repos/" + repo)
        let value = Policy.Load(repo, J.Text(info, "default_branch")).Value
        if PublicOutput.Enabled {
            PublicOutput.ResultData = map[string, Object?]{"repo": repo, "policy": PublicOutput.Policy(value)}
        } else {
            Terminal.Json(value, "Repository policy")
        }
    } else if options.Command == "verify-pr" {
        let run = ReceiptVerification.Verify(RepositoryIdentity.Repo(options.Need("repo")), options.Number("pr"))
        PublicOutput.ResultData = PublicOutput.Select(run.Element(), "repo,pr,pr_url,commit")
        Terminal.Message("PR receipt matches owner approval and policy. Model usage remains donor-reported.")
    } else if options.Command == "status" && options.Get("run") == "" {
        ContributionStatus.Run(options)
    } else if options.Command == "status" && !PublicOutput.Enabled {
        let summary = PublicOutput.RunSummary(Path.GetFullPath(options.Need("run")))
        summary["truncated"] = PublicOutput.Truncated
        Terminal.Json(J.Parse(J.Write(summary)), "Donor run")
    }
    if PublicOutput.Enabled && PublicOutput.RunDirectory != "" {
        PublicOutput.ResultData = PublicOutput.RunSummary(PublicOutput.RunDirectory)
    }
    return 0
}
