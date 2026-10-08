package TokateTests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class ReserveChecks {
    shared {
        internal func All(binary string) {
            Invalid(binary)
            let completed = Chan[Exception?](2)
            go ReserveChecks.Version(binary, 1, completed)
            go ReserveChecks.Version(binary, 2, completed)
            var failure Exception? = nil
            for i in 0 ... 2 {
                let error = <-completed
                failure = failure ?? error
            }
            if let error = failure {
                throw error
            }
            NewWork(binary)
            Legacy(binary)
            LowerLimit(binary)
            Recovery(binary)
        }

        private func Version(binary string, version int32, completed Chan[Exception?]) {
            var failure Exception? = nil
            try {
                using let test = CoordinationFixture(binary)
                let run = Prepare(test, version)
                using let baseline = FixtureSnapshot(test.Flow.Temp.Root)
                for mode in[]string{"success", "timeout", "completed_timeout", "slow_candidate", "empty", "workflow"} {
                    baseline.Restore()
                    test.Flow.Reload()
                    Managed(test.Flow, run, mode)
                }
            } catch (error Exception) {
                failure = error
            }
            completed <- failure
        }

        private func Invalid(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            for reserve in[]string{"0", "-1", "1.5", "bad", "2147483648", "30", "31", "+1", " 1", "1\n"} {
                flow.Claim(reserve: reserve, code: 1)
            }
            flow.Claim(seconds: "3601", reserve: "1", code: 1)
            Check.That(!Directory.Exists(Path.Combine(flow.Temp.Root, "runs")), "Invalid reserve wrote a claim")
            flow.Reload()
            Check.That(
                flow.Git(
                    "-C",
                    Path.Combine(flow.Bin, "fork"),
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/heads/tokate"
                ) == "",
                "Invalid reserve wrote claim refs"
            )
            flow.NoInference()
            for command in[]string{"external", "amend", "recover"} {
                Check.Contains(
                    flow.Call([]string{command, "--run", flow.Temp.Root, "--verification-reserve", "1"}, 1).Error,
                    "Unknown option for " + command + ": --verification-reserve"
                )
            }
            Check.Contains(
                flow.Call([]string{"work", "--run", flow.Temp.Root, "--verification-reserve", "1"}, 1).Error,
                "--run conflicts with --verification-reserve"
            )
            using let v2 = CoordinationFixture(binary)
            v2.Initialize()
            v2.Claim()
            v2.Prepare(reserve: "1", code: 1)
            File.WriteAllText(
                v2.Tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            for reserve in[]string{"0", "bad", "30", "31"} {
                v2.Prepare("tokate", code: 1, reserve: reserve)
            }
            Check.That(!Directory.Exists(Path.Combine(v2.Flow.Temp.Root, "runs")), "Invalid v2 allocation wrote a run")
            v2.Flow.NoInference()
        }

        private func Prepare(v2 CoordinationFixture, version int32) string {
            let flow = v2.Flow
            if version == 1 {
                flow.Initialize()
            } else {
                v2.Initialize(false)
            }
            flow.VerificationPolicy("sleep 3; test -f result.txt", second: "sleep 1; test -f result.txt")
            flow.Approve()
            var run string
            if version == 1 {
                run = flow.Claim(seconds: "8", reserve: "2")
            } else {
                v2.Claim()
                File.WriteAllText(
                    v2.Tools,
                    "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
                )
                run = v2.Prepare("tokate", seconds: "8", reserve: "2")
            }
            return run
        }

        private func Managed(flow NativeFixture, run string, mode string) {
            let before = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(before["seconds"]) == "8" && Check.Text(before["verification_reserve"]) == "2",
                "Allocation not saved"
            )
            flow.Mode(mode == "success" ? "": mode)
            let result = flow.Call([]string{"work", "--run", run}, mode == "success" ? 0: 1)
            flow.Reload()
            let elapsed = Stopwatch.GetElapsedTime(Int64.Parse(Check.Text(flow.State["exec_start"])))
            Check.Contains(result.Error, "total allowance 8s, coding allowance 6s, verification reserve 2s")
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.Contains(
                Check.Text(flow.State["prompts"]?[0]),
                "total allowance 8s, coding allowance 6s, verification reserve 2s"
            )
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Reserve launched more than one inference")
            if mode == "success" {
                Check.That((saved["verification"]?.AsArray().Count ?? 0) == 2, "Original checks did not all run")
                Check.That(elapsed.TotalSeconds >= 4.0, "Unused coding time was not available to verification")
                return
            }
            Check.That(Check.Text(saved["state"]) == "failed", "Failure became success")
            Check.That(
                !File.Exists(Path.Combine(run, "verification.json")),
                "Verification ran after coding/candidate failure"
            )
            flow.NoPr()
            if mode == "timeout" || mode == "completed_timeout" {
                Check.That(elapsed.TotalSeconds >= 5.5, "Coding allowance expired early")
                Check.That(
                    saved["turn_completed"] == nil && saved["usage"] == nil && saved["inference_exit_code"] == nil,
                    "Timeout fabricated completion"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(run, "checkout/partial.txt")) == "partial-edit",
                    "Partial checkout lost"
                )
                Check.Contains(File.ReadAllText(Path.Combine(run, "events.jsonl")), "partial-secret")
                Check.Contains(File.ReadAllText(Path.Combine(run, "stderr.log")), "synthetic-partial-stderr-secret")
                let pid = File.ReadAllText(Path.Combine(flow.Bin, "child.pid"))
                TestProcess.Collected(pid, "Timeout descendant survived")
                flow.Call([]string{"recover", "--run", run}, 1)
                flow.Call([]string{"publish", "--run", run}, 1)
            } else {
                Check.That(
                    Check.Text(saved["turn_completed"]) == "true" && Check.Text(
                        saved["failure_stage"]
                    ) == "candidate_validation",
                    "Actual candidate outcome lost"
                )
                if mode == "slow_candidate" {
                    Check.That(
                        elapsed.TotalSeconds >= 5.5 && elapsed.TotalSeconds < 7.0,
                        "Candidate overhead consumed reserve"
                    )
                }
            }
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Failed reserve run retried inference")
            flow.NoPr()
        }

        private func Legacy(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            let path = Path.Combine(run, "run.json")
            let saved = Check.Json(File.ReadAllText(path))
            Check.That(saved["verification_reserve"] == nil, "Omission inferred a reserve")
            saved.AsObject().Remove("selection")
            File.WriteAllText(path, saved.ToJsonString())
            let status = Check.Json(flow.Call([]string{"status", "--run", run, "--json"}).Output)["data"]
            Check.That(
                Check.Text(status?["coding_seconds"]) == "30" && Check.Text(status?["verification_reserve"]) == "0",
                "Legacy allocation changed"
            )
            flow.Call([]string{"work", "--run", run})
            Check.That(
                Check.Json(File.ReadAllText(path))["verification_reserve"] == nil,
                "Legacy run acquired an allocation"
            )
        }

        private func LowerLimit(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            let path = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(path))
            policy["max_seconds"] = JsonValue.Create(5)
            File.WriteAllText(path, policy.ToJsonString())
            flow.Commit("Lower owner total")
            flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, "main")
            flow.Approve()
            let args = []string{
                "claim",
                "--repo",
                "owner/project",
                "--issue",
                "1",
                "--model",
                "gpt-6.1-sol",
                "--effort",
                "high",
                "--verification-reserve",
                "5",
                "--runs",
                Path.Combine(flow.Temp.Root, "runs")
            }
            flow.Call(args, 1)
            flow.Claim(seconds: "6", reserve: "1", code: 1)
            Check.That(!Directory.Exists(Path.Combine(flow.Temp.Root, "runs")), "Lower owner limit wrote invalid claim")
            flow.NoInference()
            args[Array.IndexOf(args, "--verification-reserve") + 1] = "1"
            let result = flow.Call(args)
            let run = result.Output.Substring(result.Output.LastIndexOf("Run: ") + 5).Trim()
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(Check.Text(saved["seconds"]) == "5", "Reserve changed default total")
            flow.Call([]string{"work", "--run", run})
        }

        private func Recovery(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy("test -f result.txt", second: "test ! -f .tokate-scratch/cache.json")
            flow.Approve()
            let run = flow.Claim(seconds: "30", reserve: "20")
            flow.Mode("verification_recovery")
            flow.Call([]string{"work", "--run", run}, 1)
            flow.Mode("")
            flow.Call([]string{"recover", "--run", run, "--seconds", "5"})
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Recovery launched inference")
            Check.That(
                Check.Text(Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))["verification_reserve"]) == "20",
                "Recovery changed original allocation"
            )
        }

        private func NewWork(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let result = flow.Call(
                []string{
                    "work",
                    "--repo",
                    "owner/project",
                    "--issue",
                    "1",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "high",
                    "--seconds",
                    "10",
                    "--verification-reserve",
                    "3",
                    "--runs",
                    Path.Combine(flow.Temp.Root, "runs"),
                    "--json"
                }
            )
            let saved = Check.Json(result.Output)["data"]
            Check.That(
                Check.Text(saved?["seconds"]) == "10" && Check.Text(saved?["coding_seconds"]) == "7" && Check.Text(
                    saved?["verification_reserve"]
                ) == "3",
                "Structured allocation missing"
            )
        }
    }
}
