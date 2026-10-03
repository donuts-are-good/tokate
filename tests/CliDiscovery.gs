package TokateTests

import System
import System.Diagnostics
import System.IO
import Tokate

internal class CliDiscovery {
    shared {
        internal func Call(binary string, args[]string, temp Temp, code int32 = 0) Result {
            let result = Check.Run(binary, args, temp.Env, cwd: temp.Root)
            Check.That(result.Code == code, result.Output + result.Error)
            Check.That(!result.Error.Contains("Missing tools"), "Prerequisites checked before validation")
            return result
        }

        internal func All(binary string, shell string = "bash") {
            Check.That(shell == "bash" || shell == "zsh" || shell == "fish", "Choose bash, zsh or fish")
            using let temp = Temp()
            let bin = Path.Combine(temp.Root, "bin")
            let log = Path.Combine(temp.Root, "calls")
            for name in[]string{"git", "gh", "codex", "setsid", "bwrap"} {
                let tool = Path.Combine(bin, name)
                File.WriteAllText(tool, "#!/bin/sh\nprintf '%s\\n' '" + name + "' \"$$@\" >> '" + log + "'\nexit 17\n")
                File.SetUnixFileMode(tool, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            }
            for argv in[][]string{[]string{}, []string{"--help"}, []string{"-h"}, []string{"help"}} {
                let help = Call(binary, argv, temp)
                Check.Contains(help.Output, "toh-KAH-teh")
                Check.That(help.Error == "", "Help wrote warnings")
            }
            for command in Cli.Commands {
                if command.Name == "help" {
                    continue
                }
                for argv in[][]string{
                    []string{command.Name, "--help"},
                    []string{command.Name, "-h"},
                    []string{"help", command.Name}
                } {
                    let help = Call(binary, argv, temp)
                    Check.Contains(help.Output, "Usage: tokate " + command.Name)
                    Check.Contains(help.Output, "Example:")
                    Check.That(help.Error == "", "Command help wrote warnings")
                    for option in Cli.Options {
                        if command.Has(option.Name) {
                            Check.Contains(help.Output, "--" + option.Name)
                        }
                    }
                }
            }
            let work = Call(binary, []string{"work", "--help"}, temp).Output
            Check.Contains(work, "inference")
            Check.Contains(work, "publish a draft PR")
            Check.Contains(work, "default: min(3600, owner limit)")
            Check.Contains(work, "(required)")
            Check.Contains(work, "use --run DIR instead of required inputs")
            Check.That(!work.Contains("tokate doctor"), "Work help repeats global help")
            Check.Contains(Call(binary, []string{"recover", "-h"}, temp).Output, "default: 300")

            for argv in[][]string{
                []string{"nonsense", "--help"},
                []string{"help", "nonsense"},
                []string{"help", "work", "extra"},
                []string{"work", "--unknown=value", "--help"},
                []string{"work", "--issue=1", "--issue", "1"},
                []string{"work", "--help", "-h"},
                []string{"work", "--model="},
                []string{"work", "--model", "--help"},
                []string{"checks", "--watch=true"},
                []string{"work", "--allow-network=false"},
                []string{"checks", "--run=x", "--pr=1"},
                []string{"checks", "--run=x", "--repo=owner/project"},
                []string{"work", "--run=x", "--seconds=1"},
                []string{"work", "--run=x", "https://github.com/owner/project/issues/1"},
                []string{"recover", "--run=x", "--seconds=0"},
                []string{"checks", "--run=x", "--timeout=86401"},
                []string{"verify-pr", "--repo=owner/project", "--pr=no"},
                []string{"approve", "--repo=owner/project", "--issue=1"},
                []string{"revoke", "--repo=owner/project", "--issue=-1"},
                []string{"work", "--repo=owner/project", "--issue=1", "--model=model", "--effort=invalid"},
                []string{"work", "--repo=owner/project", "--issue=1", "--model=bad model", "--effort=high"},
                []string{"revoke", "--repo=other/project", "--issue=https://github.com/owner/project/issues/1"},
                []string{"revoke", "--issue=2", "https://github.com/owner/project/issues/1"},
                []string{"revoke", "--issue=https://github.com/owner/project/pull/1"},
                []string{"revoke", "--issue=https://example.test/owner/project/issues/1"},
                []string{"revoke", "--issue=https://github.com/owner/project/issues/0"},
                []string{"revoke", "--issue=https://github.com/owner/project/issues/999999999999"},
                []string{
                    "prepare",
                    "--repo=owner/project",
                    "--issue=1",
                    "--state=bad",
                    "--source=external",
                    "--tools=tools.json"
                },
                []string{"prepare", "--repo=owner/project", "--issue=1", "--source=invalid"},
                []string{"external", "--run=x", "--commit=HEAD"},
                []string{"request", "--repo=owner/project", "--issue=1"},
                []string{"coordinator-setup", "--repo=owner/project"},
                []string{"coordinate", "--repo=owner/project"},
                []string{"submit"},
                []string{"completion"},
                []string{"completion", "powershell"},
                []string{"completion", "powershell", "--help"},
                []string{"completion", "bash", "extra"},
                []string{"status"}
            } {
                Check.Contains(Call(binary, argv, temp, 1).Error, "Usage:")
            }
            let saved = Path.Combine(temp.Root, "run")
            Directory.CreateDirectory(saved)
            File.WriteAllText(Path.Combine(saved, "run.json"), "{\"state\":\"claimed\"}")
            Check.Contains(Call(binary, []string{"status", "--run=" + saved}, temp).Output, "claimed")
            Check.That(!File.Exists(log), "Help or invalid inputs invoked a tool")

            {
                let script = Call(binary, []string{"completion", shell}, temp).Output
                let path = Path.Combine(temp.Root, "completion." + shell)
                File.WriteAllText(path, script)
                Check.Success(Check.Run("/usr/bin/" + shell, []string{"-n", path}, temp.Env))
                var command string
                var args[]string
                if shell == "bash" {
                    let spaced = Path.Combine(temp.Root, "run with spaces")
                    Directory.CreateDirectory(spaced)
                    command = "source '" +
                        path +
                        "'; COMP_WORDS=(tokate work --mo); COMP_CWORD=2; _tokate; printf '%s\\n' \"$${COMPREPLY[@]}\"; " +
                        "COMP_WORDS=(tokate work --effort=hi); _tokate; printf '%s\\n' \"$${COMPREPLY[@]}\"; " +
                        "COMP_WORDS=(tokate work '--runs=" +
                        temp.Root +
                        "/run w'); _tokate; printf '%s\\n' \"$${COMPREPLY[@]}\""
                    args = []string{"--noprofile", "--norc", "-c", command}
                } else if shell == "zsh" {
                    command = "autoload -Uz compinit; compinit -D; source '" +
                        path +
                        "'; " +
                        "_arguments() { if [[ $$1 == -C ]]; then state=args; line=(work); else print -rl -- \"$$@\"; fi; }; _tokate"
                    args = []string{"-f", "-c", command}
                } else {
                    command = "source '" +
                        path +
                        "'; complete -C 'tokate work --mo'; complete -C 'tokate work --effort=hi'"
                    args = []string{"--no-config", "-c", command}
                }
                let output = Check.Success(Check.Run("/usr/bin/" + shell, args, temp.Env))
                Check.Contains(output, "--model")
                Check.Contains(output, shell == "zsh" ? "--effort=": "--effort=high")
                if shell == "bash" {
                    Check.Contains(output, "--runs=" + Path.Combine(temp.Root, "run with spaces"))
                }
                if shell == "zsh" {
                    File.Copy(path, Path.Combine(temp.Root, "_tokate"))
                    let autoload = "fpath=('" +
                        temp.Root +
                        "' $$fpath); autoload -Uz _tokate; " +
                        "_arguments() { if [[ $$1 == -C ]]; then state=args; line=(work); else print -rl -- \"$$@\"; fi; }; _tokate"
                    Check.Contains(
                        Check.Success(Check.Run("/usr/bin/zsh", []string{"-f", "-c", autoload}, temp.Env)),
                        "--model"
                    )
                }
            }
            Check.That(!File.Exists(log), "Completion invoked a tool")
            let empty = Path.Combine(temp.Root, "empty")
            Directory.CreateDirectory(empty)
            let originalPath = temp.Env["PATH"]
            temp.Env["PATH"] = empty
            Call(binary, []string{"work", "--help"}, temp)
            Call(binary, []string{"help", "work"}, temp)
            Call(binary, []string{"-h"}, temp)
            Call(binary, []string{"completion", "bash"}, temp)
            Check.Contains(Call(binary, []string{"work"}, temp, 1).Error, "Required: --issue")
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "use --repo OWNER/REPO")
            temp.Env["PATH"] = originalPath

            let input = Args(
                []string{
                    "revoke",
                    "--repo=OWNER/project",
                    "--issue=01",
                    "https://github.com/owner/project/issues/1#issuecomment-2"
                }
            )
            Cli.Validate(input)
            Check.That(
                input.Get("repo") == "owner/project" && input.Number("issue") == 1,
                "URL inputs were not normalized"
            )
            File.Delete(Path.Combine(bin, "setsid"))
            File.CreateSymbolicLink(Path.Combine(bin, "setsid"), "/usr/bin/setsid")
            for argv in[][]string{
                []string{"work", "https://github.com/owner/project/issues/1", "--model=model", "--effort=high"},
                []string{"work", "--issue=https://github.com/owner/project/issues/1", "--model=model", "--effort=high"}
            } {
                let result = Check.Run(binary, argv, temp.Env, cwd: temp.Root)
                Check.That(result.Code == 1, "Recording gh stub should fail")
                Check.Contains(File.ReadAllText(log), "gh\napi\n")
                Check.That(!result.Error.Contains("Usage:"), "Valid URL input rejected")
                File.Delete(log)
            }
            File.WriteAllText(Path.Combine(bin, "git"), "#!/bin/sh\n/bin/sleep 30 &\nexit 0\n")
            let deadline = Stopwatch.StartNew()
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "No GitHub remote")
            Check.That(deadline.Elapsed.TotalSeconds < 7, "Repository discovery waited for a detached pipe holder")
            Check.That(!File.Exists(log), "Failed repository discovery invoked GitHub")
            File.Delete(Path.Combine(bin, "git"))
            File.CreateSymbolicLink(Path.Combine(bin, "git"), "/usr/bin/git")
            Check.Success(Check.Run("/usr/bin/git", []string{"init", "-b", "main", temp.Root}, temp.Env))
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "No GitHub remote")
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "add", "origin", "git@github.com:owner/project.git"},
                    temp.Env
                )
            )
            let policy = Check.Run(binary, []string{"policy"}, temp.Env, cwd: temp.Root)
            Check.That(policy.Code == 1 && !policy.Error.Contains("Usage:"), "Unique remote rejected")
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            File.Delete(log)
            let nested = Path.Combine(temp.Root, "subdirectory")
            Directory.CreateDirectory(nested)
            let fromSubdirectory = Check.Run(binary, []string{"policy"}, temp.Env, cwd: nested)
            Check.That(
                fromSubdirectory.Code == 1 && !fromSubdirectory.Error.Contains("Usage:"),
                "Repository subdirectory rejected"
            )
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            File.Delete(log)
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "add", "upstream", "https://github.com/OWNER/project.git"},
                    temp.Env
                )
            )
            let same = Check.Run(binary, []string{"policy"}, temp.Env, cwd: temp.Root)
            Check.That(same.Code == 1 && !same.Error.Contains("Usage:"), "Equivalent remotes rejected")
            File.Delete(log)
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{"-C", temp.Root, "remote", "set-url", "upstream", "https://github.com/other/project.git"},
                    temp.Env
                )
            )
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "Ambiguous local remotes")
            Check.That(!File.Exists(log), "Ambiguous remotes invoked GitHub")
            let urlOverride = Check.Run(
                binary,
                []string{"work", "https://github.com/owner/project/issues/1", "--model=model", "--effort=high"},
                temp.Env,
                cwd: temp.Root
            )
            Check.That(
                urlOverride.Code == 1 && !urlOverride.Error.Contains("Usage:"),
                "Issue URL did not override local context"
            )
            File.Delete(log)
            Check.Success(
                Check.Run("/usr/bin/git", []string{"-C", temp.Root, "remote", "remove", "upstream"}, temp.Env)
            )
            Check.Success(
                Check.Run(
                    "/usr/bin/git",
                    []string{
                        "-C",
                        temp.Root,
                        "remote",
                        "set-url",
                        "--push",
                        "origin",
                        "https://github.com/other/project.git"
                    },
                    temp.Env
                )
            )
            Check.Contains(Call(binary, []string{"policy"}, temp, 1).Error, "Ambiguous local remotes")
            Check.That(!File.Exists(log), "Conflicting push remote invoked GitHub")
            let explicitRepo = Check.Run(
                binary,
                []string{"policy", "--repo=https://github.com/owner/project.git"},
                temp.Env,
                cwd: temp.Root
            )
            Check.That(
                explicitRepo.Code == 1 && !explicitRepo.Error.Contains("Usage:"),
                "Explicit repo did not override local context"
            )
            Check.Contains(File.ReadAllText(log), "repos/owner/project\n")
            Check.That(!File.ReadAllText(log).Contains("codex"), "Unexpected inference")
            Check.That(!File.ReadAllText(log).Contains("POST"), "Unexpected remote mutation")
            Console.WriteLine(
                "PASS CLI discovery: help, validation, equals syntax, URL/context, completion and missing tools"
            )
        }
    }
}
