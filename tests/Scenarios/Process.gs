package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Text.Json.Nodes

internal class ProcessChecks {
    shared {
        internal func All(binary string) {
            InputFailures(binary)
            Captures(binary)
            CaptureWriteFailure(binary)
            CaptureSafety(binary)
            AbruptStop(binary)
        }

        private func InputFailures(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Reload()
            (flow.State["issue"] ?? throw Exception("Missing issue"))["body"] = JsonValue.Create(
                "synthetic-large-task:" + String('x', 1024 * 1024)
            )
            flow.Save()
            flow.Approve()
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for outcome in[]string{"timeout", "cancel", "closed"} {
                baseline.Restore()
                let run = flow.Claim(seconds: outcome == "timeout" ? "1": "30")
                flow.Mode(outcome == "closed" ? "closed_input": "blocked_input")
                let result = outcome == "cancel" ? CancelInput(flow, run): flow.Call([]string{"work", "--run", run}, 1)
                Check.That(result.Code == 1, "Interrupted stdin became success")
                Check.Contains(
                    result.Error.ToLowerInvariant(),
                    outcome == "timeout" ? "runtime limit reached": (outcome == "cancel" ? "cancelled": "broken pipe")
                )
                let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                Check.That(
                    Check.Text(saved["failure_reason"]) == "inference_interrupted" &&
                        saved["inference_exit_code"] == nil &&
                        saved["turn_completed"] == nil &&
                        saved["usage"] == nil,
                    "Interrupted stdin fabricated completion"
                )
                Check.Contains(File.ReadAllText(Path.Combine(run, "events.jsonl")), "synthetic-blocked-prefix")
                Check.Contains(File.ReadAllText(Path.Combine(run, "stderr.log")), "synthetic-blocked-error")
                TestProcess.Collected(
                    File.ReadAllText(Path.Combine(flow.Bin, "child.pid")),
                    "Child survived interrupted stdin"
                )
                flow.Call([]string{"work", "--run", run}, 1)
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Interrupted stdin repeated inference")
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS CLI work stops blocked and closed prompt input on deadline, Ctrl+C and broken pipe without extra inference"
            )
        }

        private func CancelInput(flow NativeFixture, run string) Result {
            let info = TestProcess.StartInfo(flow.Binary, []string{"work", "--run", run}, flow.Temp.Env)
            using let process = Process.Start(info) ?? throw Exception("Cannot start input cancellation")
            process.StandardInput.Close()
            let output = Chan[string](1)
            let error = Chan[string](1)
            go TestProcess.Read(process.StandardOutput, output)
            go TestProcess.Read(process.StandardError, error)
            try {
                let child = Path.Combine(flow.Bin, "child.pid")
                let evidence = Path.Combine(run, "events.jsonl")
                var ready bool
                for i in 0 ... 1000 {
                    if File.Exists(child) && FileInfo(child).Length > 0 && File.Exists(evidence) && File.ReadAllText(
                        evidence
                    )
                        .Contains("synthetic-blocked-prefix") {
                        ready = true
                        break
                    }
                    select {
                        case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                    }
                }
                Check.That(ready, "Blocked-input capture did not become ready")
                Check.Success(TestProcess.Run("/usr/bin/kill", []string{"-INT", process.Id.ToString()}, flow.Temp.Env))
                Check.That(process.WaitForExit(10000), "Blocked-input cancellation did not finish")
                return Result{Code: process.ExitCode, Output: <-output, Error: <-error}
            } finally {
                if !process.HasExited {
                    process.Kill(true)
                    process.WaitForExit()
                }
            }
        }

        private func Captures(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for mode in[]string{"capture_prefix", "capture_scalar", "capture_unicode"} {
                baseline.Restore()
                flow.Mode(mode)
                Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "output was truncated")
                let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                Check.That(
                    Check.Text(saved["inference_exit_code"]) == "0" && Check.Text(saved["output_truncated"]) == "true",
                    "Drained overflow lost exit or truncation evidence"
                )
                Check.That(
                    Check.Text(saved["error_truncated"]) == (mode == "capture_unicode" ? "false": "true"),
                    "Per-stream truncation changed"
                )
                for name in mode == "capture_unicode" ? []string{"events.jsonl"}: []string{
                    "events.jsonl",
                    "stderr.log"
                } {
                    let text = File.ReadAllText(Path.Combine(run, name))
                    if mode == "capture_prefix" {
                        Check.That(
                            text.Length == 32 * 1024 * 1024 && text.EndsWith("ABC"),
                            "Capture contains a gap or tail"
                        )
                    } else if mode == "capture_scalar" {
                        Check.That(
                            text.Length == 32 * 1024 * 1024 - 1 && text[text.Length - 1] == 'x' && text.Substring(
                                8191,
                                2
                            ) == Char.ConvertFromUtf32(0x10400),
                            "Capture split a supplementary scalar"
                        )
                    } else {
                        Check.That(
                            text.Length == 32 * 1024 * 1024 && FileInfo(Path.Combine(run, name)).Length > text.Length,
                            "Capture limit changed from decoded characters to bytes"
                        )
                    }
                    Check.That(!text.Contains("after-cap-marker"), "Capture resumed after overflow")
                    Check.That(
                        File.GetUnixFileMode(Path.Combine(run, name)) == (
                            UnixFileMode.UserRead | UnixFileMode.UserWrite
                        ),
                        "Evidence file is not private"
                    )
                }
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Truncated inference retried")
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS CLI work drains capped stdout/stderr, keeps contiguous Unicode prefixes and refuses incomplete turns"
            )
        }

        private func CaptureSafety(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for mode in[]string{"existing", "link", "dangling", "directory"} {
                baseline.Restore()
                let sentinel = Path.Combine(flow.Temp.Root, "capture-sentinel")
                File.WriteAllText(sentinel, "synthetic-private-evidence")
                let path = Path.Combine(run, "events.jsonl")
                if mode == "existing" {
                    File.WriteAllText(path, "synthetic-existing-evidence")
                } else if mode == "directory" {
                    Directory.CreateDirectory(path)
                } else {
                    File.CreateSymbolicLink(path, mode == "link" ? sentinel: sentinel + "-missing")
                }
                let failed = flow.Call([]string{"work", "--run", run}, 1)
                Check.Contains(failed.Error, "events.jsonl")
                Check.That(
                    File.ReadAllText(sentinel) == "synthetic-private-evidence",
                    "Capture replaced private evidence"
                )
                Check.That(!File.Exists(sentinel + "-missing"), "Capture followed a dangling link")
                if mode == "existing" {
                    Check.That(
                        File.ReadAllText(path) == "synthetic-existing-evidence",
                        "Capture replaced existing evidence"
                    )
                }
                flow.NoInference()
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS CLI work refuses existing, linked, dangling and directory output evidence before inference"
            )
        }

        private func CaptureWriteFailure(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("capture_write_failure")
            let result = TestProcess.Run(
                "/bin/bash",
                []string{"-c", "trap '' XFSZ; ulimit -f 64; exec \"$1\" work --run \"$2\"", "fixture", binary, run},
                flow.Temp.Env
            )
            Check.That(result.Code == 1, "Capture-write failure became success")
            Check.Contains(result.Error.ToLowerInvariant(), "too large")
            let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
            Check.That(
                Check.Text(saved["failure_reason"]) == "inference_interrupted" && saved["inference_exit_code"] == nil,
                "Capture-write failure fabricated completion"
            )
            Check.That(
                FileInfo(Path.Combine(run, "events.jsonl")).Length <= 65536,
                "Capture exceeded the OS file-size limit"
            )
            TestProcess.Collected(
                File.ReadAllText(Path.Combine(flow.Bin, "child.pid")),
                "Child survived capture-write failure"
            )
            flow.NoPr()
            Console.WriteLine("PASS CLI capture-write failure retains evidence and collects descendants")
        }

        private func AbruptStop(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim(seconds: "30")
            flow.Mode("timeout")
            let info = ProcessStartInfo(binary)
            info.UseShellExecute = false
            info.Environment.Clear()
            for entry in flow.Temp.Env {
                info.Environment[entry.Key] = entry.Value
            }
            info.ArgumentList.Add("work")
            info.ArgumentList.Add("--run")
            info.ArgumentList.Add(run)
            using let process = Process.Start(info) ?? throw Exception("Cannot start abrupt CLI fixture")
            try {
                let output = Path.Combine(run, "events.jsonl")
                let error = Path.Combine(run, "stderr.log")
                var ready bool
                for i in 0 ... 1000 {
                    if File.Exists(output) && File.ReadAllText(output).Contains("partial-secret") && File.Exists(
                        error
                    ) &&
                        File
                        .ReadAllText(error).Contains("synthetic-partial-stderr-secret") {
                        ready = true
                        break
                    }
                    select {
                        case <- after(TimeSpan.FromMilliseconds(10.0)) { }
                    }
                }
                Check.That(ready, "CLI did not flush evidence before abrupt termination")
                process.Kill()
                process.WaitForExit()
                Check.Contains(File.ReadAllText(output), "partial-secret")
                Check.Contains(File.ReadAllText(error), "synthetic-partial-stderr-secret")
                let saved = Check.Json(File.ReadAllText(Path.Combine(run, "run.json")))
                Check.That(
                    Check.Text(saved["state"]) == "running" && saved["turn_completed"] == nil,
                    "Abrupt stop fabricated a terminal state"
                )
                flow.NoPr()
            } finally {
                if !process.HasExited {
                    process.Kill(true)
                    process.WaitForExit()
                }
                let child = Path.Combine(flow.Bin, "child.pid")
                if File.Exists(child) {
                    let identity = File.ReadAllText(child)
                    let pid = TestProcess.ResolveHostPid(identity)
                    if pid != "" && TestProcess.ResolveHostPid(identity) == pid {
                        TestProcess.Run("/usr/bin/kill", []string{"-KILL", pid}, flow.Temp.Env)
                    }
                }
            }
            Console.WriteLine("PASS abruptly terminated CLI retains flushed prefixes without claiming completion")
        }
    }
}
