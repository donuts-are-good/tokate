package Tokate

import System
import System.Collections.Generic
import System.Formats.Tar
import System.IO
import System.IO.Compression
import System.Runtime.InteropServices
import System.Security.Cryptography

@DllImport("libc", EntryPoint: "geteuid")
func SetupUserId() uint32;

internal class MachineSetup {
    shared {
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
                    }
                }
            }
            return ""
        }

        private func Package(name string, arch bool) string -> switch name {
            case "git": "git"
            case "gh": arch ? "github-cli": "gh"
            case "curl": "curl"
            case "tar": "tar"
            case "bwrap": "bubblewrap"
            case "/usr/bin/bwrap": "bubblewrap"
            case "setsid": "util-linux"
            case "/usr/bin/setsid": "util-linux"
            case "/usr/bin/unshare": "util-linux"
            case "/usr/bin/env": "coreutils"
            case "/usr/bin/cp": "coreutils"
            default: ""
        }

        private func InstallPackages(manager string, packages List[string]) {
            let args = List[string]()
            var executable = manager
            if SetupUserId() != 0 {
                executable = LocalPaths.Executable("/usr/bin/sudo") ? "/usr/bin/sudo": ""
                if executable == "" {
                    throw CliFailure(
                        "missing_tools",
                        "sudo was not found. Install the listed packages with an administrator, then rerun doctor."
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
                args.AddRange([]string{"install", "-y", "--no-install-recommends"})
            } else {
                args.AddRange([]string{"-Syu", "--needed", "--noconfirm"})
            }
            args.AddRange(packages)
            if Installation.Execute(executable, args.ToArray()) != 0 {
                throw CliFailure(
                    "missing_tools",
                    "Package installation did not complete. Rerun doctor to inspect what is still missing."
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
                if tool.Path != "" || tool.Name == "codex" {
                    continue
                }
                let packageName = Package(tool.Name, manager.EndsWith("pacman"))
                if packageName != "" && !packages.Contains(packageName) {
                    packages.Add(packageName)
                    missing.Add(tool.Name)
                }
            }
            if packages.Count > 0 {
                if packages.Contains("curl") && !packages.Contains("ca-certificates") {
                    packages.Add("ca-certificates")
                }
                if manager == "" || !LocalPaths.Executable(manager) {
                    Terminal.Message(
                        "Not found: " + String.Join(", ", missing) +
                            ". Install these tools or add their existing locations to PATH, then rerun doctor.",
                        error: true
                    )
                    return false
                }
                if !Confirm(
                    options,
                    "Not found: " + String.Join(", ", missing) +
                        ". If already installed elsewhere, cancel and correct PATH. Install packages: " +
                        String.Join(", ", packages) +
                        (
                        manager.EndsWith(
                            "pacman"
                        ) ? ". This pacman transaction also synchronizes repositories and upgrades system packages.": ""
                    )
                ) {
                    return false
                }
                InstallPackages(manager, packages)
                let after = Startup.Scan(missing.ToArray())
                for tool in after {
                    if tool.Path != "" {
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
                    options.Values["--harness-path"] = InstallCodex(home, temporary)
                } else {
                    let script = Path.Combine(temporary, "install.sh")
                    Download("https://pi.dev/install.sh", script)
                    let code = PublicOutput.Enabled || Console.IsInputRedirected ?
                    Installation.Execute("/usr/bin/setsid", []string{"--wait", "/bin/sh", script}, capture: true):
                    Installation.Execute("/bin/sh", []string{script}, capture: true)
                    if code != 0 {
                        throw CliFailure(
                            "missing_tools",
                            "The official Pi installer did not complete. Run interactive doctor --managed --harness pi --fix for its Node setup prompts; existing configuration was kept."
                        )
                    }
                    var path = LocalPaths.Harness("pi")
                    for candidate in[]string{
                        Path.Combine(home, ".pi/agent/bin/pi"),
                        Path.Combine(home, ".local/bin/pi")
                    } {
                        if path == "" && LocalPaths.Executable(candidate) {
                            path = candidate
                        }
                    }
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

        private func InstallCodex(home string, temporary string) string {
            let destination = Path.Combine(home, ".local/bin/codex")
            if File.Exists(destination) || FileInfo(destination).LinkTarget != nil {
                return CodexRuntime.Resolve(destination)
            }
            let release = RequestData.Parse(
                Commands.Checked(
                    "curl",
                    []string{
                        "-qfsSL",
                        "--proto",
                        "=https",
                        "--connect-timeout",
                        "15",
                        "--max-time",
                        "30",
                        "https://api.github.com/repos/openai/codex/releases/latest"
                    }
                ),
                2 * 1024 * 1024
            )
            let archive = Path.Combine(temporary, "codex.tar.gz")
            var digest = ""
            for asset in J.Items(J.Get(release, "assets")) {
                if J.Text(asset, "name") != "codex-x86_64-unknown-linux-musl.tar.gz" {
                    continue
                }
                let url = J.Text(asset, "browser_download_url")
                digest = J.Text(asset, "digest")
                if !url.StartsWith("https://github.com/openai/codex/releases/download/") || !digest.StartsWith(
                    "sha256:"
                ) ||
                    digest.Length != 71 {
                    throw CliFailure("missing_tools", "The official Codex release has no verifiable native asset")
                }
                Download(url, archive)
                break
            }
            using let input = File.OpenRead(archive)
            if "sha256:" + Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant() != digest {
                throw CliFailure("missing_tools", "Codex download checksum mismatch; existing installation was kept")
            }
            input.Position = 0
            using let gzip = GZipStream(input, CompressionMode.Decompress)
            using let tar = TarReader(gzip)
            Directory.CreateDirectory(Path.GetDirectoryName(destination) ?? home)
            let staged = destination + "." + Guid.NewGuid().ToString("N")
            try {
                var entry = tar.GetNextEntry()
                while entry != nil && entry.Name != "codex-x86_64-unknown-linux-musl" {
                    entry = tar.GetNextEntry()
                }
                if entry == nil || entry.EntryType != TarEntryType.RegularFile || entry.DataStream == nil {
                    throw CliFailure("missing_tools", "The Codex archive has no regular native executable")
                }
                {
                    using let output = FileStream(staged, FileMode.CreateNew, FileAccess.Write)
                    let data = entry.DataStream ??
                        throw CliFailure("missing_tools", "The Codex archive has no executable data")
                    data.CopyTo(output)
                }
                File.SetUnixFileMode(
                    staged,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute
                )
                CodexRuntime.Resolve(staged)
                Commands.Checked(staged, []string{"--version"}, harness: true)
                File.Move(staged, destination)
            } finally {
                File.Delete(staged)
            }
            return destination
        }
    }
}
