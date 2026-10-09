package TokateTests

import System
import System.IO
import System.Security.Cryptography
import System.Text.Json.Nodes

internal class Installer {
    shared {
        internal func Skill(project string) {
            using let temp = Temp()
            let bundle = Path.Combine(temp.Root, "plugin")
            Directory.CreateDirectory(Path.Combine(bundle, "tokate"))
            let script = Path.Combine(bundle, "install.sh")
            File.Copy(Path.Combine(project, "plugins/install.sh"), script)
            let source = Path.Combine(bundle, "tokate/SKILL.md")
            File.Copy(Path.Combine(project, "plugins/tokate/SKILL.md"), source)
            let original = File.ReadAllText(source)
            let omp = Path.Combine(temp.Root, "bin/omp")
            File.WriteAllText(
                omp,
                "#!/bin/sh\n[ \"$*\" = 'config path' ] || exit 1\nprintf '%s\\n' \"$$TOKATE_TEST_OMP_DIR\"\nexit \"$${TOKATE_TEST_OMP_EXIT:-0}\"\n"
            )
            File.SetUnixFileMode(omp, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            temp.Env["TOKATE_TEST_OMP_DIR"] = Path.Combine(temp.Env["HOME"], ".omp/agent")
            let homes = []string{".agents", ".claude", ".pi/agent", ".omp/agent", ".hermes"}
            let harnesses = []string{"codex", "claude", "pi", "omp", "hermes"}
            for i in 0 ... harnesses.Length {
                let args = []string{script, harnesses[i]}
                Check.Success(TestProcess.Run("/bin/sh", args, temp.Env))
                let installed = Path.Combine(temp.Env["HOME"], homes[i], "skills/tokate/SKILL.md")
                Check.That(File.ReadAllText(installed) == original, "Harness received a different donation skill")
                Check.Success(TestProcess.Run("/bin/sh", args, temp.Env))
                File.WriteAllText(source, original + "\nUpdated package.\n")
                Check.Success(TestProcess.Run("/bin/sh", args, temp.Env))
                Check.That(File.ReadAllText(installed) == File.ReadAllText(source), "Unmodified skill did not update")
                File.WriteAllText(installed, "User-edited skill\n")
                Check.That(
                    TestProcess.Run("/bin/sh", args, temp.Env).Code == 1,
                    "Installer replaced a user-edited skill"
                )
                Check.That(File.ReadAllText(installed) == "User-edited skill\n", "Edited skill was not preserved")
                File.WriteAllText(source, original)
            }
            let custom = Path.Combine(temp.Root, "custom skills")
            let customArgs = []string{script, "hermes", custom}
            Check.Success(TestProcess.Run("/bin/sh", customArgs, temp.Env))
            let target = Path.Combine(custom, "tokate/SKILL.md")
            File.Delete(target)
            File.CreateSymbolicLink(target, source)
            Check.That(TestProcess.Run("/bin/sh", customArgs, temp.Env).Code == 1, "Installer followed a skill symlink")
            Check.That(File.ReadAllText(source) == original, "Installer changed its source through a link")
            let foreign = Path.Combine(temp.Root, "foreign/tokate")
            Directory.CreateDirectory(foreign)
            File.WriteAllText(Path.Combine(foreign, "SKILL.md"), "Existing skill\n")
            Check.That(
                TestProcess.Run("/bin/sh", []string{script, "codex", Path.GetDirectoryName(foreign) ?? ""}, temp.Env)
                    .Code == 1,
                "Installer replaced an unrelated skill"
            )
            let resolved = Path.Combine(temp.Root, "omp config/active")
            temp.Env["TOKATE_TEST_OMP_DIR"] = resolved
            temp.Env["PI_CONFIG_DIR"] = ".custom-omp"
            temp.Env["PI_CODING_AGENT_DIR"] = Path.Combine(temp.Root, "other agent")
            temp.Env["PI_PROFILE"] = "legacy"
            for profile in[]string{"default", " \t ", "donor", ""} {
                temp.Env["OMP_PROFILE"] = profile
                Check.Success(TestProcess.Run("/bin/sh", []string{script, "omp"}, temp.Env))
                Check.That(
                    File.ReadAllText(Path.Combine(resolved, "skills/tokate/SKILL.md")) == original,
                    "Installer ignored OMP's resolved agent directory"
                )
            }
            for invalid in[]string{"", "relative"} {
                temp.Env["TOKATE_TEST_OMP_DIR"] = invalid
                Check.That(
                    TestProcess.Run("/bin/sh", []string{script, "omp"}, temp.Env).Code == 1,
                    "Installer accepted an invalid OMP directory"
                )
            }
            let failed = Path.Combine(temp.Root, "failed omp")
            temp.Env["TOKATE_TEST_OMP_DIR"] = failed
            temp.Env["TOKATE_TEST_OMP_EXIT"] = "17"
            Check.That(
                TestProcess.Run("/bin/sh", []string{script, "omp"}, temp.Env).Code == 17 && !Directory.Exists(failed),
                "Installer ignored OMP discovery failure"
            )
            File.Delete(omp)
            Check.Success(
                TestProcess.Run("/bin/sh", []string{script, "omp", Path.Combine(temp.Root, "explicit omp")}, temp.Env)
            )
            Check.That(
                TestProcess.Run("/bin/sh", []string{script, "omp"}, temp.Env).Code != 0,
                "Installer guessed a directory without OMP"
            )
            Check.That(
                TestProcess.Run("/bin/sh", []string{script, "unknown"}, temp.Env).Code == 1,
                "Installer accepted an unknown harness"
            )
            Console.WriteLine(
                "PASS shared skill installation, updates, custom paths and preservation for five harnesses"
            )
        }

        internal func Lifecycle(project string, binary string, shell string = "/bin/bash", accountShell string? = nil) {
            using let temp = Temp()
            temp.Env["SHELL"] = shell
            temp.Env["TMPDIR"] = temp.Root
            temp.Tool("curl")
            temp.Tool("id")
            temp.Tool("getent")
            let tools = Path.Combine(temp.Root, "bin")
            if accountShell != nil {
                temp.Env.Remove("SHELL")
            }
            File.WriteAllText(Path.Combine(tools, "account-shell"), accountShell ?? "")
            let version = Check.Success(TestProcess.Run(binary, []string{"--version"}, temp.Env)).Substring(7)
            let bundleName = "tokate-" + version + "-" + ReleaseTools.Runtime()
            let bundle = Path.Combine(temp.Root, bundleName)
            Directory.CreateDirectory(bundle)
            File.Copy(binary, Path.Combine(bundle, "tokate"))
            Check.Success(
                TestProcess.Run(
                    "/usr/bin/tar",
                    []string{"-czf", Path.Combine(tools, "release.tar.gz"), "-C", temp.Root, bundleName},
                    temp.Env
                )
            )
            let statePath = Path.Combine(tools, "state.json")
            let state = Check.Json("{}")
            state["tag"] = JsonValue.Create("v" + version)
            File.WriteAllText(statePath, state.ToJsonString())
            let script = Path.Combine(project, "site/install.sh")
            let installed = Path.Combine(temp.Env["HOME"], ".local/bin/tokate")
            let fish = Path.GetFileName(shell) == "fish"
            let unresolved = shell == "/bin/sh"
            let profile = Path.Combine(
                temp.Env["HOME"],
                fish ? ".config/fish/conf.d/tokate.fish": (
                    Path.GetFileName(shell) == "zsh" ? ".zshrc": (
                        unresolved ?
                        ".profile": ".bashrc"
                    )
                )
            )
            let existing = fish ? "set -gx TOKATE_EXISTING keep\n": "export TOKATE_EXISTING=keep\n"
            if !fish {
                File.WriteAllText(profile, existing)
                if !unresolved && Path.GetFileName(shell) == "bash" {
                    File.WriteAllText(Path.Combine(temp.Env["HOME"], ".bash_profile"), existing)
                }
            }
            let output = Check.Success(TestProcess.Run("/bin/sh", []string{script}, temp.Env))
            Check.That(Check.Hash(installed) == Check.Hash(binary), "Installed binary differs")
            if unresolved {
                Check.Contains(output, "Add ~/.local/bin to PATH in your shell startup file.")
                Check.Contains(output, ". \"$$HOME/.local/share/tokate/env\"")
                Check.Contains(output, "fish_add_path \"$$HOME/.local/bin\"")
                Check.Contains(output, installed + " --help")
                Check.That(!output.Contains("Open a new terminal"), "Unresolved shell promised automatic PATH setup")
            } else {
                Check.Contains(output, "Open a new terminal")
            }
            Check.That(
                File.Exists(Path.Combine(tools, "shell-lookups")) == (accountShell != nil),
                "Account lookup did not respect SHELL"
            )
            let hook = File.ReadAllText(profile)
            if !fish {
                Check.That(hook.StartsWith(existing), "Installer changed existing shell configuration")
            }
            let bashProfile = Path.Combine(temp.Env["HOME"], ".bash_profile")
            let loginHook = File.Exists(bashProfile) ? File.ReadAllText(bashProfile): ""
            let probe = fish ? []string{"-c", "source \"$$argv[1]\"; command -s tokate", profile}: []string{
                "-c",
                ". \"$1\"; command -v tokate",
                "probe",
                profile
            }
            let path = Check.Success(TestProcess.Run(shell, probe, temp.Env))
            Check.That(path == installed, "PATH hook did not expose Tokate")
            if !unresolved {
                let terminal = TestProcess.Run(shell, []string{"-ic", "command -v tokate"}, temp.Env)
                Check.That(Check.Success(terminal) == installed, "Ordinary terminal did not find Tokate")
                if !fish {
                    Check.That(
                        Check.Success(
                            TestProcess.Run(shell, []string{"-ic", "printf '%s' \"$$TOKATE_EXISTING\""}, temp.Env)
                        ) ==
                        "keep",
                        "Ordinary terminal lost existing shell configuration"
                    )
                }
            }

            temp.Env["GH_TOKEN"] = "fixture-secret"
            temp.Env["OPENAI_API_KEY"] = "fixture-secret"
            state["clean"] = JsonValue.Create(true)
            File.WriteAllText(statePath, state.ToJsonString())
            Check.Envelope(TestProcess.Run(installed, []string{"update", "--json"}, temp.Env), "update", "ok")
            Check.That(File.ReadAllText(profile) == hook, "Update duplicated shell setup")
            if loginHook != "" {
                Check.That(File.ReadAllText(bashProfile) == loginHook, "Update duplicated login shell setup")
            }
            for mode in[]string{"checksum-fail", "download-fail"} {
                state["mode"] = JsonValue.Create(mode)
                File.WriteAllText(statePath, state.ToJsonString())
                let failure = TestProcess.Run(installed, []string{"update", "--json"}, temp.Env)
                Check.That(failure.Code != 0, "Update should fail: " + mode)
                Check.Envelope(failure, "update", "error", "command_failed")
                Check.That(Check.Hash(installed) == Check.Hash(binary), "Failed update changed binary")
            }
            Check.Success(TestProcess.Run(installed, []string{"uninstall", "--help"}, temp.Env))
            Check.That(File.Exists(installed), "Help removed the binary")
            let saved = Path.Combine(temp.Env["HOME"], ".local/state/tokate/runs/saved")
            Directory.CreateDirectory(Path.GetDirectoryName(saved) ?? "")
            File.WriteAllText(saved, "keep")
            File.Delete(Path.Combine(tools, "curl"))
            Check.Envelope(TestProcess.Run(installed, []string{"uninstall", "--json"}, temp.Env), "uninstall", "ok")
            Check.That(!File.Exists(installed), "Uninstall left binary")
            Check.That(File.Exists(saved), "Uninstall removed saved work")
            if fish {
                Check.That(!File.Exists(profile), "Uninstall left Fish setup")
            } else {
                Check.Success(TestProcess.Run(shell, []string{"-c", ". \"$1\"", "probe", profile}, temp.Env))
            }
            Check.That(
                !File.Exists(Path.Combine(temp.Env["HOME"], ".local/share/tokate/env")),
                "Uninstall left active PATH hook"
            )
            Check.That(
                TestProcess.Run(binary, []string{"uninstall"}, temp.Env).Code != 0,
                "Unmanaged uninstall should fail"
            )
            state["mode"] = JsonValue.Create("")
            File.WriteAllText(statePath, state.ToJsonString())
            temp.Env.Remove("GH_TOKEN")
            temp.Env.Remove("OPENAI_API_KEY")
            temp.Tool("curl")
            Check.Success(TestProcess.Run("/bin/sh", []string{script}, temp.Env))
            Check.That(File.ReadAllText(profile) == hook, "Reinstall duplicated shell setup")
            if loginHook != "" {
                Check.That(File.ReadAllText(bashProfile) == loginHook, "Reinstall duplicated login shell setup")
            }
            Check.That(
                Check.Success(TestProcess.Run(shell, probe, temp.Env)) == installed,
                "Reinstall did not restore PATH"
            )
        }

        internal func ShellDetection(project string, binary string) {
            Lifecycle(project, binary, "/bin/bash", "/bin/bash")
            Console.WriteLine("PASS unset SHELL installer lifecycle for Bash")
            for shell in[]string{"", "empty", "/bin/tcsh"} {
                Lifecycle(project, binary, "/bin/sh", shell)
                Console.WriteLine("PASS unresolved shell installer lifecycle: " + shell)
            }
        }

        internal func RefuseInvalidPath(project string) {
            using let temp = Temp()
            let target = Path.Combine(temp.Root, "keep")
            File.WriteAllText(target, "keep")
            Directory.CreateDirectory(Path.Combine(temp.Env["HOME"], ".local/bin"))
            File.CreateSymbolicLink(Path.Combine(temp.Env["HOME"], ".local/bin/tokate"), target)
            let result = TestProcess.Run("/bin/sh", []string{Path.Combine(project, "site/install.sh")}, temp.Env)
            Check.That(result.Code != 0, "Installer replaced symlink")
            Check.Contains(result.Error, "Refusing to replace a symlink")
            Check.That(File.ReadAllText(target) == "keep", "Symlink target changed")
            let destination = Path.Combine(temp.Env["HOME"], ".local/bin/tokate")
            File.Delete(destination)
            Directory.CreateDirectory(destination)
            let directoryResult = TestProcess.Run(
                "/bin/sh",
                []string{Path.Combine(project, "site/install.sh")},
                temp.Env
            )
            Check.That(directoryResult.Code != 0, "Installer accepted a directory as executable path")
            Check.Contains(directoryResult.Error, "Expected a regular file")
            Check.That(
                Directory.GetFileSystemEntries(destination).Length == 0,
                "Installer wrote into a conflicting directory"
            )
        }

        internal func RefuseUnsupportedPlatform(project string, binary string) {
            using let temp = Temp()
            for name in[]string{"uname", "getconf"} {
                temp.Tool(name)
            }
            let tools = Path.Combine(temp.Root, "bin")
            let statePath = Path.Combine(tools, "platform.json")
            let installed = Path.Combine(temp.Env["HOME"], ".local/bin/tokate")
            let data = Path.Combine(temp.Env["HOME"], ".local/share/tokate")
            let profile = Path.Combine(temp.Env["HOME"], ".bashrc")
            let script = Path.Combine(project, "site/install.sh")
            let cases = []string{
                "aarch64",
                "glibc 2.44",
                "Unsupported architecture: aarch64",
                "x86_64",
                "glibc 2.33",
                "Unsupported glibc version: 2.33",
                "x86_64",
                "",
                "Cannot detect glibc",
                "x86_64",
                "musl 1.2.5",
                "Unsupported libc: musl 1.2.5",
                "x86_64",
                "glibc unknown",
                "Cannot parse glibc version"
            }
            for existing in[]bool{false, true} {
                if existing {
                    Directory.CreateDirectory(Path.GetDirectoryName(installed) ?? "")
                    Directory.CreateDirectory(data)
                    File.Copy(binary, installed)
                    File.WriteAllText(Path.Combine(data, "installed"), "keep-marker")
                    File.WriteAllText(Path.Combine(data, "env"), "keep-path")
                    File.WriteAllText(profile, "keep-profile")
                }
                for i in 0 ... cases.Length / 3 {
                    if i > 0 && ReleaseTools.Runtime() == "linux-musl-x64" {
                        continue
                    }
                    File.WriteAllText(
                        statePath,
                        Check.Map("os", "Linux", "arch", cases[i * 3], "libc", cases[i * 3 + 1]).ToJsonString()
                    )
                    for action in existing ? []string{"install", "update"}: []string{"install"} {
                        let result = action == "update" ? TestProcess.Run(
                            installed,
                            []string{"update"},
                            temp.Env
                        ): TestProcess.Run("/bin/sh", []string{script}, temp.Env)
                        Check.That(result.Code != 0, "Installer accepted unsupported platform: " + cases[i * 3 + 1])
                        Check.Contains(result.Error, cases[i * 3 + 2])
                        Check.That(!result.Output.Contains("Downloading"), "Unsupported platform reached downloads")
                        if existing {
                            Check.That(
                                Check.Hash(installed) == Check.Hash(binary),
                                "Platform refusal changed existing binary"
                            )
                            Check.That(
                                File.ReadAllText(Path.Combine(data, "installed")) == "keep-marker",
                                "Install marker changed"
                            )
                            Check.That(
                                File.ReadAllText(Path.Combine(data, "env")) == "keep-path",
                                "PATH configuration changed"
                            )
                            Check.That(File.ReadAllText(profile) == "keep-profile", "Shell profile changed")
                        } else {
                            Check.That(
                                !Directory.Exists(data) && !File.Exists(installed),
                                "Platform refusal created installation"
                            )
                            Check.That(!File.Exists(profile), "Platform refusal created shell profile")
                        }
                    }
                }
            }
            Check.Envelope(TestProcess.Run(installed, []string{"uninstall", "--json"}, temp.Env), "uninstall", "ok")
            Check.That(!File.Exists(installed), "Unsupported libc blocked offline removal")
        }
    }
}
