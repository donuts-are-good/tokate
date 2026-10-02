package Tokate

import System
import System.Collections.Generic
import System.IO

internal class Verification {
    shared {
        private func DirectoryPath(path string) string {
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

        private func GitDirectory(path string) {
            for entry in Directory.EnumerateFileSystemEntries(path) {
                if FileInfo(entry).LinkTarget != nil {
                    throw Exception("Verification refuses Git symlinks: " + entry)
                }
                if Directory.Exists(entry) {
                    GitDirectory(entry)
                }
            }
        }

        internal func Run(directory string, command[]string, network bool, seconds int32) CommandResult {
            if !OperatingSystem.IsLinux() || !File.Exists("/usr/bin/bwrap") {
                throw Exception(
                    "Independent verification requires Linux and /usr/bin/bwrap; no host fallback is supported"
                )
            }
            let checkout = DirectoryPath(directory)
            for root in[]string{"/home", "/run", "/var", "/tmp"} {
                if checkout == root {
                    throw Exception("Unsupported verification checkout layout: " + checkout)
                }
            }
            for root in[]string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc", "/sys"} {
                if checkout == "/" || checkout == root || checkout.StartsWith(root + "/") {
                    throw Exception("Unsupported verification checkout layout: " + checkout)
                }
            }
            let git = DirectoryPath(Path.Combine(checkout, ".git"))
            GitDirectory(git)
            for file in[]string{"commondir", "objects/info/alternates", "objects/info/http-alternates"} {
                if File.Exists(Path.Combine(git, file)) || Directory.Exists(Path.Combine(git, file)) {
                    throw Exception("Verification requires self-contained Git metadata: " + file)
                }
            }
            let scratch = Path.Combine(checkout, ".tokate-scratch")
            if FileInfo(scratch).LinkTarget != nil {
                throw Exception("Verification scratch directory must not be a symbolic link")
            }
            Directory.CreateDirectory(scratch)
            DirectoryPath(scratch)
            let args = List[string]{
                "--die-with-parent",
                "--new-session",
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--cap-drop",
                "ALL",
                "--clearenv",
                "--setenv",
                "PATH",
                "/usr/local/bin:/usr/bin:/bin",
                "--setenv",
                "HOME",
                scratch,
                "--setenv",
                "TMPDIR",
                scratch,
                "--setenv",
                "LANG",
                "C.UTF-8"
            }
            if !network {
                args.Add("--unshare-net")
            }
            for path in[]string{"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"} {
                if Directory.Exists(path) {
                    args.AddRange([]string{"--ro-bind", path, path})
                }
            }
            for path in[]string{
                "/etc/ld.so.cache",
                "/etc/nsswitch.conf",
                "/etc/hosts",
                "/etc/resolv.conf",
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/ssl/cert.pem",
                "/etc/pki/tls/certs/ca-bundle.crt"
            } {
                if File.Exists(path) {
                    args.AddRange([]string{"--ro-bind", path, path})
                }
            }
            args.AddRange(
                []string{
                    "--proc",
                    "/proc",
                    "--dev",
                    "/dev",
                    "--tmpfs",
                    "/tmp",
                    "--dir",
                    "/var",
                    "--tmpfs",
                    "/var/tmp",
                    "--bind",
                    checkout,
                    checkout,
                    "--ro-bind",
                    git,
                    git,
                    "--chdir",
                    checkout,
                    "--"
                }
            )
            args.AddRange(command)
            return Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, seconds: seconds, isolated: true)
        }
    }
}
