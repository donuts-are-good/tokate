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

        private func ApplyTask(args Args, value string, key string, segment string) {
            let uri = Uri(value)
            let match = Regex.Match(
                uri.AbsolutePath,
                "^/([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*)/" + segment + "/([0-9]+)/?$"
            )
            if uri.Scheme != "https" || !String.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase) ||
                !uri.IsDefaultPort ||
                uri.UserInfo != "" ||
                !match.Success {
                throw Exception("Use a GitHub " + key + " URL: https://github.com/OWNER/REPO/" + segment + "/N")
            }
            let repo = RepositoryIdentity.Repo(match.Groups[1].Value)
            let number = match.Groups[2].Value
            var parsed int32
            if !int32.TryParse(number, out parsed) || parsed < 1 {
                throw Exception("Invalid positive number in task URL")
            }
            if args.Get("repo") != "" && !String.Equals(args.Get("repo"), repo, StringComparison.OrdinalIgnoreCase) {
                throw Exception("Task URL conflicts with --repo")
            }
            if args.Get(key) != "" && args.Number(key) != parsed {
                throw Exception("Task URL conflicts with --" + key)
            }
            args.Values["--repo"] = repo
            args.Values["--" + key] = number
        }

        internal func Issue(args Args) {
            let issue = args.Get("issue")
            if issue.Contains("://") {
                args.Values.Remove("--issue")
                ApplyTask(args, issue, "issue", "issues")
            } else if issue != "" {
                args.Number("issue")
            }
            if args.Target != "" {
                let command = Cli.Find(args.Command)
                if args.Target.Contains("/issues/") && command.Has("issue") {
                    ApplyTask(args, args.Target, "issue", "issues")
                } else if args.Target.Contains("/pull/") && command.Has("pr") {
                    ApplyTask(args, args.Target, "pr", "pull")
                } else {
                    let repo = Repo(args.Target)
                    if args.Get("repo") != "" && !String.Equals(
                        args.Get("repo"),
                        repo,
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        throw Exception("Repository argument conflicts with --repo")
                    }
                    args.Values["--repo"] = repo
                }
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
