package Tokate

import System
import System.Collections.Generic
import System.Security.Cryptography
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

        private func Relative(path string) {
            for segment in path.Split('/') {
                if segment == "" || segment == "." || segment == ".." || segment.Contains('\0') {
                    throw Exception("Expected a literal repository-relative slash path")
                }
            }
        }

        private func Matches(entry string, path string) bool {
            if entry.EndsWith("/", StringComparison.Ordinal) {
                return path == entry.Substring(0, entry.Length - 1) || path.StartsWith(entry, StringComparison.Ordinal)
            }
            return path == entry
        }

        internal func Check(policy JsonElement, path string) {
            if Matches(".github/workflows/", path) || path.StartsWith(".github/tokate", StringComparison.Ordinal) {
                throw Exception("Contribution changes protected owner configuration: " + J.Write(path))
            }
            for entry in J.Items(J.Get(policy, "protected_paths")) {
                if Matches(entry.GetString() ?? "", path) {
                    throw Exception("Contribution changes protected owner path: " + J.Write(path))
                }
            }
        }

        internal func Local(checkout string, policy JsonElement, base string, head string = "") {
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
            args.Add(Data.CommitSha(base))
            if head != "" {
                args.Add(Data.CommitSha(head))
            }
            args.Add("--")
            let output = Commands.GitRaw(checkout, args.ToArray())
            if output == "" || !output.EndsWith("\0", StringComparison.Ordinal) {
                throw Exception("Contribution needs complete nonempty Git path evidence")
            }
            let paths = output.Split('\0')
            if paths.Length > 100001 {
                throw Exception("Contribution exceeds the bounded Git path diff")
            }
            for i in 0 ... paths.Length - 1 {
                Relative(paths[i])
                Check(policy, paths[i])
            }
        }

        internal func Remote(repo string, policy JsonElement, base string, fork string, head string) {
            Data.Repo(repo)
            Data.Repo(fork)
            Data.CommitSha(base)
            Data.CommitSha(head)
            let comparison = GitHub.Api("repos/" + repo + "/compare/" + base + "..." + fork.Split('/')[0] + ":" + head)
            let files = J.Get(comparison, "files")
            let commits = J.Items(J.Get(comparison, "commits"))
            if J.Text(comparison, "status") != "ahead" || J.Get(comparison, "behind_by")
                .ValueKind != JsonValueKind.Number ||
                J.Number(comparison, "behind_by") != 0 || J.Text(J.Get(comparison, "base_commit"), "sha") != base ||
                J.Text(J.Get(comparison, "merge_base_commit"), "sha") != base ||
                commits.Count == 0 ||
                commits.Count > 250 ||
                commits.Count != J.Number(comparison, "total_commits") || commits.Count != J.Number(
                comparison,
                "ahead_by"
            ) ||
                J.Text(commits[commits.Count - 1], "sha") != head ||
                files.ValueKind != JsonValueKind.Array ||
                files.GetArrayLength() == 0 || files.GetArrayLength() >= 300 {
                throw Exception("Missing, truncated or mismatched approved-base-to-head diff evidence")
            }
            let covered = HashSet[string](StringComparer.Ordinal)
            let filenames = HashSet[string](StringComparer.Ordinal)
            for file in files.EnumerateArray() {
                let path = J.Text(file, "filename")
                Relative(path)
                Check(policy, path)
                if !filenames.Add(path) {
                    throw Exception("Duplicate GitHub file diff evidence")
                }
                covered.Add(path)
                let status = J.Text(file, "status")
                if status != "added" &&
                    status != "removed" &&
                    status != "modified" &&
                    status != "renamed" &&
                    status != "changed" &&
                    status != "copied" {
                    throw Exception("Missing GitHub file diff status")
                }
                let previous = J.Get(file, "previous_filename")
                if status == "renamed" || previous.ValueKind != JsonValueKind.Undefined {
                    let name = J.Text(file, "previous_filename")
                    Relative(name)
                    Check(policy, name)
                    covered.Add(name)
                }
            }
            let before = Tree(repo, J.Text(J.Get(J.Get(J.Get(comparison, "base_commit"), "commit"), "tree"), "sha"))
            let after = Tree(fork, J.Text(J.Get(J.Get(commits[commits.Count - 1], "commit"), "tree"), "sha"))
            var changed int32
            for entry in before {
                var value string
                if !after.TryGetValue(entry.Key, out value) || value != entry.Value {
                    Check(policy, entry.Key)
                    if !covered.Contains(entry.Key) {
                        throw Exception("Incomplete GitHub file diff evidence")
                    }
                    changed++
                }
            }
            for entry in after {
                if !before.ContainsKey(entry.Key) {
                    Check(policy, entry.Key)
                    if !covered.Contains(entry.Key) {
                        throw Exception("Incomplete GitHub file diff evidence")
                    }
                    changed++
                }
            }
            if changed == 0 {
                throw Exception("Contribution must change the approved base")
            }
        }

        private func Order(left JsonElement, right JsonElement) int32 {
            let a = Utf8.GetBytes(Name(left) + (J.Text(left, "type") == "tree" ? "/": ""))
            let b = Utf8.GetBytes(Name(right) + (J.Text(right, "type") == "tree" ? "/": ""))
            for i in 0 ... Math.Min(a.Length, b.Length) {
                if a[i] != b[i] {
                    return Convert.ToInt32(a[i]) - Convert.ToInt32(b[i])
                }
            }
            return a.Length - b.Length
        }

        private func Name(entry JsonElement) string {
            let path = J.Text(entry, "path")
            return path.Substring(path.LastIndexOf('/') + 1)
        }

        private func Tree(repo string, sha string) Dictionary[string, string] {
            Data.CommitSha(sha)
            let response = GitHub.Api("repos/" + repo + "/git/trees/" + sha + "?recursive=1")
            let tree = J.Get(response, "tree")
            if J.Text(response, "sha") != sha || J.Get(response, "truncated")
                .ValueKind != JsonValueKind.False ||
                tree.ValueKind != JsonValueKind.Array ||
                tree.GetArrayLength() > 100000 {
                throw Exception("Missing, truncated or mismatched GitHub tree evidence")
            }
            let entries = Dictionary[string, JsonElement](StringComparer.Ordinal)
            let children = Dictionary[string, List[JsonElement]](StringComparer.Ordinal)
            children[""] = List[JsonElement]()
            let leaves = Dictionary[string, string](StringComparer.Ordinal)
            for entry in tree.EnumerateArray() {
                let path = J.Text(entry, "path")
                Relative(path)
                Utf8.GetBytes(path)
                if !entries.TryAdd(path, entry) {
                    throw Exception("Duplicate GitHub tree path")
                }
                let mode = J.Text(entry, "mode")
                let type = J.Text(entry, "type")
                Data.CommitSha(J.Text(entry, "sha"))
                if type == "tree" && mode == "040000" {
                    children[path] = List[JsonElement]()
                } else if (type == "blob" && (mode == "100644" || mode == "100755" || mode == "120000")) ||
                    (type == "commit" && mode == "160000") {
                    leaves[path] = mode + " " + type + " " + J.Text(entry, "sha")
                } else {
                    throw Exception("Invalid GitHub tree mode/type evidence")
                }
            }
            for entry in entries {
                let slash = entry.Key.LastIndexOf('/')
                let parent = slash < 0 ? "": entry.Key.Substring(0, slash)
                var list List[JsonElement]
                if !children.TryGetValue(parent, out list) {
                    throw Exception("Incomplete GitHub tree ancestry")
                }
                list.Add(entry.Value)
            }
            for directory in children {
                directory.Value.Sort(Order)
                let bytes = List[byte]()
                for entry in directory.Value {
                    bytes.AddRange(Utf8.GetBytes(J.Text(entry, "mode").TrimStart('0') + " " + Name(entry) + "\0"))
                    bytes.AddRange(Convert.FromHexString(J.Text(entry, "sha")))
                }
                let content = List[byte](Utf8.GetBytes("tree " + bytes.Count.ToString() + "\0"))
                content.AddRange(bytes)
                let expected = directory.Key == "" ? sha: J.Text(entries[directory.Key], "sha")
                if Convert.ToHexString(SHA1.HashData(content.ToArray())).ToLowerInvariant() != expected {
                    throw Exception("Incomplete or tampered GitHub tree evidence")
                }
            }
            return leaves
        }
    }
}
