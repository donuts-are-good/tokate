package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions

internal class ProgressChecks {
    shared {
        internal func All(binary string) {
            let baseline = Success(binary, false)
            Check.That(Success(binary, true) == baseline, "Progress changed remote request counts")
            Bounded(binary)
            for scenario in[]string{
                "inference_failure",
                "verification_failure",
                "publication_failure",
                "inference_timeout",
                "verification_timeout",
                "inference_cancel",
                "verification_cancel"
            } {
                Failure(binary, scenario)
            }
            for mode in[]string{"tty", "plain", "no_color", "dumb"} {
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

        private func Live(flow NativeFixture, run string, phase string, cancel bool = false) Result {
            let info = ProcessStartInfo(flow.Binary)
            info.UseShellExecute = false
            info.RedirectStandardOutput = true
            info.RedirectStandardError = true
            info.RedirectStandardInput = true
            info.Environment.Clear()
            for entry in flow.Temp.Env {
                info.Environment[entry.Key] = entry.Value
            }
            for arg in[]string{"work", "--run", run, "--json", "--plain", "--traffic"} {
                info.ArgumentList.Add(arg)
            }
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
                                Check.Contains(line, "s remaining")
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
                            throw Exception("No live heartbeat for " + phase)
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
            let next = publication ? "publish": (verification ? "recover": "status")
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
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("progress_delay")
            flow.Temp.Env["TERM"] = mode == "dumb" ? "dumb": "xterm-256color"
            if mode == "no_color" {
                flow.Temp.Env["NO_COLOR"] = ""
            }
            let command = "stty cols 80 rows 24; " +
                Quote(binary) +
                " work --run " +
                Quote(run) +
                (mode == "plain" ? " --plain --ascii": "")
            let timer = Stopwatch.StartNew()
            let result = TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                flow.Temp.Env
            )
            timer.Stop()
            Check.Success(result)
            Check.Contains(result.Output, "Inference:")
            Check.Contains(result.Output, "s remaining")
            Check.Contains(result.Output, "passed (exit 0)")
            let visible = Regex.Replace(result.Output, "\\x1b\\[[0-?]*[ -/]*[@-~]", "")
            Check.Contains(visible, "Run completed. Run: " + run)
            Check.Contains(visible, "Next: tokate status --run " + run + " --json")
            if mode == "tty" {
                let updates = result.Output.Split("\r\x1b[2KInference:").Length - 1
                Check.That(
                    updates >= 2 && updates <= Math.Ceiling(timer.Elapsed.TotalSeconds / 5) + 1,
                    "TTY progress did not use restrained updates"
                )
            } else {
                Check.That(!result.Output.Contains('\x1b'), "Plain/no-color progress contains escape codes")
            }
        }
    }
}
