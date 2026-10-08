package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO
import System.Text.Json

internal class DisposableVerificationChecks {
    shared {
        internal func All(binary string) {
            for mode in[]string{"success", "failure", "timeout", "interrupt", "terminate", "tracked"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                File.WriteAllText(Path.Combine(flow.Upstream, ".gitignore"), ".env\ndonor-cache/\n")
                flow.Commit("Ignore donor private data")
                let sentinel = Path.Combine(flow.Temp.Root, "host-private")
                File.WriteAllText(sentinel, "host-secret")
                let build = "set -eu; test -f result.txt; test \"$$(cat .env)\" = donor-private; " +
                    "test \"$$(cat donor-cache/data)\" = donor-cache; " +
                    "test ! -r " +
                    sentinel +
                    "; " +
                    "test -r .git/config; if touch .git/verification-write; then exit 1; fi; " +
                    "mkdir build-output; dd if=/dev/zero of=build-output/generated bs=1048576 count=2 2>/dev/null; " +
                    "ln -s " +
                    flow
                    .Temp
                    .Root +
                    " build-output/host-link; " +
                    "ln -s / build-output/root-link; " +
                    "printf changed-copy > .env; chmod 000 build-output; chmod 700 build-output; " +
                    "printf useful-build-evidence"
                let second = "set -eu; test -s build-output/generated; test \"$$(cat .env)\" = changed-copy; " +
                    "test ! -r build-output/host-link/host-private; printf useful-test-evidence; " +
                    (
                    mode == "failure" ? "exit 7": mode == "timeout" ? "sleep 10":
                    mode == "interrupt" || mode == "terminate" ? "sleep 120":
                    mode == "tracked" ? "printf tampered > result.txt": "chmod 000 build-output"
                )
                flow.VerificationPolicy(build, second: second)
                flow.Approve()
                let run = flow.Claim(seconds: mode == "timeout" ? "3": "30")
                flow.Mode("disposable_verification")
                let before = Directory.GetDirectories("/tmp", "tokate-workspace-*").Length
                if mode == "interrupt" || mode == "terminate" {
                    Cancel(flow, run, mode == "terminate" ? "-TERM": "-INT")
                } else {
                    flow.Call([]string{"work", "--run", run}, mode == "success" ? 0: 1)
                }
                Check.That(
                    Directory.GetDirectories("/tmp", "tokate-workspace-*").Length == before,
                    "Disposable verification workspace survived " + mode
                )
                let checkout = Path.Combine(run, "checkout")
                Check.That(
                    !Directory.Exists(Path.Combine(checkout, "build-output")),
                    "Build output retained in checkout"
                )
                Check.That(File.ReadAllText(Path.Combine(checkout, ".env")) == "donor-private", "Donor .env changed")
                Check.That(
                    File.ReadAllText(Path.Combine(checkout, "donor-cache/data")) == "donor-cache",
                    "Ignored donor data deleted"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(checkout, "result.txt")) == "Implemented acceptance criteria\n",
                    "Donor work changed"
                )
                Check.That(File.ReadAllText(sentinel) == "host-secret", "Cleanup touched host files")
                let evidence = File.ReadAllText(Path.Combine(run, "verification.json"))
                Check.Contains(evidence, "useful-build-evidence")
                Check.Contains(evidence, "useful-test-evidence")
                Check.That(!evidence.Contains("host-secret"), "Verification leaked host data")
                let results = Check.Json(evidence).AsArray()
                Check.That(results.Count == 2, "Sequential checks did not share their build workspace")
                if mode == "failure" {
                    Check.That(Check.Text(results[1]?["exit_code"]) == "7", "Failed check lost exact result")
                }
                if mode == "timeout" || mode == "interrupt" || mode == "terminate" {
                    Check.That(
                        Check.Text(results[1]?["state"]) == "interrupted" && results[1]?["exit_code"] == nil,
                        "Interrupted result fabricated success"
                    )
                }
                let status = Check.Json(flow.Call([]string{"status", "--run", run, "--json"}).Output)["data"]
                Check.That(
                    Int64.Parse(Check.Text(status?["storage"]?["retained_bytes"])) > 0,
                    "Status omitted retained run size"
                )
                Check.That(
                    Int64.Parse(Check.Text(status?["storage"]?["checkout_bytes"])) > 0,
                    "Status omitted checkout size"
                )
                Check.Contains(
                    Check.Text(status?["storage"]?["next_safe_cleanup"]),
                    mode == "success" ? "later amendment will no longer be available": "no-inference recovery"
                )
                if mode != "success" {
                    flow.NoPr()
                }
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Verification retried inference")
            }
            External(binary)
            Amendment(binary)
            CopyFailure(binary)
            Console.WriteLine(
                "PASS disposable CLI verification shares build output, preserves donor data and failure evidence, removes output on success/failure/interruption, and reports retained size"
            )
        }

        private func CopyFailure(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            let before = Directory.GetDirectories("/tmp", "tokate-workspace-*").Length
            let result = TestProcess.Run(
                "/usr/bin/bwrap",
                []string{
                    "--die-with-parent",
                    "--bind",
                    "/",
                    "/",
                    "--dev",
                    "/dev",
                    "--proc",
                    "/proc",
                    "--ro-bind",
                    "/bin/false",
                    "/usr/bin/cp",
                    "--",
                    binary,
                    "work",
                    "--run",
                    run
                },
                flow.Temp.Env
            )
            Check.That(result.Code == 1, "Unusable copier accepted verification")
            Check.Contains(result.Error, "Cannot copy the exact verification candidate")
            Check.That(
                Directory.GetDirectories("/tmp", "tokate-workspace-*").Length == before,
                "Failed copy left a workspace"
            )
            Check.That(
                File.ReadAllText(Path.Combine(run, "verification.json")) == "[]",
                "Copy failure lost verification evidence"
            )
            Check.That(File.Exists(Path.Combine(run, "checkout/result.txt")), "Copy failure deleted donor work")
            flow.NoPr()
            flow.Call([]string{"recover", "--run", run})
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Copy failure recovery repeated inference")
        }

        private func Cancel(flow NativeFixture, run string, signal string) {
            let info = ProcessStartInfo(flow.Binary)
            info.UseShellExecute = false
            info.RedirectStandardOutput = true
            info.RedirectStandardError = true
            info.Environment.Clear()
            for entry in flow.Temp.Env {
                info.Environment[entry.Key] = entry.Value
            }
            for word in[]string{"work", "--run", run} {
                info.ArgumentList.Add(word)
            }
            using let process = Process.Start(info) ?? throw Exception("Cannot start CLI cancellation fixture")
            try {
                var ready bool
                for i in 0 ... 1000 {
                    let path = Path.Combine(run, "verification.json")
                    if File.Exists(path) {
                        try {
                            let checks = Check.Json(File.ReadAllText(path)).AsArray()
                            if checks.Count == 2 {
                                let output = Path.Combine(run, Check.Text(checks[1]?["output_file"]))
                                ready = File.Exists(output) && File.ReadAllText(output).Contains("useful-test-evidence")
                            }
                        } catch (error JsonException) { }
                    }
                    if ready {
                        break
                    }
                    select {
                        case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                    }
                }
                Check.That(ready, "CLI verifier did not become ready for cancellation")
                Check.Success(TestProcess.Run("/usr/bin/kill", []string{signal, process.Id.ToString()}, flow.Temp.Env))
                Check.That(process.WaitForExit(5000), "CLI verification cancellation did not stop")
                Check.That(
                    process.ExitCode == 1,
                    process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd()
                )
            } finally {
                if !process.HasExited {
                    process.Kill(true)
                    process.WaitForExit()
                }
            }
        }

        private func External(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize()
            test.Flow.VerificationPolicy(
                "test -f result.txt; mkdir build-output; printf generated > build-output/data",
                second: "test -s build-output/data"
            )
            test.Flow.Approve()
            let claim = test.Claim()
            let run = test.Prepare()
            let commit = test.Candidate(claim)
            test.Flow.Call([]string{"external", "--run", run, "--commit", commit})
            Check.That(!Directory.Exists(Path.Combine(run, "checkout/build-output")), "External build output retained")
            Check.That(
                test.Flow.Git("-C", Path.Combine(run, "checkout"), "rev-parse", "HEAD") == commit,
                "Exact external head changed"
            )
            Check.That(
                test.Flow.Git("-C", Path.Combine(run, "checkout"), "status", "--porcelain") == "",
                "Exact external checkout changed"
            )
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                saved["verification"]?.AsArray().Count == 2 && Check.Text(saved["state"]) == "generated",
                "External checks lost exact results"
            )
            test.Flow.NoInference()
            test.Flow.NoPr()
        }

        private func Amendment(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy(
                "test -f result.txt; mkdir build-output; printf generated > build-output/data",
                second: "test -s build-output/data"
            )
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("disposable_verification")
            flow.Call([]string{"work", "--run", run})
            let checkout = Path.Combine(run, "checkout")
            Check.That(!Directory.Exists(Path.Combine(checkout, "build-output")), "Initial output retained")
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Reviewed correction\n")
            flow.Git("-C", checkout, "add", "result.txt")
            flow.DonorGit(checkout, "commit", "-m", "Review correction")
            let commit = flow.Git("-C", checkout, "rev-parse", "HEAD")
            flow.Call([]string{"amend", "--run", run, "--commit", commit, "--seconds", "30"})
            Check.That(!Directory.Exists(Path.Combine(checkout, "build-output")), "Amendment output retained")
            let amended = Check.Json(File.ReadAllText(Path.Combine(run, "amendments", commit, "run.json")))
            Check.That(amended["verification"]?.AsArray().Count == 2, "Amendment lost ordered results")
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Amendment repeated inference")
        }
    }
}
