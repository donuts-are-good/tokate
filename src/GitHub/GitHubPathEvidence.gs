package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class GitHubPathEvidence {
    shared {
        internal func Tree(repo string, head string) Dictionary[string, string] {
            let commit = GitHub.Api(
                "repos/" + RepositoryIdentity.Repo(repo) + "/git/commits/" + RepositoryIdentity.CommitSha(head)
            )
            if J.Text(commit, "sha") != head {
                throw Exception("Mismatched protected commit evidence")
            }
            let sha = RepositoryIdentity.CommitSha(J.Text(J.Get(commit, "tree"), "sha"))
            let value = GitHub.Api("repos/" + repo + "/git/trees/" + sha + "?recursive=1")
            if J.Text(value, "sha") != sha || J.Get(value, "truncated").ValueKind != JsonValueKind.False || J.Get(
                value,
                "tree"
            )
                .ValueKind != JsonValueKind.Array {
                throw Exception("Missing, truncated or mismatched protected tree evidence")
            }
            let entries = Dictionary[string, string](StringComparer.Ordinal)
            for entry in J.Get(value, "tree").EnumerateArray() {
                ProtectedPaths.AddTree(
                    entries,
                    J.Text(entry, "path"),
                    J.Text(entry, "mode"),
                    J.Text(entry, "type"),
                    J.Text(entry, "sha")
                )
            }
            ProtectedPaths.CompleteTree(entries)
            return entries
        }

        internal func Check(
            repo string,
            policy JsonElement,
            approval JsonElement,
            base string,
            fork string,
            head string
        ) {
            for path in Diff(repo, base, fork, head) {
                ProtectedPaths.Check(policy, approval, path)
            }
        }

        internal func Diff(repo string, base string, fork string, head string) HashSet[string] {
            RepositoryIdentity.Repo(repo)
            RepositoryIdentity.Repo(fork)
            RepositoryIdentity.CommitSha(base)
            RepositoryIdentity.CommitSha(head)
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
            let endpoints = HashSet[string](StringComparer.Ordinal)
            for file in files.EnumerateArray() {
                let path = J.Text(file, "filename")
                ProtectedPaths.Relative(path)
                if !filenames.Add(path) {
                    throw Exception("Duplicate GitHub file diff evidence")
                }
                endpoints.Add(path)
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
                    ProtectedPaths.Relative(name)
                    endpoints.Add(name)
                }
            }
            return endpoints
        }
    }
}
