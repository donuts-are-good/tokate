package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO
import System.Text.Json
import System.Text.Json.Nodes

internal class DisposableVerificationChecks {
    shared {
        internal func All(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            File.WriteAllText(Path.Combine(flow.Upstream, ".gitignore"), ".env\ndonor-cache/\n")
            flow.Commit("Ignore donor private data")
            let sentinel = Path.Combine(flow.Temp.Root, "host-private")
            File.WriteAllText(sentinel, "host-secret")
            let build = "set -eu; test -f result.txt; test \"$$(cat .env)\" = donor-private; " +
                "test \"$$(cat donor-cache/data)\" = donor-cache; test ! -r " +
                sentinel +
                "; " +
                "test -r .git/config; if touch .git/verification-write; then exit 1; fi; " +
                "mkdir build-output; dd if=/dev/zero of=build-output/generated bs=1048576 count=2 2>/dev/null; " +
                "ln -s " +
                flow
                .Temp
                .Root +
                " build-output/host-link; ln -s / build-output/root-link; " +
                "printf changed-copy > .env; chmod 000 build-output; chmod 700 build-output; " +
                "printf useful-build-evidence"
            let second = "set -eu; test -s build-output/generated; test \"$$(cat .env)\" = changed-copy; " +
                "test ! -r build-output/host-link/host-private; " +
                "printf 'synthetic-%s-output' verifier; printf 'synthetic-%s-error' verifier >&2; " +
                "setsid /bin/sh -c 'while :; do printf +; echo beat >> heartbeat; sleep 0.05; done' </dev/null 2>/dev/null & " +
                "while [ ! -s heartbeat ]; do sleep 0.01; done; printf useful-test-evidence; " +
                "case $$(cat verify-outcome) in failure) exit 7;; failure23) exit 23;; " +
                "timeout|cancel|interrupt|terminate) sleep 120;; tracked) printf tampered > result.txt;; " +
                "*) chmod 000 build-output;; esac"
            flow.VerificationPolicy(build, second: second)
            flow.Approve()
            flow.Mode("disposable_verification")
            let storage = Path.Combine(flow.Temp.Root, "runtime-tmp")
            Directory.CreateDirectory(storage)
            flow.Temp.Env["TMPDIR"] = storage
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for mode in[]string{
                "success",
                "failure",
                "failure23",
                "timeout",
                "cancel",
                "interrupt",
                "terminate",
                "tracked"
            } {
                baseline.Restore()
                flow.Reload()
                flow.State["verify_outcome"] = JsonValue.Create(mode)
                flow.Save()
                let run = flow.Claim(seconds: mode == "timeout" ? "3": "30")
                let before = Directory.GetDirectories("/tmp", "tokate-workspace-*").Length
                let cancelled = mode == "cancel" || mode == "interrupt" || mode == "terminate"
                let result = cancelled ? Cancel(flow, run, mode == "terminate" ? "-TERM": "-INT", mode == "cancel"):
                flow.Call([]string{"work", "--run", run}, mode == "success" ? 0: 1)
                if mode == "failure" || mode == "failure23" || mode == "timeout" || mode == "cancel" {
                    Check.Contains(
                        result.Error + result.Output,
                        mode.StartsWith("failure") ? "Owner verification failed":
                        mode == "cancel" ? "cancelled": "Runtime limit reached"
                    )
                }
                Check.That(
                    !(result.Output + result.Error).Contains("synthetic-verifier-output"),
                    "Raw verifier output escaped"
                )
                Check.That(
                    Directory.GetDirectories("/tmp", "tokate-workspace-*").Length == before,
                    "Disposable verification workspace survived " + mode
                )
                Check.That(
                    Directory.GetFileSystemEntries(storage).Length == 0,
                    "Verifier runtime copies leaked: " + mode
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
                Check.That(
                    results.Count == 2 && Check.Text(results[0]?["exit_code"]) == "0",
                    "Prior passed check was lost"
                )
                let active = results[1] ?? throw Exception("Missing active check")
                let interrupted = mode == "timeout" || cancelled
                Check.That(
                    Check.Text(active["state"]) == (interrupted ? "interrupted": "completed"),
                    "Verifier lost terminal phase"
                )
                Check.That(
                    interrupted ? active["exit_code"] == nil:
                    Check.Text(active["exit_code"]) == (mode == "failure" ? "7": mode == "failure23" ? "23": "0"),
                    "Verifier fabricated or changed its exit code"
                )
                Check.That(
                    Check.Text(active["output"]).StartsWith("synthetic-verifier-output+") && Check.Text(
                        active["error"]
                    ) == "synthetic-verifier-error",
                    "Verifier lost partial evidence"
                )
                let output = Path.Combine(run, Check.Text(active["output_file"]))
                Check.That(
                    File.ReadAllText(output).StartsWith("synthetic-verifier-output+"),
                    "Raw stdout prefix was not flushed"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(run, Check.Text(active["error_file"]))) == "synthetic-verifier-error",
                    "Raw stderr prefix was not flushed"
                )
                TestProcess.HeartbeatStopped(output, 200, "Detached verifier survived: " + mode)
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
                if mode == "success" {
                    StorageAccounting(flow, run, status?["storage"])
                }
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
                "PASS disposable CLI verification preserves evidence and donor data, cleans runtime files, build output and detached descendants on success, failure, timeout and signals"
            )
        }

        private func StorageAccounting(flow NativeFixture, run string, before JsonNode?) {
            using let outside = Temp()
            let source = Path.Combine(outside.Root, "data")
            File.WriteAllText(source, "outside")
            let rootFile = Path.Combine(run, "size-probe")
            let checkoutFile = Path.Combine(run, "checkout/size-probe")
            let fileLink = Path.Combine(run, "size-file-link")
            let directoryLink = Path.Combine(run, "size-directory-link")
            try {
                File.WriteAllText(rootFile, "12345")
                File.WriteAllText(checkoutFile, "1234567")
                File.CreateSymbolicLink(fileLink, source)
                Directory.CreateSymbolicLink(directoryLink, outside.Root)
                let after = Check.Json(flow.Call([]string{"status", "--run", run, "--json"}).Output)["data"]?["storage"]
                Check.That(
                    Int64.Parse(Check.Text(after?["retained_bytes"])) == Int64.Parse(
                        Check.Text(before?["retained_bytes"])
                    ) +
                        12,
                    "Storage count followed links or lost regular files"
                )
                Check.That(
                    Int64.Parse(Check.Text(after?["checkout_bytes"])) == Int64.Parse(
                        Check.Text(before?["checkout_bytes"])
                    ) +
                        7,
                    "Checkout storage count changed scope"
                )
                Check.That(File.ReadAllText(source) == "outside", "Storage measurement changed linked data")
            } finally {
                File.Delete(rootFile)
                File.Delete(checkoutFile)
                File.Delete(fileLink)
                Directory.Delete(directoryLink)
            }
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
            flow.Call([]string{"recover", "--run", run, "--prepare"})
            let commit = CorrectionChecks.Correct(flow, run)
            CorrectionChecks.Recover(flow, run, commit)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Copy failure recovery repeated inference")
        }

        private func Cancel(flow NativeFixture, run string, signal string, terminal bool) Result {
            var exe = flow.Binary
            var args = []string{"work", "--run", run}
            if terminal {
                File.Copy(flow.Binary, Path.Combine(flow.Temp.Root, "tokate-verifier"))
                exe = "/usr/bin/script"
                args = []string{
                    "-q",
                    "-e",
                    "-c",
                    "echo $$$$ > verifier.pid; exec ./tokate-verifier work --run '" + run + "'",
                    "/dev/null"
                }
            }
            let info = TestProcess.StartInfo(exe, args, flow.Temp.Env, flow.Temp.Root)
            using let process = Process.Start(info) ?? throw Exception("Cannot start CLI cancellation fixture")
            try {
                process.StandardInput.Close()
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
                Check.Success(
                    TestProcess.Run(
                        "/usr/bin/kill",
                        []string{
                            signal,
                            terminal ? File.ReadAllText(Path.Combine(flow.Temp.Root, "verifier.pid")).Trim(): process
                                .Id
                                .ToString()
                        },
                        flow.Temp.Env
                    )
                )
                Check.That(process.WaitForExit(10000), "CLI verification cancellation did not stop")
                let result = Result{
                    Code: process.ExitCode,
                    Output: process.StandardOutput.ReadToEnd(),
                    Error: process.StandardError.ReadToEnd()
                }
                Check.That(terminal ? result.Code != 0: result.Code == 1, result.Output + result.Error)
                return result
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
            flow.Publish(run)
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
