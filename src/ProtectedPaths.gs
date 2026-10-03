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
            args.Add(Data.CommitSha(base))
            if head != "" {
                args.Add(Data.CommitSha(head))
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

        internal func Remote(
            repo string,
            policy JsonElement,
            approval JsonElement,
            base string,
            fork string,
            head string
        ) {
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
                J.Text(J.Get(comparison, "merge_base_commit"), "sha") != base || commits.Count == 0 || J.Text(
                commits[commits.Count - 1],
                "sha"
            ) != head ||
                files.ValueKind != JsonValueKind.Array ||
                files.GetArrayLength() == 0 || files.GetArrayLength() >= 300 {
                throw Exception("Missing, truncated or mismatched approved-base-to-head diff evidence")
            }
            let filenames = HashSet[string](StringComparer.Ordinal)
            for file in files.EnumerateArray() {
                let path = J.Text(file, "filename")
                Relative(path)
                Check(policy, approval, path)
                if !filenames.Add(path) {
                    throw Exception("Duplicate GitHub file diff evidence")
                }
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
                    Check(policy, approval, name)
                }
            }
        }
    }
}
