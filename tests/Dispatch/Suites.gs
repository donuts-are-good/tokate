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
}
