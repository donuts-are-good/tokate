package Tokate

import System
import System.Collections.Generic
import System.Text
import System.Text.Json

internal class GitHub {
    shared {
        internal func AutomationCommit(message string, tree string, parents IEnumerable[string]) Object {
            let identity = J.Map("name", "Tokate", "email", "tokate@users.noreply.github.com")
            return J.Map(
                "message",
                message,
                "tree",
                tree,
                "parents",
                parents,
                "author",
                identity,
                "committer",
                identity
            )
        }

        internal suspend func Api(
            path string,
            body Object? = nil,
            method string = "",
            missing bool = false,
            expires int64 = 0
        ) JsonElement -> ApiTransport.Request(path, body, method, missing, expires)

        internal func FileAt(repo string, path string, revision string) string {
            let result = Api("repos/" + repo + "/contents/" + path + "?ref=" + Uri.EscapeDataString(revision))
            if J.Text(result, "encoding") != "base64" {
                throw Exception("Expected a small repository configuration file")
            }
            return Encoding.UTF8.GetString(Convert.FromBase64String(J.Text(result, "content")))
        }

        internal func Branch(repo string, branch string) string -> RepositoryIdentity.CommitSha(
            J.Text(
                J.Get(
                    Api("repos/" + repo + "/git/ref/heads/" + Uri.EscapeDataString(RepositoryIdentity.Branch(branch))),
                    "object"
                ),
                "sha"
            )
        )

        internal func Issue(repo string, number int32) JsonElement {
            let issue = Api("repos/" + repo + "/issues/" + number.ToString())
            if J.Text(issue, "state") != "open" || J.Get(issue, "pull_request").ValueKind != JsonValueKind.Undefined {
                throw Exception("Choose an open issue")
            }
            return issue
        }

        internal func HasLabel(issue JsonElement) bool {
            for label in J.Items(J.Get(issue, "labels")) {
                if J.Text(label, "name") == "tokate:approved" {
                    return true
                }
            }
            return false
        }

        internal func Assigned(issue JsonElement, donor string) bool {
            let people = J.Items(J.Get(issue, "assignees"))
            return people.Count == 1 && String.Equals(
                J.Text(people[0], "login"),
                donor,
                StringComparison.OrdinalIgnoreCase
            )
        }

        internal func Fingerprint(issue JsonElement) string -> Data.Hash(
            J.Write(J.Map("title", J.Text(issue, "title"), "body", J.Text(issue, "body")))
        )
    }
}
