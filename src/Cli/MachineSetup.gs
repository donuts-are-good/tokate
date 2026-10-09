package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "geteuid")
func SetupUserId() uint32;

internal class MachineSetup {
    shared {
        internal func NixManaged() bool {
            let executable = Environment.ProcessPath ?? ""
            return executable != "" && NixRuntime.Root(LocalPaths.CanonicalPath(executable)) != ""
        }

        private func NixHost() bool {
            if File.Exists("/etc/os-release") {
                for line in File.ReadLines("/etc/os-release") {
                    if line.StartsWith("ID=") && line.Substring(3).Trim('"', '\'') == "nixos" {
                        return true
                    }
                }
            }
            return false
        }

        private func Confirm(options Args, message string) bool {
            Terminal.Message(message, "yellow", true)
            if options.Command == "doctor" && options.Get("yes") == "true" {
                return true
            }
            if !DonorSelection.Interactive(options) {
                Terminal.Message("Preview only. Use doctor --fix --yes to confirm installation.", error: true)
                return false
            }
            Console.Error.Write("Install these requirements? [y/N] ")
            return String.Equals(Console.ReadLine(), "y", StringComparison.OrdinalIgnoreCase)
        }

        private func PackageManager() string {
            if File.Exists("/etc/os-release") {
                for line in File.ReadLines("/etc/os-release") {
                    if !line.StartsWith("ID=") && !line.StartsWith("ID_LIKE=") {
                        continue
                    }
                    let value = line.Substring(line.IndexOf('=') + 1).Trim('"', '\'')
                    for id in value.Split(' ') {
                        if id == "ubuntu" || id == "debian" {
                            return "/usr/bin/apt-get"
                        }
                        if id == "arch" || id == "cachyos" {
                            return "/usr/bin/pacman"
                        }
                        if id == "fedora" || id == "rhel" || id == "centos" || id == "rocky" || id == "almalinux" {
                            return "/usr/bin/dnf"
                        }
                        if id == "alpine" {
                            return "/sbin/apk"
                        }
                    }
                }
            }
            return ""
        }

        private func Package(name string, manager string) string -> switch name {
            case "git": "git"
            case "gh": manager.EndsWith("pacman") || manager.EndsWith("apk") ? "github-cli": "gh"
            case "curl": "curl"
            case "tar": "tar"
            case "bwrap": "bubblewrap"
            case "/usr/bin/bwrap": "bubblewrap"
            case "setsid": manager.EndsWith("dnf") ? "util-linux-core": manager.EndsWith(
                "apk"
            ) ? "util-linux-misc": "util-linux"
            case "/usr/bin/setsid": manager.EndsWith("dnf") ? "util-linux-core": manager.EndsWith(
                "apk"
            ) ? "util-linux-misc": "util-linux"
            case "/usr/bin/unshare": manager.EndsWith("dnf") ? "util-linux-core": manager.EndsWith(
                "apk"
            ) ? "util-linux-misc": "util-linux"
            case "/usr/bin/env": "coreutils"
            case "/usr/bin/cp": "coreutils"
            case "/usr/bin/find": "findutils"
            case "/bin/bash": "bash"
            default: ""
        }

        private func PackageArguments(manager string, packages List[string])[]string {
            let args = List[string]()
            if manager.EndsWith("apt-get") {
                args.AddRange([]string{"install", "-y", "--no-install-recommends"})
            } else if manager.EndsWith("dnf") {
                args.AddRange([]string{"install", "--assumeyes", "--setopt=install_weak_deps=False"})
            } else if manager.EndsWith("apk") {
                args.AddRange([]string{"add", "--no-cache"})
            } else {
                args.AddRange([]string{"-Syu", "--needed", "--noconfirm"})
            }
            args.AddRange(packages)
            return args.ToArray()
        }

        private func Privilege(manager string) string -> manager.EndsWith("apk") && LocalPaths.Executable(
            "/usr/bin/doas"
        ) ? "/usr/bin/doas":
        LocalPaths.Executable("/usr/bin/sudo") ? "/usr/bin/sudo": ""

        private func InstallPackages(manager string, packages List[string]) {
            let args = List[string]()
            var executable = manager
            if SetupUserId() != 0 {
                executable = Privilege(manager)
                if executable == "" {
                    throw CliFailure(
                        "missing_tools",
                        (manager.EndsWith("apk") ? "sudo or doas was not found.": "sudo was not found.") +
                            " Install the listed packages with an administrator, then rerun doctor."
                    )
                }
                if PublicOutput.Enabled || Console.IsInputRedirected {
                    args.Add("-n")
                }
                args.Add(manager)
            }
            if manager.EndsWith("apt-get") {
                let update = List[string](args)
                update.Add("update")
                if Installation.Execute(executable, update.ToArray()) != 0 {
                    throw CliFailure("missing_tools", "Package index update failed; existing installations were kept")
                }
            }
            args.AddRange(PackageArguments(manager, packages))
            if Installation.Execute(executable, args.ToArray()) != 0 {
                throw CliFailure(
                    "missing_tools",
                    "Package installation did not complete. Rerun doctor to inspect what is still missing." +
                        (
                        manager.EndsWith(
                            "dnf"
                        ) ? " Check that your configured repositories provide the listed packages. Tokate does not enable repositories or change security policy.": ""
                    )
                )
            }
        }

        internal func TryFix(options Args, tools List[ToolCheck]) bool {
            if !DonorSelection.Interactive(options) && !(options.Command == "doctor" && options.Get("fix") == "true") {
                return false
            }
            WizardScreen.Close()
            let manager = PackageManager()
            let packages = List[string]()
            let missing = List[string]()
            for tool in tools {
                if (tool.Path != "" && !(manager.EndsWith("apk") && tool.Status == "failed")) || tool.Name == "codex" {
                    continue
                }
                let packageName = Package(tool.Name, manager)
                if packageName != "" && !packages.Contains(packageName) {
                    packages.Add(packageName)
                    missing.Add(tool.Name)
                }
            }
            if packages.Count > 0 {
                if NixManaged() || NixHost() {
                    Terminal.Message(
                        "Nix manages these prerequisites. Add git, gh, bubblewrap, util-linux, coreutils and findutils to your Nix configuration or profile, then rerun doctor.",
                        error: true
                    )
                    return false
                }
                if packages.Contains("curl") && !packages.Contains("ca-certificates") {
                    packages.Add("ca-certificates")
                }
                if manager.EndsWith("apk") && packages.Contains("coreutils") && !packages.Contains("findutils") {
                    packages.Add("findutils")
                }
                if manager == "" || !LocalPaths.Executable(manager) {
                    Terminal.Message(
                        "Not found: " + String.Join(", ", missing) +
                            ". Install these tools or add their existing locations to PATH, then rerun doctor.",
                        error: true
                    )
                    return false
                }
                let helper = Privilege(manager)
                let privilege = SetupUserId() == 0 ? "": (helper == "" ? "sudo": Path.GetFileName(helper)) +
                    " " +
                    (PublicOutput.Enabled || Console.IsInputRedirected ? "-n ": "")
                let command = privilege + manager + " "
                if !Confirm(
                    options,
                    "Not found: " + String.Join(", ", missing) +
                        ". If already installed elsewhere, cancel and correct PATH. Run: " +
                        (manager.EndsWith("apt-get") ? command + "update, then ": "") +
                        command +
                        String.Join(" ", PackageArguments(manager, packages)) +
                        (
                        manager.EndsWith(
                            "pacman"
                        ) ? ". This pacman transaction also synchronizes repositories and upgrades system packages.": ""
                    )
                ) {
                    return false
                }
                InstallPackages(manager, packages)
                let recheck = List[string](missing)
                if manager.EndsWith("apk") {
                    for name in Startup.Requirements(options) {
                        if !recheck.Contains(name) {
                            recheck.Add(name)
                        }
                    }
                }
                let after = Startup.Scan(recheck.ToArray())
                if manager.EndsWith("apk") {
                    Startup.ExecuteChecks(after)
                }
                for tool in after {
                    if manager.EndsWith("apk") ? missing.Contains(tool.Name) &&
                        tool.Status == "ready": tool.Path != "" {
                        return true
                    }
                }
                Terminal.Message(
                    "Packages were installed but these paths are still unavailable. Correct PATH before retrying.",
                    error: true
                )
                return false
            }
            for tool in tools {
                if tool.Name == "codex" && tool.Path == "" {
                    return Harness(options)
                }
            }
            return false
        }

        internal func Harness(options Args) bool {
            let name = options.Get("harness", "codex")
            if name != "codex" && name != "pi" {
                return false
            }
            if !DonorSelection.Interactive(options) && !(options.Command == "doctor" && options.Get("fix") == "true") {
                return false
            }
            WizardScreen.Close()
            if NixManaged() || NixHost() {
                Terminal.Message(
                    "Install through Nix: nix profile add " +
                        (name == "pi" ? "github:earendil-works/pi/stable": "nixpkgs#codex"),
                    error: true
                )
                return false
            }
            Terminal.Message("Could not use " + name + ". It may be installed at a custom location.", "yellow", true)
            if name == "pi" {
                Terminal.Message("For an SDK installation, use --pi-root DIR --node FILE.", error: true)
            }
            var choice = "2"
            if !(options.Command == "doctor" && options.Get("yes") == "true") {
                if !DonorSelection.Interactive(options) {
                    Terminal.Message(
                        "Supply --harness-path FILE, or confirm installation with --fix --yes.",
                        error: true
                    )
                    return false
                }
                Console.Error.Write("1) Use an existing path\n2) Install " + name + "\n3) Cancel\nChoice [3]: ")
                choice = Console.ReadLine() ?? ""
            }
            if choice == "1" {
                Console.Error.Write("Executable path: ")
                let path = Console.ReadLine() ?? ""
                if path == "" {
                    return false
                }
                options.Values["--harness-path"] = LocalPaths.RuntimePath(path)
                Terminal.Message("Using --harness-path " + options.Need("harness-path"), error: true)
                return true
            }
            if choice != "2" {
                return false
            }
            if LocalPaths.Find("curl") == "" && !TryFix(options, List[ToolCheck]{ToolCheck{Name: "curl"}}) {
                return false
            }
            let home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            let temporary = Path.Combine(home, ".local/share/tokate/setup-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(
                temporary,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                if name == "codex" {
                    options.Values["--harness-path"] = InstallCodex(temporary)
                } else {
                    let script = Path.Combine(temporary, "install.sh")
                    Download("https://pi.dev/install.sh", script)
                    let code = PublicOutput.Enabled || Console.IsInputRedirected ?
                    Installation.Execute(
                        LocalPaths.NeedSystemTool("setsid"),
                        []string{"--wait", LocalPaths.NeedSystemTool("sh"), script},
                        capture: true,
                        pathVariables: []string{"PI_CODING_AGENT_DIR"}
                    ):
                    Installation.Execute(
                        LocalPaths.NeedSystemTool("sh"),
                        []string{script},
                        capture: true,
                        pathVariables: []string{"PI_CODING_AGENT_DIR"}
                    )
                    if code != 0 {
                        throw CliFailure(
                            "missing_tools",
                            "The official Pi installer did not complete. Run interactive doctor --managed --harness pi --fix for its Node setup prompts; existing configuration was kept."
                        )
                    }
                    let path = LocalPaths.Harness("pi")
                    if path == "" {
                        throw CliFailure(
                            "missing_tools",
                            "Pi was installed but its executable was not found. Supply --harness-path FILE."
                        )
                    }
                    options.Values["--harness-path"] = path
                }
            } finally {
                Directory.Delete(temporary, true)
            }
            return true
        }

        private func Download(url string, path string) {
            Commands.Checked(
                "curl",
                []string{
                    "-qfsSL",
                    "--proto",
                    "=https",
                    "--proto-redir",
                    "=https",
                    "--connect-timeout",
                    "15",
                    "--max-time",
                    "180",
                    "--max-filesize",
                    "536870912",
                    "--output",
                    path,
                    url
                },
                seconds: 190
            )
        }

        private func InstallCodex(temporary string) string {
            let destination = LocalPaths.CodexInstallPath()
            if File.Exists(destination) || FileInfo(destination).LinkTarget != nil {
                return CodexRuntime.Resolve(destination)
            }
            let script = Path.Combine(temporary, "codex-install.sh")
            Download("https://chatgpt.com/codex/install.sh", script)
            let code = Installation.Execute(
                LocalPaths.NeedSystemTool("env"),
                []string{"CODEX_NON_INTERACTIVE=1", LocalPaths.NeedSystemTool("sh"), script},
                capture: true,
                pathVariables: []string{"CODEX_INSTALL_DIR", "CODEX_HOME"}
            )
            if code != 0 {
                throw CliFailure(
                    "missing_tools",
                    "The official Codex installer did not complete. Existing installation and authentication remain owned by Codex."
                )
            }
            let executable = CodexRuntime.Resolve(destination)
            Commands.Checked(executable, []string{"--version"}, harness: true)
            return executable
        }
    }
}
