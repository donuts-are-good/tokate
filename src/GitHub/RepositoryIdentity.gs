package Tokate

import System
import System.Text.Json
import System.Text.RegularExpressions

internal class RepositoryIdentity {
    shared {
        internal func PositiveId(value JsonElement) int64 {
            var id int64
            if !value.TryGetInt64(out id) || id < 1 {
                throw Exception("Expected a positive numeric GitHub identity")
            }
            return id
        }

        internal func Repo(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$") {
                throw Exception("Use OWNER/REPO")
            }
            return value
        }

        internal func SameRepo(left string, right string) bool ->
        String.Equals(left, right, StringComparison.OrdinalIgnoreCase)

        internal func IsIssueUrl(value string, repo string, number int32) bool {
            let prefix = "https://api.github.com/repos/"
            let suffix = "/issues/" + number.ToString()
            if value.Length <= prefix.Length + suffix.Length || !value.StartsWith(prefix, StringComparison.Ordinal) ||
                !value.EndsWith(suffix, StringComparison.Ordinal) {
                return false
            }
            let repository = value.Substring(prefix.Length, value.Length - prefix.Length - suffix.Length)
            return SameRepo(repository, repo)
        }

        internal func CommitSha(value string) string {
            if value.Length != 40 || !Regex.IsMatch(value, "^[0-9a-f]{40}$") {
                throw Exception("Expected an exact 40-character Git commit SHA")
            }
            return value
        }

        internal func Branch(value string) string {
            if value == "" || value == "@" || value.StartsWith("-") || value.EndsWith(".") || value.Contains("..") ||
                value.Contains("@{") || Regex.IsMatch(value, "[\\x00-\\x20\\x7f~^:?*\\\\\\[]") {
                throw Exception("Expected a Git branch name")
            }
            for part in value.Split('/') {
                if part == "" || part.StartsWith(".") || part.EndsWith(".lock") {
                    throw Exception("Expected a Git branch name")
                }
            }
            return value
        }

        internal func Login(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9-]*$") {
                throw Exception("Invalid GitHub username")
            }
            return value
        }

        internal func SameDonor(viewer JsonElement, run Data) bool ->
        String.Equals(J.Text(viewer, "login"), run.Text("donor"), StringComparison.OrdinalIgnoreCase) && J.Get(
            viewer,
            "id"
        )
            .ToString() == J.Get(run.Element(), "donor_id").ToString()
    }
}
