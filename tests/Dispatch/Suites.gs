package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO

internal class SuiteJob {
    internal var Name string = ""
    internal var Command[]string = []string{}
    internal var Seconds int32 = 1200
}

internal class SuiteResult {
    internal var Name string = ""
    internal var Result Result = Result()
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
                result.Result = RunJob(job)
                if result.Result.Code != 0 {
                    throw Exception("Suite " + job.Name + " failed with exit " + result.Result.Code.ToString())
                }
            } catch (error Exception) {
                result.Failure = error
                Stop()
            }
            result.Seconds = clock.Elapsed.TotalSeconds
            results <- result
        }
    }

    private func RunJob(job SuiteJob) Result {
        let args = List[string]{
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--cap-drop",
            "ALL"
        }
        for path in[]string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"} {
            if Directory.Exists(path) {
                args.AddRange([]string{"--ro-bind", path, path})
            }
        }
        for path in[]string{
            "/etc/ld.so.cache",
            "/etc/nsswitch.conf",
            "/etc/hosts",
            "/etc/resolv.conf",
            "/etc/ssl/certs/ca-certificates.crt"
        } {
            if File.Exists(path) {
                args.AddRange([]string{"--ro-bind", path, path})
            }
        }
        args.AddRange(
            []string{
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--tmpfs",
                "/var/tmp",
                "--bind",
                Checkout,
                Checkout,
                "--ro-bind",
                Path.Combine(Checkout, ".git"),
                Path.Combine(Checkout, ".git"),
                "--chdir",
                Checkout,
                "--"
            }
        )
        args.AddRange(job.Command)
        return TestProcess.Run(
            "/usr/bin/bwrap",
            args.ToArray(),
            Dictionary[string, string]{
                ["PATH"] = "/usr/local/bin:/usr/bin:/bin",
                ["HOME"] = "/tmp",
                ["LANG"] = "C.UTF-8",
                ["GIT_NO_REPLACE_OBJECTS"] = "1",
                ["GIT_GRAFT_FILE"] = "/dev/null"
            },
            seconds: job.Seconds
        )
    }

    internal func Run(report SuiteReport? = nil) {
        let workers = Math.Min(8, Math.Min(Environment.ProcessorCount, Jobs.Length))
        let results = Chan[SuiteResult](workers)
        let onCancel = ConsoleCancelEventHandler(OnCancel)
        Console.CancelKeyPress += onCancel
        var failure Exception? = nil
        var completed int32
        try {
            for worker in 0 ... workers {
                go Work(results)
            }
            while completed < workers {
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
