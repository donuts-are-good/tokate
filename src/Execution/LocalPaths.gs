package Tokate

import System
import System.IO

internal class LocalPaths {
    shared {
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
            return File.Exists(standard) ? standard: ""
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
            let found = Find(name)
            if found != "" {
                return found
            }
            let home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            let candidate = Path.Combine(home, ".local/bin", name)
            if Executable(candidate) {
                return candidate
            }
            let managed = Path.Combine(home, ".pi/agent/bin/pi")
            return name == "pi" && Executable(managed) ? managed: ""
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
