package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.Globalization
import System.IO
import Tokate

internal class SuiteJob {
    internal var Name string = ""
    internal var Command[]string = []string{}
    internal var Seconds int32 = 1200
}

internal class SuiteResult {
    internal var Name string = ""
    internal var Result CommandResult = CommandResult()
    internal var Failure Exception?
    internal var Seconds float64
}

internal class SuiteReport {
    internal var Groups int32
    private let Original TextWriter = Console.Out

    internal func Output(text string) {
        Console.Write(text)
        for line in text.Split('\n') {
            if line.StartsWith("PASS ") {
                Groups++
            }
        }
    }

    internal func Serial() StringWriter {
        let output = StringWriter(CultureInfo.InvariantCulture)
        Console.SetOut(output)
        return output
    }

    internal func Finish(output StringWriter) {
        Console.SetOut(Original)
        Output(output.ToString())
        output.Dispose()
    }
}

internal class SuiteDriver {
    private let Checkout string
    private let Jobs[]SuiteJob
    private let Gate Chan[bool] = Chan[bool](1)
    private var Next int32
    private var Stopped bool
    private var Cancelled bool

    internal init(checkout string, jobs[]SuiteJob) {
        Checkout = checkout
        Jobs = jobs
        Gate <- true
    }

    private func Stop(cancelled bool = false) {
        <-Gate
        Stopped = true
        Cancelled = Cancelled || cancelled
        Gate <- true
    }

    private func OnCancel(sender Object?, event ConsoleCancelEventArgs) {
        event.Cancel = true
        Stop(true)
    }

    private func Work(results Chan[SuiteResult]) {
        while true {
            <-Gate
            let index = Next
            let admitted = !Stopped && index < Jobs.Length
            if admitted {
                Next++
            }
            Gate <- true
            if !admitted {
                results <- SuiteResult()
                return
            }
            let job = Jobs[index]
            let result = SuiteResult{Name: job.Name}
            let clock = Stopwatch.StartNew()
            try {
                result.Result = Verification.Run(Checkout, job.Command, true, job.Seconds)
                if result.Result.Code != 0 || result.Result.Truncated || result.Result.ReadFailed {
                    throw Exception("Suite " + job.Name + " failed with exit " + result.Result.Code.ToString())
                }
            } catch (error Exception) {
                if error is CommandInterrupted interrupted {
                    result.Result = interrupted.Result
                }
                if error is CommandInputInterrupted interruptedInput {
                    result.Result = interruptedInput.Result
                }
                result.Failure = error
                Stop()
            }
            result.Seconds = clock.Elapsed.TotalSeconds
            results <- result
        }
    }

    internal func Run(report SuiteReport? = nil) {
        let results = Chan[SuiteResult](2)
        let onCancel = ConsoleCancelEventHandler(OnCancel)
        Console.CancelKeyPress += onCancel
        var failure Exception? = nil
        var completed int32
        try {
            go Work(results)
            go Work(results)
            while completed < 2 {
                let result = <-results
                if result.Name == "" {
                    completed++
                    continue
                }
                if let output = report {
                    output.Output(result.Result.Output)
                    Console.Error.Write(result.Result.Error)
                    Console.WriteLine(
                        "Suite " + result.Name + ": " + result.Seconds.ToString("F3", CultureInfo.InvariantCulture) +
                            " seconds"
                    )
                }
                if let error = result.Failure {
                    Console.Error.WriteLine(error.Message)
                    if failure == nil {
                        failure = error
                    }
                }
            }
        } finally {
            Console.CancelKeyPress -= onCancel
        }
        if Cancelled {
            throw Exception("Suite verification cancelled")
        }
        if let error = failure {
            throw error
        }
    }

    shared {
        internal func Select(binary string, name string) {
            switch name {
                case "SynchronizationV2" {
                    SynchronizationChecks.All(binary, "v2")
                }
                case "SynchronizationV2First" {
                    SynchronizationChecks.All(binary, "v2", 1)
                }
                case "SynchronizationV2Second" {
                    SynchronizationChecks.All(binary, "v2", 2)
                }
                case "SynchronizationV1" {
                    SynchronizationChecks.All(binary, "v1")
                }
                case "Native" {
                    NativeFlow.All(binary, parallel: true)
                }
                case "Coordination" {
                    CoordinationFlow.All(binary)
                    CommandTrafficChecks.All(binary)
                }
                case "Correction" {
                    CorrectionChecks.All(binary)
                }
                case "Amendment" {
                    AmendmentFlow.All(binary)
                }
                case "Decree" {
                    DecreeFlow.All(binary)
                }
                case "Overlaps" {
                    OverlapChecks.All(binary)
                }
                case "Preparation" {
                    PreparationChecks.All(binary)
                }
                case "Targets" {
                    TargetBranches.All(binary)
                }
                default {
                    throw Exception("Unknown suite selector: " + name)
                }
            }
        }

        internal func All(project string, binary string) {
            let clock = Stopwatch.StartNew()
            let report = SuiteReport()
            try {
                let serial = report.Serial()
                try {
                    ProcessChecks.All()
                    ProtectedPathChecks.All()
                    CliDiscovery.All(binary)
                    Diagnostics.All(binary)
                    DonorSelectionChecks.All(binary)
                    VerificationChecks.All()
                    SuiteChecks.All()
                    for name in NativeFlow.SerialGroups {
                        NativeFlow.All(binary, name)
                    }
                } finally {
                    report.Finish(serial)
                }
                using let data = Temp()
                let published = Path.Combine(data.Root, ".git/data")
                Directory.CreateDirectory(Path.Combine(published, "artifacts/linux-x64"))
                Directory.CreateDirectory(Path.Combine(published, "artifacts/tests"))
                File.Copy(binary, Path.Combine(published, "artifacts/linux-x64/tokate"))
                File.Copy(
                    Environment.ProcessPath ?? throw Exception("Missing test executable"),
                    Path.Combine(published, "artifacts/tests/tokate-tests")
                )
                File.Copy(Path.Combine(project, "global.json"), Path.Combine(published, "global.json"))
                let jobs = []SuiteJob{
                    Job("SynchronizationV2First"),
                    Job("SynchronizationV1"),
                    Job("SynchronizationV2Second"),
                    Job("Native"),
                    Job("Coordination"),
                    Job("Correction"),
                    Job("Amendment"),
                    Job("Decree"),
                    Job("Targets"),
                    Job("Preparation"),
                    Job("Overlaps")
                }
                SuiteDriver(data.Root, jobs).Run(report)
                let installer = report.Serial()
                try {
                    Installer.Lifecycle(project, binary)
                    Console.WriteLine(
                        "PASS installer lifecycle, failed updates, credential boundary, and offline removal"
                    )
                    Installer.ShellDetection(project, binary)
                    Installer.RefuseInvalidPath(project)
                    Console.WriteLine("PASS installer rejects symlink and directory replacement")
                    Installer.RefuseUnsupportedPlatform(project, binary)
                    Console.WriteLine(
                        "PASS unsupported architecture/libc refusal preserves installations and permits removal"
                    )
                } finally {
                    report.Finish(installer)
                }
            } finally {
                Console.WriteLine(
                    "Verification: " + report.Groups.ToString() +
                        " groups passed; " +
                        clock
                        .Elapsed
                        .TotalSeconds
                        .ToString("F3", CultureInfo.InvariantCulture) +
                        " seconds elapsed"
                )
            }
        }

        private func Job(name string) SuiteJob -> SuiteJob{
            Name: name,
            Command: []string{
                "/bin/sh",
                "-c",
                "cd .git/data && exec artifacts/tests/tokate-tests --suite \"$$1\"",
                "suite",
                name
            }
        }
    }
}
