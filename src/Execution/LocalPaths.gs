package Tokate

import System
import System.IO

internal class LocalPaths {
    shared {
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

        internal func StateDirectory(legacy bool = false) string {
            let configured = legacy ? "": Environment.GetEnvironmentVariable("XDG_STATE_HOME") ?? ""
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
