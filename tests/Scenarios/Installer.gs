package TokateTests

import System
import System.IO
import System.Security.Cryptography
import System.Text.Json.Nodes

internal class Installer {
    shared {
        internal func Hash(path string) string -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
            .ToLowerInvariant()

        internal func ShellFixture(name string, args[]string, root string) int32 {
            if name == "id" {
                Check.That(args.Length == 1 && args[0] == "-u", "Unexpected account identity lookup")
                Console.WriteLine("12345")
                return 0
            }
            Check.That(
                args.Length == 2 && args[0] == "passwd" && args[1] == "12345",
                "Shell detection must query only the current account"
            )
            File.AppendAllText(Path.Combine(root, "shell-lookups"), "lookup\n")
            let shell = File.ReadAllText(Path.Combine(root, "account-shell"))
            if shell == "" {
                return 2
            }
            Console.WriteLine("fixture:x:12345:12345::/unused:" + (shell == "empty" ? "": shell))
            return 0
        }

        internal func PlatformFixture(name string, args[]string, root string) int32 {
            let state = Check.Json(File.ReadAllText(Path.Combine(root, "platform.json")))
            if name == "uname" {
                Check.That(args.Length == 1 && (args[0] == "-s" || args[0] == "-m"), "Unexpected uname arguments")
                Console.WriteLine(Check.Text(state[args[0] == "-s" ? "os": "arch"]))
                return 0
            }
            Check.That(args.Length == 1 && args[0] == "GNU_LIBC_VERSION", "Unexpected getconf arguments")
            let libc = Check.Text(state["libc"])
            if libc == "" {
                return 1
            }
            Console.WriteLine(libc)
            return 0
        }

        internal func Fixture(args[]string, root string) int32 {
            if args.Length == 1 && args[0] == "--version" {
                Console.WriteLine("curl fixture")
                return 0
            }
            let statePath = Path.Combine(root, "state.json")
            let state = Check.Json(File.ReadAllText(statePath))
            if Check.Text(state["coordinator_download"]) == "true" {
                return CoordinationFlow.ReleaseDownload(args, root)
            }
            Check.That(args[0] == "-q", "curl must ignore user configuration")
            Check.That(Array.IndexOf(args, "--proto") >= 0 && Array.IndexOf(args, "=https") >= 0, "HTTPS required")
            if Check.Text(state["clean"]) == "true" {
                Check.That(Environment.GetEnvironmentVariable("GH_TOKEN") == nil, "GitHub credential inherited")
                Check.That(Environment.GetEnvironmentVariable("OPENAI_API_KEY") == nil, "API credential inherited")
            }
            if Check.Text(state["mode"]) == "download-fail" {
                return 22
            }
            let url = args[args.Length - 1]
            let tag = Check.Text(state["tag"])
            if url.EndsWith("/latest") {
                Console.Write("https://github.com/obselate/tokate/releases/tag/" + tag)
                return 0
            }
            let output = args[Array.IndexOf(args, "--output") + 1]
            let archive = Path.Combine(root, "release.tar.gz")
            if url.EndsWith(".sha256") {
                let hash = Check.Text(state["mode"]) == "checksum-fail" ? String('0', 64): Hash(archive)
                File.WriteAllText(output, hash + "  tokate-" + tag.Substring(1) + "-linux-x64.tar.gz\n")
            } else {
                Check.That(
                    url == "https://github.com/obselate/tokate/releases/download/" + tag + "/tokate-" + tag.Substring(
                        1
                    ) +
                        "-linux-x64.tar.gz",
                    "Unexpected release URL"
                )
                File.Copy(archive, output, true)
            }
            return 0
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
            let bundleName = "tokate-" + version + "-linux-x64"
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
            Check.That(Hash(installed) == Hash(binary), "Installed binary differs")
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
            CliDiscovery.Envelope(TestProcess.Run(installed, []string{"update", "--json"}, temp.Env), "update", "ok")
            Check.That(File.ReadAllText(profile) == hook, "Update duplicated shell setup")
            if loginHook != "" {
                Check.That(File.ReadAllText(bashProfile) == loginHook, "Update duplicated login shell setup")
            }
            for mode in[]string{"checksum-fail", "download-fail"} {
                state["mode"] = JsonValue.Create(mode)
                File.WriteAllText(statePath, state.ToJsonString())
                let failure = TestProcess.Run(installed, []string{"update", "--json"}, temp.Env)
                Check.That(failure.Code != 0, "Update should fail: " + mode)
                CliDiscovery.Envelope(failure, "update", "error", "command_failed")
                Check.That(Hash(installed) == Hash(binary), "Failed update changed binary")
            }
            Check.Success(TestProcess.Run(installed, []string{"uninstall", "--help"}, temp.Env))
            Check.That(File.Exists(installed), "Help removed the binary")
            let saved = Path.Combine(temp.Env["HOME"], ".local/state/tokate/runs/saved")
            Directory.CreateDirectory(Path.GetDirectoryName(saved) ?? "")
            File.WriteAllText(saved, "keep")
            File.Delete(Path.Combine(tools, "curl"))
            CliDiscovery.Envelope(
                TestProcess.Run(installed, []string{"uninstall", "--json"}, temp.Env),
                "uninstall",
                "ok"
            )
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
                            Check.That(Hash(installed) == Hash(binary), "Platform refusal changed existing binary")
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
            CliDiscovery.Envelope(
                TestProcess.Run(installed, []string{"uninstall", "--json"}, temp.Env),
                "uninstall",
                "ok"
            )
            Check.That(!File.Exists(installed), "Unsupported libc blocked offline removal")
        }
    }
}
