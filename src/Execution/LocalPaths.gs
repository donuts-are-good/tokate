package Tokate

import System
import System.IO

internal class LocalPaths {
    shared {
        internal func Musl() bool -> File.Exists("/lib/ld-musl-x86_64.so.1")

        internal func RuntimePath(value string) string {
            if value.Length > 4096 || !Path.IsPathFullyQualified(value) {
                throw Exception("Runtime overrides require bounded absolute paths")
            }
            for character in value {
                if Char.IsControl(character) {
                    throw Exception("Invalid runtime path")
                }
            }
            return Path.GetFullPath(value)
        }

        internal func Executable(path string) bool {
            try {
                return File.Exists(path) &&
                    (
                    File.GetUnixFileMode(path) & (
                        UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute
                    )
                ) != 0
            } catch (error IOException) { } catch (error UnauthorizedAccessException) { }
            return false
        }

        internal func Find(name string) string {
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if !Path.IsPathFullyQualified(entry) {
                    continue
                }
                let path = Path.Combine(entry, name)
                if Executable(path) {
                    return path
                }
            }
            return ""
        }

        private func TrustedExecutable(path string, checkout string) bool {
            if !Executable(path) || Within(path, checkout) {
                return false
            }
            try {
                return !Within(CanonicalPath(path), checkout)
            } catch (error IOException) { } catch (error UnauthorizedAccessException) { }
            return false
        }

        internal func FindTrusted(name string) string {
            let checkout = CheckoutRoot()
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if Path.IsPathFullyQualified(entry) {
                    let candidate = Path.GetFullPath(Path.Combine(entry, name))
                    if TrustedExecutable(candidate, checkout) {
                        return candidate
                    }
                }
            }
            return ""
        }

        internal func PiDirectory() string {
            let configured = Environment.GetEnvironmentVariable("PI_CODING_AGENT_DIR") ?? ""
            return configured == "" ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".pi/agent"
            ): RuntimePath(configured)
        }

        internal func CodexInstallPath() string {
            let configured = Environment.GetEnvironmentVariable("CODEX_INSTALL_DIR") ?? ""
            return Path.Combine(
                configured == "" ? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".local/bin"
                ): RuntimePath(configured),
                "codex"
            )
        }

        internal func CheckoutRoot(directory string = "") string {
            var current = Path.TrimEndingDirectorySeparator(
                Path.GetFullPath(directory == "" ? Directory.GetCurrentDirectory(): directory)
            )
            while current != "" {
                let marker = Path.Combine(current, ".git")
                if Directory.Exists(marker) || File.Exists(marker) {
                    return CanonicalPath(current)
                }
                current = Path.GetDirectoryName(current) ?? ""
            }
            return ""
        }

        internal func Within(path string, directory string) bool -> directory != "" &&
            (path == directory || path.StartsWith(directory + "/", StringComparison.Ordinal))

        internal func SystemTool(name string, directory string = "") string {
            let checkout = CheckoutRoot(directory)
            for entry in(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator) {
                if !Path.IsPathFullyQualified(entry) {
                    continue
                }
                let path = Path.GetFullPath(Path.Combine(entry, name))
                if Within(path, checkout) || (checkout != "" && CheckoutRoot(entry) == checkout) || !Executable(path) {
                    continue
                }
                let canonical = CanonicalPath(path)
                if !Within(canonical, checkout) &&
                    (
                    NixRuntime.Root(canonical) != "" || canonical.StartsWith(
                        "/run/wrappers/bin/",
                        StringComparison.Ordinal
                    )
                ) {
                    return NixRuntime.Executable(path)
                }
            }
            let standard = Path.Combine(name == "sh" ? "/bin": "/usr/bin", name)
            let alternative = Path.Combine("/bin", name)
            if File.Exists(standard) || File.Exists(alternative) {
                return File.Exists(standard) ? standard: alternative
            }
            if name == "bash" {
                let shell = SystemTool("sh", directory)
                if shell != "" {
                    let canonical = CanonicalPath(shell)
                    if Path.GetFileName(canonical) == "bash" {
                        return canonical
                    }
                }
            }
            return ""
        }

        internal func NeedSystemTool(name string, directory string = "") string {
            let path = SystemTool(name, directory)
            if !Executable(path) {
                throw CliFailure(
                    "missing_tools",
                    "Install " + name + " in a system path or a Nix profile outside the checkout."
                )
            }
            return path
        }

        internal func Certificates() string {
            for path in[]string{
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/ssl/cert.pem",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
            } {
                if File.Exists(path) {
                    return path
                }
            }
            return ""
        }

        internal func Harness(name string, path string = "") string {
            if path != "" {
                return RuntimePath(path)
            }
            let found = FindTrusted(name)
            if found != "" {
                return found
            }
            let home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            let checkout = CheckoutRoot()
            let configured = name == "codex" ? CodexInstallPath(): name == "pi" ?
            Path.Combine(PiDirectory(), "bin/pi"): ""
            let npm = Environment.GetEnvironmentVariable("NPM_CONFIG_PREFIX") ?? ""
            let bun = Environment.GetEnvironmentVariable("BUN_INSTALL_BIN") ?? ""
            for candidate in[]string{
                configured,
                Path.Combine(home, ".local/bin", name),
                npm == "" ? "": Path.Combine(RuntimePath(npm), "bin", name),
                Path.Combine(bun == "" ? Path.Combine(home, ".bun/bin"): RuntimePath(bun), name)
            } {
                if candidate != "" && TrustedExecutable(candidate, checkout) {
                    return candidate
                }
            }
            return ""
        }

        internal func StateDirectory(defaultLocation bool = false) string {
            let configured = defaultLocation ? "": Environment.GetEnvironmentVariable("XDG_STATE_HOME") ?? ""
            let root = Path.IsPathFullyQualified(configured) ? configured: Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".local/state"
            )
            return Path.Combine(Path.GetFullPath(root), "tokate")
        }

        internal func StateDirectories()[]string {
            let current = StateDirectory()
            let previous = StateDirectory(true)
            return current == previous ? []string{current}: []string{current, previous}
        }

        internal func DirectoryPath(path string) string {
            let absolute = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path))
            var current = Path.GetPathRoot(absolute) ?? "/"
            for part in absolute.Substring(current.Length).Split(Path.DirectorySeparatorChar) {
                current = Path.Combine(current, part)
                if FileInfo(current).LinkTarget != nil || !Directory.Exists(current) {
                    throw Exception("Verification requires real directories without checkout/Git symlinks: " + current)
                }
            }
            return absolute
        }

        internal func CanonicalPath(path string, depth int32 = 0) string {
            if depth > 40 {
                throw Exception("Too many executable path symlinks")
            }
            let absolute = Path.GetFullPath(path)
            var result = Path.GetPathRoot(absolute) ?? "/"
            for part in absolute.Substring(result.Length).Split(Path.DirectorySeparatorChar) {
                let candidate = Path.Combine(result, part)
                if let link = File.ResolveLinkTarget(candidate, true) {
                    result = CanonicalPath(link.FullName, depth + 1)
                } else {
                    result = candidate
                }
            }
            return result
        }
    }
}
