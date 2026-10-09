package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.RegularExpressions

internal class NixRuntime {
    shared {
        internal func Root(path string) string -> Regex.Match(path, "^/nix/store/[0-9a-z]{32}-[^/\\r\\n]+").Value

        internal func Executable(path string) string {
            let canonical = LocalPaths.CanonicalPath(path)
            let root = Root(canonical)
            let alias = Path.Combine(root, "bin", Path.GetFileName(path))
            return root != "" && File.Exists(alias) && LocalPaths.CanonicalPath(alias) == canonical ? alias: canonical
        }

        internal func Tools(directory string, executables[]string) List[string] {
            let tools = List[string]()
            for name in[]string{"sh", "env", "git", "cp", "find"} {
                let path = LocalPaths.SystemTool(name, directory)
                if path != "" {
                    tools.Add(path)
                }
            }
            tools.AddRange(executables)
            return tools
        }

        internal func Paths(executables[]string, directory string) List[string] {
            let roots = HashSet[string](StringComparer.Ordinal)
            let checkout = LocalPaths.CheckoutRoot(directory)
            for executable in executables {
                if !Path.IsPathFullyQualified(executable) {
                    continue
                }
                if Root(executable) != "" && !File.Exists(executable) && !Directory.Exists(executable) {
                    throw CliFailure(
                        "missing_tools",
                        "The selected Nix runtime closure is unavailable. Restore its profile before retrying."
                    )
                }
                let canonical = LocalPaths.CanonicalPath(executable)
                let root = Root(canonical)
                if root == "" {
                    continue
                }
                if LocalPaths.Within(Path.GetFullPath(executable), directory) || LocalPaths.Within(
                    canonical,
                    directory
                ) ||
                    (checkout != "" && LocalPaths.CheckoutRoot(Path.GetDirectoryName(executable) ?? "") == checkout) {
                    throw CliFailure("verification_failed", "Nix runtimes must be selected outside the checkout.")
                }
                roots.Add(root)
            }
            let paths = List[string]()
            if roots.Count == 0 {
                return paths
            }
            let certificates = LocalPaths.Certificates()
            let trustRoot = certificates == "" ? "": Root(LocalPaths.CanonicalPath(certificates))
            if trustRoot != "" {
                roots.Add(trustRoot)
            }
            let args = List[string]{"--query", "--requisites"}
            args.AddRange(roots)
            let result = Commands.Run(
                LocalPaths.NeedSystemTool("nix-store", directory),
                args.ToArray(),
                directory,
                seconds: 15,
                isolated: true
            )
            if result.Code != 0 || result.Truncated || result.ReadFailed {
                throw CliFailure(
                    "missing_tools",
                    "The selected Nix runtime closure is unavailable. Restore its profile before retrying."
                )
            }
            let seen = HashSet[string](StringComparer.Ordinal)
            for line in result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries) {
                let path = line.TrimEnd('\r')
                if path != Root(path) || LocalPaths.CanonicalPath(path) != path ||
                    (!Directory.Exists(path) && !File.Exists(path)) ||
                    paths.Count >= 2048 {
                    throw CliFailure("verification_failed", "Nix returned an invalid or unavailable runtime closure.")
                }
                if seen.Add(path) {
                    paths.Add(path)
                }
            }
            if !roots.IsSubsetOf(seen) {
                throw CliFailure(
                    "verification_failed",
                    "The selected executable is missing from its Nix runtime closure."
                )
            }
            return paths
        }

        internal func SearchPath(executables[]string) string {
            let directories = List[string]()
            for executable in executables {
                if !Path.IsPathFullyQualified(executable) {
                    continue
                }
                let canonical = LocalPaths.CanonicalPath(executable)
                let directory = Path.GetDirectoryName(canonical) ?? ""
                if Root(canonical) != "" && !directories.Contains(directory) {
                    directories.Add(directory)
                }
            }
            directories.Add("/usr/local/bin:/usr/bin:/bin")
            return String.Join(":", directories)
        }

        internal func ProbeFile(paths List[string], directory string) string {
            if paths.Count == 0 {
                return ""
            }
            let tool = LocalPaths.NeedSystemTool("nix-store", directory)
            return paths.Contains(Root(LocalPaths.CanonicalPath(tool))) ? "": tool
        }
    }
}
