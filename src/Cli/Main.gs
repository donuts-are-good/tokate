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
        if args.Length == 0 && Interactive.Available() {
            validated = true
            return Interactive.Run()
        }
        options = Args(args)
        traffic = options.Get("traffic") == "true"
        Cli.Validate(options, guided: DonorSelection.Interactive(options))
        GuidedWork.Fill(options)
        Cli.Validate(options)
        validated = true
        PublicOutput.Command = options.Command
        if options.Get("run") != "" {
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
        DonationView.Close()
        WizardScreen.Close()
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
        DonationView.Close()
        WizardScreen.Close()
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
        DonorSelection.ApplyDefaults(options)
        Startup.Check(options)
    }
    switch options.Command {
        case "doctor" {
            return Startup.Doctor(options)
        }
        case "defaults" {
            let value = DonorDefaults.Run(options)
            if PublicOutput.Enabled {
                PublicOutput.ResultData = value
            } else {
                Terminal.Json(value, "Donor defaults")
            }
        }
        case "select" {
            let repo = RepositoryIdentity.Repo(options.Need("repo"))
            let info = GitHub.Api("repos/" + repo)
            let selection = DonorSelection.Resolve(options, Policy.Load(repo, J.Text(info, "default_branch")))
            if PublicOutput.Enabled {
                PublicOutput.ResultData = J.Select(
                    selection,
                    "harness,provider,model,effort,source,policy_hash,policy_eligible,capability,availability,availability_evidence"
                )
            } else {
                Terminal.Json(selection, "Donor selection")
            }
        }
        case "init" {
            OwnerSetup.Run(options)
        }
        case "coordinator-setup" {
            CoordinatorSetup.Run(options)
            PublicOutput.ResultData = map[string, Object?]{
                "repo": options.Get("repo"),
                "output": Path.GetFullPath(options.Need("output"))
            }
        }
        case "access" {
            AccessState.Run(options)
        }
        case "coordinate" {
            Coordinator.Run(options)
        }
        case "admit" {
            Admission.Run(options)
        }
        case "coordination" {
            let state = CoordinationState.Load(RepositoryIdentity.Repo(options.Need("repo")), options.Number("issue"))
            if PublicOutput.Enabled {
                PublicOutput.ResultData = PublicOutput.Coordination(state.Value(), state.Sha)
            } else {
                Terminal.Json(
                    J.Parse(J.Write(map[string, Object?]{"sha": state.Sha, "state": state.Value()})),
                    "Contribution coordination"
                )
            }
        }
        case "request" {
            if options.Get("run") != "" {
                return ReservationRequest.Run(options)
            }
            Submission.Request(options)
        }
        case "prepare" {
            let directory = ContributionPreparation.Prepare(options)
            if Data.Load(directory).Text("state") == "claim_pending" {
                return 8
            }
        }
        case "external" {
            ExternalContribution.External(options)
        }
        case "reconcile" {
            Reconciliation.Run(options)
            return 0
        }
        case "authorize-sync" {
            Synchronization.Authorize(options)
        }
        case "revoke-sync" {
            Synchronization.Revoke(options)
        }
        case "amend" {
            Amendment.Run(options)
        }
        case "submit" {
            Submission.Submit(options)
        }
        case "approve" {
            OwnerApproval.Approve(options)
        }
        case "revoke" {
            OwnerApproval.Revoke(options)
        }
        case "claim" {
            let directory = ContributionPreparation.Acquire(options)
            if Data.Load(directory).Text("state") == "claim_pending" {
                return 8
            }
        }
        case "work" {
            let directory = options.Get("run") == "" ? ContributionPreparation.Acquire(options): Path.GetFullPath(
                options.Need("run")
            )
            PublicOutput.RunDirectory = directory
            if Data.Load(directory).Text("state") == "claim_pending" {
                if options.Get("run") != "" {
                    ContributionPreparation.ResumePending(directory, options)
                }
                if Data.Load(directory).Text("state") == "claim_pending" {
                    return 8
                }
            }
            let ready = Data.Load(directory)
            Overlaps.RequireDependencies(ready.Text("repo"), ready.Number("issue"))
            Worker.Execute(directory, options)
            PublicOutput.FailureCode = "command_failed"
            Submission.Commit(directory)
        }
        case "recover" {
            Correction.Recover(options)
        }
        case "overlaps" {
            Overlaps.Run(options)
        }
        case "checks" {
            return Checks.Run(options)
        }
        case "policy" {
            let repo = RepositoryIdentity.Repo(options.Need("repo"))
            let info = GitHub.Api("repos/" + repo)
            let value = Policy.Load(repo, J.Text(info, "default_branch")).Value
            if PublicOutput.Enabled {
                PublicOutput.ResultData = map[string, Object?]{"repo": repo, "policy": PublicOutput.Policy(value)}
            } else {
                Terminal.Json(value, "Repository policy")
            }
        }
        case "verify-pr" {
            let run = ReceiptVerification.Verify(RepositoryIdentity.Repo(options.Need("repo")), options.Number("pr"))
            PublicOutput.ResultData = J.Select(run.Element(), "repo,pr,pr_url,commit")
            Terminal.Message("PR receipt matches owner approval and policy. Model usage remains donor-reported.")
        }
        case "status" when options.Get("run") == "" {
            ContributionStatus.Run(options)
        }
        case "status" when !PublicOutput.Enabled {
            let summary = PublicOutput.RunSummary(Path.GetFullPath(options.Need("run")))
            summary["truncated"] = PublicOutput.Truncated
            PublicOutput.Next(options, "")
            Terminal.SavedRun(J.Parse(J.Write(summary)))
        }
    }
    if PublicOutput.Enabled && PublicOutput.RunDirectory != "" {
        PublicOutput.ResultData = PublicOutput.RunSummary(PublicOutput.RunDirectory)
    }
    return 0
}
