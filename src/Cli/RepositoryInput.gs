package Tokate

import System
import System.Collections.Generic
import System.ComponentModel
import System.IO
import System.Text
import System.Text.RegularExpressions

internal class RepositoryInput {
    shared {
        internal func Repo(value string) string {
            var normalized = value
            if value.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase) {
                let uri = Uri(value)
                if uri.Query != "" || uri.Fragment != "" {
                    throw Exception("Use a GitHub repository URL without query or fragment")
                }
                normalized = uri.AbsolutePath.Trim('/')
                if normalized.EndsWith(".git") {
                    normalized = normalized.Substring(0, normalized.Length - 4)
                }
            }
            return RepositoryIdentity.Repo(normalized)
        }

        internal func ApplyIssue(args Args, value string) {
            let uri = Uri(value)
            let match = Regex.Match(
                uri.AbsolutePath,
                "^/([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*)/issues/([0-9]+)/?$"
            )
            if uri.Scheme != "https" || !String.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase) ||
                !uri.IsDefaultPort ||
                uri.UserInfo != "" ||
                !match.Success {
                throw Exception("Use a GitHub issue URL: https://github.com/OWNER/REPO/issues/N")
            }
            let repo = RepositoryIdentity.Repo(match.Groups[1].Value)
            let number = match.Groups[2].Value
            var parsed int32
            if !int32.TryParse(number, out parsed) || parsed < 1 {
                throw Exception("Invalid positive number in issue URL")
            }
            if args.Get("repo") != "" && !String.Equals(args.Get("repo"), repo, StringComparison.OrdinalIgnoreCase) {
                throw Exception("Issue URL conflicts with --repo")
            }
            if args.Get("issue") != "" && args.Number("issue") != parsed {
                throw Exception("Issue URL conflicts with --issue")
            }
            args.Values["--repo"] = repo
            args.Values["--issue"] = number
            args.Number("issue")
        }

        internal func Issue(args Args) {
            let issue = args.Get("issue")
            if issue.Contains("://") {
                args.Values.Remove("--issue")
                ApplyIssue(args, issue)
            } else if issue != "" {
                args.Number("issue")
            }
            if args.IssueUrl != "" {
                ApplyIssue(args, args.IssueUrl)
            }
        }

        internal func Local() string {
            var result CommandResult
            try {
                result = Commands.Run(
                    "git",
                    []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "remote", "-v"},
                    seconds: 5
                )
            } catch (error Win32Exception) {
                throw Exception("Local Git is unavailable; use --repo OWNER/REPO")
            }
            if result.Code != 0 {
                throw Exception("Cannot determine a local repository; use --repo OWNER/REPO")
            }
            var repo string = ""
            for line in result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries) {
                let fields = line.Split([]char{' ', '\t'}, StringSplitOptions.RemoveEmptyEntries)
                let url = fields.Length >= 2 ? fields[1]: ""
                let match = Regex.Match(
                    url,
                    "^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\\.git)?/?$",
                    RegexOptions.IgnoreCase
                )
                if !match.Success {
                    throw Exception("Ambiguous or unsupported local remotes; use --repo OWNER/REPO")
                }
                let candidate = RepositoryIdentity.Repo(match.Groups[1].Value)
                if repo != "" && !String.Equals(repo, candidate, StringComparison.OrdinalIgnoreCase) {
                    throw Exception("Ambiguous local remotes; use --repo OWNER/REPO")
                }
                repo = candidate
            }
            if repo == "" {
                throw Exception("No GitHub remote found; use --repo OWNER/REPO")
            }
            return repo
        }
    }
}
