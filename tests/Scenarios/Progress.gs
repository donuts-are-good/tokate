package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Text.Json.Nodes
import System.Text.RegularExpressions

internal class ProgressChecks {
    shared {
        internal func All(binary string, filter string = "") {
            if filter == "Unlimited" {
                Unlimited(binary)
                return
            }
            if filter == "Tty" {
                for mode in[]string{"tty", "no_color", "plain", "dumb", "cancel"} {
                    Tty(binary, mode)
                }
                return
            }
            let baseline = Success(binary, false)
            Check.That(Success(binary, true) == baseline, "Progress changed remote request counts")
            if filter == "Json" {
                Console.WriteLine("PASS structured progress keeps transcripts private and preserves request counts")
                return
            }
            Bounded(binary)
            Unlimited(binary)
            for scenario in[]string{
                "inference_failure",
                "verification_failure",
                "inference_timeout",
                "verification_timeout",
                "inference_cancel",
                "verification_cancel"
            } {
                Failure(binary, scenario)
            }
            for mode in[]string{"tty", "plain", "no_color", "dumb", "cancel"} {
                Tty(binary, mode)
            }
            Console.WriteLine(
                "PASS local progress: live phases, saved allowances, command results, private logs, bounded stderr, JSON, TTY/plain/no-color, failures, deadlines, cancellation and unchanged requests"
            )
        }

        private func Read(reader StreamReader, lines Chan[string], completed Chan[string]) {
            let text = StringBuilder()
            var line string?
            while (line = reader.ReadLine()) != nil {
                let value = line ?? ""
                text.AppendLine(value)
                lines <- value
            }
            completed <- text.ToString()
        }

        private func Live(
            flow NativeFixture,
            run string,
            phase string,
            cancel bool = false,
            unlimited bool = false
        ) Result {
            let info = TestProcess.StartInfo(
                flow.Binary,
                []string{"work", "--run", run, "--json", "--plain", "--traffic"},
                flow.Temp.Env
            )
            using let process = Process.Start(info) ?? throw Exception("Cannot start progress fixture")
            process.StandardInput.Close()
            let stdout = Chan[string](1)
            let stderr = Chan[string](1)
            let lines = Chan[string](256)
            go TestProcess.Read(process.StandardOutput, stdout)
            go ProgressChecks.Read(process.StandardError, lines, stderr)
            var observed bool
            var initialRequests int32 = -1
            try {
                using let deadline = after(TimeSpan.FromSeconds(25))
                while !observed {
                    select {
                        case let line = <- lines {
                            if line.StartsWith(phase + ":") {
                                Check.That(!process.HasExited, "Progress arrived only after completion")
                                Check.Contains(line, "s elapsed,")
                                Check.Contains(line, unlimited ? "no time limit": "s remaining")
                                flow.Reload()
                                let requests = flow.State["api_calls"]?.AsArray().Count ?? 0
                                if initialRequests < 0 {
                                    initialRequests = requests
                                } else {
                                    Check.That(requests == initialRequests, "Heartbeat made remote requests")
                                    observed = true
                                }
                                if phase == "Inference" {
                                    Check.Contains(line, "; total ")
                                }
                            }
                        }
                        case <- deadline {
                            let diagnostic = process.HasExited ? <-stderr: "process still running"
                            throw Exception("No live heartbeat for " + phase + ": " + diagnostic)
                        }
                    }
                }
                if cancel {
                    Check.Success(
                        TestProcess.Run("/usr/bin/kill", []string{"-INT", process.Id.ToString()}, flow.Temp.Env)
                    )
                }
                Check.That(process.WaitForExit(30000), "Progress fixture failed to stop")
            } finally {
                if !process.HasExited {
                    process.Kill(true)
                    process.WaitForExit()
                }
            }
            let result = Result{Code: process.ExitCode, Output: <-stdout, Error: <-stderr}
            Check.That(
                result.Error.Split('\n').Length <= 40 && result.Error.Length < 16000,
                "Unbounded progress output"
            )
            Check.That(
                !result.Error.Contains('\x1b') && !result.Error.Contains('\r'),
                "Redirected progress contains terminal controls"
            )
            Check.Contains(result.Error, "Run: " + run)
            Check.Contains(result.Error, "Saved artifacts: run.json")
            Check.Contains(result.Error, "Next: tokate status --run")
            return result
        }

        private func Success(binary string, delayed bool) string {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy(
                "sleep 6; printf '%s' private- verifier-marker; test -f result.txt",
                second: "test -f result.txt"
            )
            flow.Approve()
            let run = flow.Claim(seconds: "30", reserve: "15")
            flow.Mode(delayed ? "progress_delay": "")
            flow.ResetTraffic()
            let result = delayed ? Live(flow, run, "Inference"): Live(flow, run, "Owner verification 1")
            Check.Envelope(result, "work", "ok")
            Check.Contains(result.Error, "Verification 1:")
            Check.Contains(result.Error, "Verification 2:")
            Check.That(result.Error.Split("passed (exit 0)").Length == 3, "Missing individual command results")
            Check.That(!result.Output.Contains("private-verifier-marker"), "Raw verification output leaked into JSON")
            let evidence = Check.Json(File.ReadAllText(Path.Combine(run, "verification.json")))
            let outputFile = Check.Text(evidence[0]?["output_file"])
            Check.That(
                File.ReadAllText(Path.Combine(run, outputFile)) == "private-verifier-marker",
                "Private verifier log missing"
            )
            Check.That(!result.Error.Contains("private-verifier-marker"), "Raw verifier output leaked into progress")
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Progress retried inference")
            let counts = Dictionary[string, int32]()
            for call in flow.State["api_calls"]?.AsArray() ?? throw Exception("Missing requests") {
                let key = Check.Text(call["method"]) + ":" + Check.Text(call["status"])
                counts[key] = counts.ContainsKey(key) ? counts[key] + 1: 1
            }
            let keys = List[string](counts.Keys)
            keys.Sort()
            let signature = StringBuilder()
            for key in keys {
                signature.Append(key + "=" + counts[key].ToString() + ";")
            }
            return signature.ToString()
        }

        private func Bounded(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim(seconds: "30", reserve: "5")
            flow.Mode("progress_delay")
            flow.State["progress_delay_seconds"] = System.Text.Json.Nodes.JsonValue.Create(16)
            flow.Save()
            let result = Live(flow, run, "Inference")
            Check.Envelope(result, "work", "ok")
            let samples = Regex.Matches(
                result.Error,
                "Inference: ([0-9]+)s elapsed, ([0-9]+)s remaining; total ([0-9]+)s left"
            )
            let phases = result.Error.Split("Inference:").Length
            Check.That(
                samples.Count >= 2 && samples.Count <= 3 && phases == samples.Count + 1,
                "Plain progress did not use bounded exponential intervals"
            )
            var elapsed int32 = -1
            var remaining int32 = 26
            for sample in samples {
                let current = Int32.Parse(sample.Groups[1].Value)
                let coding = Int32.Parse(sample.Groups[2].Value)
                let total = Int32.Parse(sample.Groups[3].Value)
                Check.That(
                    current > elapsed && coding < remaining && Math.Abs(current + coding - 25) <= 1 && Math.Abs(
                        current + total - 30
                    ) <= 1,
                    "Progress changed or reset the saved allowances"
                )
                elapsed = current
                remaining = coding
            }
            Check.That(elapsed > 0, "Progress elapsed time did not advance")
        }

        private func Unlimited(binary string) {
            using let test = CoordinationFixture(binary)
            test.Initialize(approve: false)
            let flow = test.Flow
            flow.VerificationPolicy("test -f result.txt; if test -f verify-outcome; then sleep 120; fi")
            File.WriteAllText(
                test.Tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            flow.Approve()
            test.Claim()
            test.Prepare("tokate", 1, reserve: "8", unlimited: true)
            flow.NoInference()
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["allow_unlimited"] = JsonValue.Create(true)
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Owner permits optional unlimited coding")
            flow.Approve()
            test.Claim()
            flow.Temp.Env["TERM"] = "dumb"
            let guided = TestTerminal.Pty(
                binary,
                []string{
                    "work",
                    "owner/project",
                    "--issue",
                    "1",
                    "--harness",
                    "codex",
                    "--model",
                    "gpt-6.1-sol",
                    "--effort",
                    "high"
                },
                flow.Temp,
                80,
                "unlimited\n1\nq\n"
            )
            Check.That(guided.Code == 1, guided.Output + guided.Error)
            Check.Contains(guided.Output, "Review donation")
            Check.Contains(guided.Output, "No time limit")
            Check.Contains(guided.Output, "No time limit is available for coding.")
            Check.Contains(guided.Output, "Timed donations and verification are limited to 60 minutes.")
            flow.NoInference()
            Check.Contains(
                flow.Call(
                    []string{
                        "work",
                        "--unlimited",
                        "--seconds",
                        "30",
                        "--verification-reserve",
                        "8",
                        "--non-interactive"
                    },
                    1
                )
                    .Error,
                "excludes --seconds"
            )
            test.Prepare("external", 1, reserve: "8", unlimited: true)
            test.Prepare("tokate", 1, unlimited: true)
            let run = test.Prepare("tokate", reserve: "8", unlimited: true)
            let status = Check.Envelope(flow.Call([]string{"status", "--run", run, "--json"}), "status", "ok")
            Check.That(
                Check.Text(status["data"]?["unlimited"]) == "true" && status["data"]?["coding_seconds"] == nil,
                "Status invented a finite coding limit"
            )
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for mode in[]string{"complete", "cancel", "verification"} {
                baseline.Restore()
                flow.Mode(mode == "cancel" ? "timeout": "progress_delay")
                flow.State["progress_delay_seconds"] = JsonValue.Create(10)
                if mode == "verification" {
                    flow.State["verify_outcome"] = JsonValue.Create("timeout")
                }
                flow.Save()
                let result = Live(flow, run, "Inference", mode == "cancel", true)
                let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                Check.That(result.Code == (mode == "complete" ? 0: 1), result.Output + result.Error)
                Check.That(
                    Check.Text(saved["state"]) == (mode == "complete" ? "generated": "failed"),
                    "Unlimited work returned the wrong state"
                )
                if mode == "cancel" {
                    Check.That(
                        saved["turn_completed"] == nil && Check.Text(
                            saved["failure_reason"]
                        ) == "inference_interrupted",
                        "Stopped unlimited work fabricated completion"
                    )
                    TestProcess.Collected(
                        File.ReadAllText(Path.Combine(flow.Bin, "child.pid")),
                        "Unlimited cancellation left a descendant"
                    )
                } else {
                    Check.That(
                        Check.Text(saved["turn_completed"]) == "true",
                        "Verification allowance stopped unlimited coding"
                    )
                    flow.Reload()
                    Check.Contains(Check.Text(flow.State["prompts"]?[0]), "unlimited coding time")
                    if mode == "verification" {
                        Check.That(
                            Check.Text(saved["failure_reason"]) == "verification_failed",
                            "Unlimited coding removed the verification deadline"
                        )
                    } else {
                        Check.That(
                            Check.Text(saved["verification"]?[0]?["exit_code"]) == "0",
                            "Independent verification did not receive its own allowance"
                        )
                    }
                }
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Unlimited work retried inference")
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS unlimited owner consent, saved status, delayed coding completion, cancellation cleanup and bounded independent verification"
            )
        }

        private func Failure(binary string, scenario string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            let inference = scenario.StartsWith("inference_")
            let verification = scenario.StartsWith("verification_")
            let publication = scenario == "publication_failure"
            let timeout = scenario.EndsWith("timeout")
            let cancel = scenario.EndsWith("cancel")
            var verifier = verification ? "sleep 120; test -f result.txt": "test -f result.txt"
            if scenario == "verification_failure" {
                verifier = "sleep 6; exit 23"
            }
            flow.VerificationPolicy(verifier)
            flow.Approve()
            let run = flow.Claim(seconds: timeout ? "8": "30", reserve: timeout ? "1": "15")
            let mode = scenario == "inference_failure" ? "model_failure": (
                inference ? "timeout": (publication ? "push_fail": "")
            )
            flow.Mode(mode)
            let phase = inference ? "Inference": "Owner verification 1"
            let live = timeout || cancel || scenario == "verification_failure"
            let result = live ? Live(flow, run, phase, cancel):
            flow.Call([]string{"work", "--run", run, "--json", "--plain"}, 1)
            let code = inference ? "inference_failed": (verification ? "verification_failed": "command_failed")
            let failedPhase = publication ? "Publication": (inference ? "Inference": "Verification")
            let next = "status"
            Check.Envelope(result, "work", "error", code)
            Check.Contains(result.Error, failedPhase + " failed (" + code + ")")
            Check.Contains(result.Error, "Next: tokate " + next)
            if scenario == "verification_failure" {
                Check.Contains(result.Error, "failed (exit 23)")
            }
            Check.That(
                !result.Error.Contains("synthetic-partial-stderr-secret") && !result.Output.Contains("partial-secret"),
                "Interrupted raw output leaked"
            )
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Failure retried inference")
            flow.NoPr()
            let child = Path.Combine(flow.Bin, "child.pid")
            if File.Exists(child) {
                TestProcess.Collected(File.ReadAllText(child), "Cancellation or timeout left a descendant")
            }
        }

        private func Quote(value string) string -> "'" + value.Replace("'", "'\"'\"'") + "'"

        private func Tty(binary string, mode string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy("printf 'live-verification-output\\n'; sleep 1; test -f result.txt")
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("progress_delay")
            flow.Temp.Env["TERM"] = mode == "dumb" ? "dumb": "xterm-256color"
            if mode == "no_color" {
                flow.Temp.Env["NO_COLOR"] = ""
            }
            if mode == "tty" || mode == "no_color" || mode == "cancel" {
                let script = Path.Combine(flow.Temp.Root, "donation-view.py")
                File.WriteAllText(script, TestResources.Template("donation-view.py"))
                let result = TestProcess.Run("python3", []string{script, binary, run, mode}, flow.Temp.Env)
                Check.Success(result)
                Console.Write(result.Output)
                return
            }
            let command = "stty cols 80 rows 24; " +
                Quote(binary) +
                " work --run " +
                Quote(run) +
                (mode == "plain" ? " --plain --ascii": "")
            let result = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env
            )
            Check.Success(result)
            Check.Contains(result.Output, "Inference:")
            Check.Contains(result.Output, "s remaining")
            Check.Contains(result.Output, "passed (exit 0)")
            let visible = Regex.Replace(result.Output, "\\x1b\\[[0-?]*[ -/]*[@-~]", "")
            Check.Contains(visible, "Run completed. Run: " + run)
            Check.Contains(visible, "Next: tokate status --run " + run + " --json")
            Check.That(!result.Output.Contains('\x1b'), "Plain progress contains escape codes")
        }
    }
}
