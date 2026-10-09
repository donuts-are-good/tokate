package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Json.Nodes

internal partial class Fixture {
    internal func Git(repo string, args[]string, input string? = nil) string {
        let all = List[string]{"-C", Path.Combine(Root, repo)}
        all.AddRange(args)
        return Check.Success(TestProcess.Run("/usr/bin/git", all.ToArray(), Env, input))
    }

    internal func GitRaw(repo string, args[]string) string {
        let all = List[string]{"-C", Path.Combine(Root, repo)}
        all.AddRange(args)
        let result = TestProcess.Run("/usr/bin/git", all.ToArray(), Env)
        Check.That(result.Code == 0, result.Error)
        return result.Output
    }

    internal func Blob(repo string, sha string)[]byte {
        let info = ProcessStartInfo("/usr/bin/git")
        info.UseShellExecute = false
        info.RedirectStandardOutput = true
        info.RedirectStandardError = true
        info.Environment.Clear()
        for entry in Env {
            info.Environment[entry.Key] = entry.Value
        }
        for arg in[]string{"-C", Path.Combine(Root, repo), "cat-file", "blob", sha} {
            info.ArgumentList.Add(arg)
        }
        using let process = Process.Start(info) ?? throw Exception("Cannot read fixture blob")
        using let bytes = MemoryStream()
        process.StandardOutput.BaseStream.CopyTo(bytes)
        let error = process.StandardError.ReadToEnd()
        process.WaitForExit()
        Check.That(process.ExitCode == 0, error)
        return bytes.ToArray()
    }

    internal func RunGit(args[]string) int32 {
        let treeTrace = Path.Combine(Root, "local-tree-heads.txt")
        if File.Exists(treeTrace) && Array.IndexOf(args, "ls-tree") >= 0 && Array.IndexOf(args, "--full-tree") >= 0 {
            File.AppendAllText(treeTrace, args[args.Length - 1] + "\n")
        }
        if Array.IndexOf(args, "ls-tree") >= 0 && Array.IndexOf(args, "--full-tree") >= 0 {
            let fault = Check.Text(State["local_tree_fault"])
            if fault == "truncated" || fault == "malformed" {
                Console.Write(fault == "truncated" ? "100644 blob " + String('a', 40) + "\tresult.txt": "invalid\0")
                return 0
            }
        }
        if Check.Text(State["local_final_ancestry_fault"]) == "true" && Array.IndexOf(args, "merge-base") >= 0 &&
            Array.IndexOf(args, "--is-ancestor") >= 0 && args[args.Length - 2] == args[args.Length - 1] {
            Console.Error.WriteLine("Missing local synchronization ancestry evidence")
            return 1
        }
        let pathFault = Check.Text(State["git_diff_fault"])
        if pathFault != "" && Array.IndexOf(args, "--name-only") >= 0 && Array.IndexOf(args, "-z") >= 0 {
            if pathFault == "missing-nul" {
                Console.Write("result.txt")
            } else if pathFault == "invalid-utf8" {
                using let output = Console.OpenStandardOutput()
                output.WriteByte(255)
                output.WriteByte(0)
            } else if pathFault == "truncated" {
                let chunk = String('x', 8191) + "\0"
                for i in 0 ... 4097 {
                    Console.Write(chunk)
                }
            }
            return 0
        }
        for prefix in[]string{"GIT_AUTHOR_", "GIT_COMMITTER_"} {
            Env.Remove(prefix + "NAME")
            Env.Remove(prefix + "EMAIL")
        }
        for key in[]string{"GIT_NO_REPLACE_OBJECTS", "GIT_GRAFT_FILE"} {
            if let value = Environment.GetEnvironmentVariable(key) {
                Env[key] = value
            }
        }
        let command = List[string]()
        for arg in args {
            let remote = arg.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase) && arg.EndsWith(
                ".git",
                StringComparison.Ordinal
            ) ? arg
                .Substring(19, arg.Length - 23).ToLowerInvariant(): ""
            let mapped = State["repository_folders"]?[remote]
            if mapped != nil {
                command.Add(Path.Combine(Root, Check.Text(mapped)))
            } else if String.Equals(arg, "https://github.com/owner/project.git", StringComparison.OrdinalIgnoreCase) {
                command.Add(Path.Combine(Root, "upstream"))
            } else if arg.StartsWith("https://github.com/donor/", StringComparison.OrdinalIgnoreCase) && arg.EndsWith(
                ".git",
                StringComparison.Ordinal
            ) {
                command.Add(Path.Combine(Root, "fork"))
            } else {
                command.Add(arg == "protocol.file.allow=never" ? "protocol.file.allow=always": arg)
            }
        }
        if Check.Text(State["mode"]) == "reconcile_merge_pause" && command.Contains("merge") && command.Contains(
            "--no-ff"
        ) {
            let entered = Path.Combine(Root, "reconcile-merge-entered")
            if File.Exists(entered) {
                File.WriteAllText(Path.Combine(Root, "reconcile-merge-repeated"), "")
                return 91
            }
            File.WriteAllText(entered, "")
            select {
                case <- after(TimeSpan.FromSeconds(60.0)) { }
            }
            return 91
        }
        if Check.Text(State["mode"]) == "slow_candidate" && command.Contains("diff") && command.Contains("--binary") {
            select {
                case <- after(TimeSpan.FromSeconds(10.0)) { }
            }
        }
        let push = command.IndexOf("push")
        let correctionPath = Path.Combine(
            Path.GetDirectoryName(Directory.GetCurrentDirectory()) ?? "",
            "correction.json"
        )
        if Check.Text(State["mode"]).StartsWith("change_checked_") && command.Contains("rev-parse") && command.Contains(
            "HEAD"
        ) &&
            File
            .Exists(correctionPath) {
            let correction = Check.Json(File.ReadAllText(correctionPath))
            if Check.Text(correction["state"]) == "verifying" &&
                (correction["verification"]?.AsArray().Count ?? 0) > 0 {
                let mode = Check.Text(State["mode"])
                if mode == "change_checked_head" {
                    Check.Success(
                        TestProcess.Run(
                            "/usr/bin/git",
                            []string{
                                "-c",
                                "core.hooksPath=/dev/null",
                                "commit",
                                "--allow-empty",
                                "-m",
                                "Concurrent head change"
                            },
                            Env
                        )
                    )
                } else if mode == "change_checked_tree" {
                    File.AppendAllText("result.txt", "Concurrent tree change\n")
                    Check.Success(TestProcess.Run("/usr/bin/git", []string{"add", "result.txt"}, Env))
                } else {
                    File.AppendAllText(
                        Path.Combine(
                            Path.GetDirectoryName(correctionPath) ?? "",
                            "correction-" + Check.Text(correction["uuid"]),
                            "candidate.patch"
                        ),
                        "Changed complete patch\n"
                    )
                }
                State["mode"] = JsonValue.Create("")
                Save()
            }
        }
        if command.Contains("checkout") && Check.Text(State["mode"]) == "external_replacement" {
            let replacement = Check.Text(State["replacement_with"])
            Check.Success(
                TestProcess.Run("/usr/bin/git", []string{"fetch", Path.Combine(Root, "fork"), replacement}, Env)
            )
            Check.Success(
                TestProcess.Run(
                    "/usr/bin/git",
                    []string{"replace", Check.Text(State["replacement_for"]), replacement},
                    Env
                )
            )
        }
        if push >= 0 {
            Check.That(
                (
                    Check.Text(State["repair_directory"]) != "" && File.Exists(
                        Path.Combine(Check.Text(State["repair_directory"]), "publication.json")
                    )
                ) ||
                    File.Exists(
                    Path.Combine(Path.GetDirectoryName(Directory.GetCurrentDirectory()) ?? "", "publication.json")
                ) ||
                    Directory
                    .GetFiles(
                    Path.Combine(Path.GetDirectoryName(Directory.GetCurrentDirectory()) ?? "", "amendments"),
                    "publication.json",
                    SearchOption.AllDirectories
                )
                    .Length > 0,
                "Publication content must be saved before push"
            )
            for key in[]string{
                "GH_TOKEN",
                "GITHUB_TOKEN",
                "GH_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_RUNTIME_DIR"
            } {
                if let value = Environment.GetEnvironmentVariable(key) {
                    Env[key] = value
                }
            }
            let credential = command.GetRange(0, push)
            credential.AddRange([]string{"credential", "fill"})
            Check.Contains(
                Check.Success(
                    TestProcess.Run("/usr/bin/git", credential.ToArray(), Env, "protocol=https\nhost=github.com\n\n")
                ),
                "password=synthetic-gh-credential"
            )
            State = Check.Json(File.ReadAllText(StatePath))
            State["git_pushes"] = JsonValue.Create(
                Int32.Parse(Check.Text(State["git_pushes"] ?? JsonValue.Create(0))) + 1
            )
            Save()
            if Check.Text(State["mode"]) == "push_fail" {
                Console.Error.WriteLine("Synthetic push failure: synthetic-raw-push-secret")
                return 1
            }
            if Check.Text(State["mode"]) == "repair_race_before_push" {
                let head = State["pulls"]?[0]?["head"] ?? throw Exception("Missing race PR")
                let previous = Check.Text(head["sha"])
                let tree = Git("fork", []string{"rev-parse", previous + "^{tree}"})
                let concurrent = Git(
                    "fork",
                    []string{
                        "-c",
                        "user.name=Concurrent",
                        "-c",
                        "user.email=fixture@example.test",
                        "commit-tree",
                        tree,
                        "-p",
                        previous,
                        "-m",
                        "Concurrent remote update"
                    }
                )
                Git("fork", []string{"update-ref", "refs/heads/" + Check.Text(head["ref"]), concurrent, previous})
                head["sha"] = JsonValue.Create(concurrent)
                State["mode"] = JsonValue.Create("")
                Save()
            }
        } else {
            for key in[]string{"GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "CODEX_HOME", "DBUS_SESSION_BUS_ADDRESS"} {
                Check.That(Environment.GetEnvironmentVariable(key) == nil, "Authentication reached local Git: " + key)
            }
        }
        let result = TestProcess.Run("/usr/bin/git", command.ToArray(), Env)
        if push >= 0 && result.Code == 0 {
            State = Check.Json(File.ReadAllText(StatePath))
            for pull in State["pulls"]?.AsArray() ?? JsonArray() {
                if let head = pull["head"] {
                    let target = Check.Text(head["repo"]?["full_name"]) == "owner/project" ? "upstream": "fork"
                    if command[push + 1] == Path.Combine(Root, target) {
                        head["sha"] = JsonValue.Create(Git(target, []string{"rev-parse", Check.Text(head["ref"])}))
                    }
                }
            }
            Save()
        }
        if push >= 0 &&
            result.Code == 0 &&
            (
            Check.Text(State["mode"]) == "lost_push_response" || Check.Text(State["mode"]) == "push_fail_after_write"
        ) {
            let latest = Check.Json(File.ReadAllText(StatePath))
            latest["mode"] = JsonValue.Create("")
            latest["push_count"] = JsonValue.Create(
                Int32.Parse(Check.Text(latest["push_count"] ?? JsonValue.Create(0))) + 1
            )
            Check.SaveJson(StatePath, latest)
            Console.Error.WriteLine("Synthetic lost push response")
            return 1
        }
        if push >= 0 && result.Code == 0 && Check.Text(State["mode"]) == "revoke_sync_after_push" {
            let reference = Git(
                "upstream",
                []string{"for-each-ref", "--format=%(refname)", "refs/heads/tokate/synchronizations"}
            ).Split('\n')[0]
            let grant = Git("upstream", []string{"rev-parse", reference})
            let tree = Git("upstream", []string{"rev-parse", grant + "^{tree}"})
            let revoked = Git(
                "upstream",
                []string{"commit-tree", tree, "-p", grant, "-m", "Revoked during publication"}
            )
            Git("upstream", []string{"update-ref", reference, revoked, grant})
            State["mode"] = JsonValue.Create("")
            Save()
        }
        if result.Code == 0 && command.Contains("checkout") && State["decree_checkout_replacement"] != nil {
            File.WriteAllText(
                Path.Combine(Directory.GetCurrentDirectory(), "DECREE.md"),
                Check.Text(State["decree_checkout_replacement"])
            )
        }
        if push >= 0 && result.Code == 0 && Check.Text(State["mode"]) == "revoke_after_push" {
            let latest = Check.Json(File.ReadAllText(StatePath))
            let issue = latest["issue"] ?? throw Exception("Missing issue")
            issue["labels"] = JsonArray()
            Check.SaveJson(StatePath, latest)
        }
        if result.Code == 0 && command.Contains("fetch") && Directory.GetCurrentDirectory().EndsWith(".staging") &&
            Check.Text(State["preparation_revoke_after_fetch"]) == "true" {
            State["preparation_revoke_after_fetch"] = nil
            let issue = State["issue"] ?? throw Exception("Missing issue")
            issue["labels"] = JsonArray()
            Save()
        }
        let interrupted = Check.Text(State["preparation_interrupt"])
        if result.Code == 0 && Directory.GetCurrentDirectory().EndsWith(".staging") &&
            interrupted != "" &&
            command
            .Contains(interrupted) {
            State["preparation_interrupt"] = nil
            Save()
            Console.Error.WriteLine("Interrupted staged " + interrupted)
            return 1
        }
        Console.Write(result.Output)
        Console.Error.Write(result.Error)
        return result.Code
    }
}
