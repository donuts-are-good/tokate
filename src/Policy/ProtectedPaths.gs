package Tokate

import System
import System.Collections.Generic
import System.Text
import System.Text.Json

internal class ProtectedPaths {
    shared {
        private let Utf8 UTF8Encoding = UTF8Encoding(false, true)

        internal func Validate(paths JsonElement) {
            if paths.ValueKind == JsonValueKind.Undefined {
                return
            }
            if paths.ValueKind != JsonValueKind.Array || paths.GetArrayLength() > 64 {
                throw Exception("protected_paths must be an array of at most 64 literal repository paths")
            }
            for entry in paths.EnumerateArray() {
                if entry.ValueKind != JsonValueKind.String {
                    throw Exception("protected_paths entries must be nonempty strings of at most 512 characters")
                }
                let path = entry.GetString() ?? ""
                if path.Length == 0 || path.Length > 512 || path.Contains('\\') ||
                    (path.Length >= 3 && Char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '/') {
                    throw Exception("Invalid protected_paths entry")
                }
                for character in path {
                    if Char.IsControl(character) {
                        throw Exception("Invalid protected_paths control character")
                    }
                }
                Relative(path.EndsWith("/", StringComparison.Ordinal) ? path.Substring(0, path.Length - 1): path)
                Utf8.GetBytes(path)
            }
        }

        internal func Relative(path string) {
            for segment in path.Split('/') {
                if segment == "" || segment == "." || segment == ".." || segment.Contains('\0') {
                    throw Exception("Expected a literal repository-relative slash path")
                }
            }
        }

        private func Matches(entry string, path string) bool {
            if entry.EndsWith("/", StringComparison.Ordinal) {
                return (entry.Length == path.Length + 1 && entry.StartsWith(path, StringComparison.Ordinal)) ||
                    path.StartsWith(entry, StringComparison.Ordinal)
            }
            return path == entry
        }

        internal func Check(policy JsonElement, approval JsonElement, path string) {
            if Decree.Protected(path, approval) {
                throw Exception("Contribution changes approved root DECREE.md")
            }
            if Matches(".github/workflows/", path) || path.StartsWith(".github/tokate", StringComparison.Ordinal) {
                throw Exception("Contribution changes protected owner configuration: " + J.Write(path))
            }
            for entry in J.Items(J.Get(policy, "protected_paths")) {
                if Matches(entry.GetString() ?? "", path) {
                    throw Exception("Contribution changes protected owner path: " + J.Write(path))
                }
            }
        }

        private func Relation(configured List[string], approval JsonElement, path string) int32 {
            if Decree.Protected(path, approval) || Matches(".github/workflows/", path) || path.StartsWith(
                ".github/tokate",
                StringComparison.Ordinal
            ) {
                return 2
            }
            var ancestor = path == ".github"
            let prefix = configured.Count == 0 ? "": path + "/"
            for name in configured {
                if Matches(name, path) {
                    return 2
                }
                if name.StartsWith(prefix, StringComparison.Ordinal) {
                    ancestor = true
                }
            }
            return ancestor ? 1: 0
        }

        internal func AddTree(entries Dictionary[string, string], path string, mode string, type string, sha string) {
            Relative(path)
            RepositoryIdentity.CommitSha(sha)
            if !(
                (mode == "040000" && type == "tree") ||
                    ((mode == "100644" || mode == "100755" || mode == "120000") && type == "blob") ||
                    (mode == "160000" && type == "commit")
            ) ||
                !entries.TryAdd(path, mode + " " + type + " " + sha) {
                throw Exception("Incomplete, duplicate or invalid protected tree evidence")
            }
        }

        internal func CompleteTree(entries Dictionary[string, string]) {
            if entries.Count > 100000 {
                throw Exception("Protected tree exceeds bounded evidence")
            }
            for entry in entries {
                var path = entry.Key
                var slash = path.LastIndexOf('/')
                while slash >= 0 {
                    path = path.Substring(0, slash)
                    var value string
                    if !entries.TryGetValue(path, out value) || !value.StartsWith(
                        "040000 tree ",
                        StringComparison.Ordinal
                    ) {
                        throw Exception("Missing protected tree ancestor evidence")
                    }
                    slash = path.LastIndexOf('/')
                }
            }
        }

        internal func LocalTree(checkout string, head string) Dictionary[string, string] {
            let output = Commands.GitRaw(
                checkout,
                []string{"ls-tree", "-r", "-t", "-z", "--full-tree", RepositoryIdentity.CommitSha(head)}
            )
            let entries = Dictionary[string, string](StringComparer.Ordinal)
            if output != "" && !output.EndsWith("\0", StringComparison.Ordinal) {
                throw Exception("Truncated protected tree evidence")
            }
            for line in output.Split('\0') {
                if line == "" {
                    continue
                }
                let tab = line.IndexOf('\t')
                let fields = (tab < 0 ? "": line.Substring(0, tab)).Split(' ')
                if fields.Length != 3 {
                    throw Exception("Invalid protected tree evidence")
                }
                AddTree(entries, line.Substring(tab + 1), fields[0], fields[1], fields[2])
            }
            CompleteTree(entries)
            return entries
        }

        internal func EqualTrees(
            policy JsonElement,
            approval JsonElement,
            trusted Dictionary[string, string],
            candidate Dictionary[string, string]
        ) {
            let configured = List[string]()
            for entry in J.Items(J.Get(policy, "protected_paths")) {
                configured.Add(entry.GetString() ?? "")
            }
            let paths = HashSet[string](trusted.Keys, StringComparer.Ordinal)
            paths.UnionWith(candidate.Keys)
            for path in paths {
                let relation = Relation(configured, approval, path)
                if relation == 0 {
                    continue
                }
                var left string
                var right string
                let hasLeft = trusted.TryGetValue(path, out left)
                let hasRight = candidate.TryGetValue(path, out right)
                if relation == 1 &&
                    (!hasLeft || left.StartsWith("040000 tree ", StringComparison.Ordinal)) &&
                    (!hasRight || right.StartsWith("040000 tree ", StringComparison.Ordinal)) {
                    continue
                }
                if relation == 1 && hasLeft && hasRight {
                    left = left.Substring(0, left.LastIndexOf(' '))
                    right = right.Substring(0, right.LastIndexOf(' '))
                }
                if hasLeft != hasRight || left != right {
                    throw Exception("Synchronization changes protected owner content: " + J.Write(path))
                }
            }
        }

        internal func Local(
            checkout string,
            policy JsonElement,
            approval JsonElement,
            base string,
            head string = "",
            budget RuntimeBudget? = nil
        ) {
            let args = List[string]{
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=none",
                "--no-renames",
                "--name-only",
                "-z"
            }
            if head == "" {
                args.Add("--cached")
            }
            args.Add(RepositoryIdentity.CommitSha(base))
            if head != "" {
                args.Add(RepositoryIdentity.CommitSha(head))
            }
            args.Add("--")
            let output = Commands.GitRaw(checkout, args.ToArray(), budget)
            if output == "" || !output.EndsWith("\0", StringComparison.Ordinal) {
                throw Exception("Contribution needs complete nonempty Git path evidence")
            }
            let paths = output.Split('\0')
            if paths.Length > 100001 {
                throw Exception("Contribution exceeds the bounded Git path diff")
            }
            for i in 0 ... paths.Length - 1 {
                Relative(paths[i])
                Check(policy, approval, paths[i])
            }
        }
    }
}
