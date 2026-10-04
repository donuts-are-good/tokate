package Tokate

import System
import System.Collections.Generic
import System.Globalization
import System.Text.Json
import System.Text.RegularExpressions

// GitHub's non-forced ref update is the compare-and-swap. Every proposed state
// commit has exactly the expected predecessor as its only parent.
internal class CoordinationState {
    internal var Sha string = ""
    internal let Fields Dictionary[string, Object?] = Dictionary[string, Object?]()
    internal func Value() JsonElement -> J.Parse(J.Write(Fields))

    internal func Write(repo string, issue int32, expected string, expires int64 = 0) {
        let tree = GitHub.Api(
            "repos/" + repo + "/git/trees",
            J.Map(
                "tree",
                []Object{J.Map("path", "state.json", "mode", "100644", "type", "blob", "content", J.Write(Fields))}
            ),
            expires: expires
        )
        let commit = GitHub.Api(
            "repos/" + repo + "/git/commits",
            GitHub.AutomationCommit(
                "Tokate coordination #" + issue.ToString(),
                J.Text(tree, "sha"),
                []string{expected}
            ),
            expires: expires
        )
        let next = J.Text(commit, "sha")
        if Sha == "" {
            GitHub.Api(
                "repos/" + repo + "/git/refs",
                J.Map("ref", "refs/heads/" + Ref(issue), "sha", next),
                expires: expires
            )
        } else {
            GitHub.Api(
                "repos/" + repo + "/git/refs/heads/" + Ref(issue),
                J.Map("sha", next, "force", false),
                "PATCH",
                expires: expires
            )
        }
        Sha = next
    }

    internal func Check(repo string, issue int32, donor string, actor JsonElement) JsonElement {
        let state = Value()
        let approval = J.Get(state, "approval")
        let task = GitHub.Issue(repo, issue)
        let assigned = J.Text(approval, "donor")
        let scoped = AccessState.Task(approval)
        if J.Bool(state, "revoked") || !GitHub.HasLabel(task) ||
            (
            !scoped &&
                (
                !GitHub.Assigned(task, assigned) ||
                    (donor != "" && !String.Equals(donor, assigned, StringComparison.OrdinalIgnoreCase))
            )
        ) ||
            J.Text(approval, "issue_hash") != GitHub.Fingerprint(task) {
            throw CliFailure("stale_approval", "Approval revoked, task changed, or donor is no longer eligible")
        }
        let configuration = ApprovalBase.Check(repo, approval, 2)
        let mode = Policy(J.Write(J.Get(configuration, "policy"))).Eligibility
        if scoped != (mode != "") || (scoped && J.Text(approval, "eligibility") != mode) {
            throw CliFailure("stale_approval", "Task eligibility declaration differs from current policy")
        }
        if scoped {
            AccessState.Check(repo, issue, approval, actor)
        }
        return J.Parse(
            J.Write(
                J.Map(
                    "approval",
                    approval,
                    "policy",
                    J.Get(configuration, "policy"),
                    "template",
                    J.Text(configuration, "template"),
                    "issue",
                    task
                )
            )
        )
    }

    internal func Reservation(actor JsonElement) {
        let reservation = J.Get(Value(), "reservation")
        if AccessState.Task(J.Get(Value(), "approval")) {
            RequestData.PositiveId(actor)
            RequestData.PositiveId(J.Get(reservation, "actor"))
        }
        if J.Get(reservation, "actor").ToString() != actor.ToString() ||
            Unix(reservation, "expires") <= DateTimeOffset
            .UtcNow
            .ToUnixTimeSeconds() {
            throw CliFailure("stale_approval", "Reservation expired or belongs to a replaced donor")
        }
    }

    shared {
        internal func Ref(issue int32) string -> "tokate/contributions/" + issue.ToString()

        internal func Unix(value JsonElement, key string) int64 {
            var result int64
            if !J.Get(value, key).TryGetInt64(out result) {
                throw Exception("Invalid coordination timestamp")
            }
            return result
        }

        internal func Load(repo string, issue int32, missing bool = false) CoordinationState {
            let result = CoordinationState()
            let reference = GitHub.Api("repos/" + repo + "/git/ref/heads/" + Ref(issue), missing: missing)
            if reference.ValueKind == JsonValueKind.Undefined {
                return result
            }
            result.Sha = Data.CommitSha(J.Text(J.Get(reference, "object"), "sha"))
            let value = RequestData.Parse(GitHub.FileAt(repo, "state.json", result.Sha), 1024 * 1024)
            if J.Number(value, "version") != 2 || J.Text(value, "repo") != repo || J.Number(value, "issue") != issue {
                throw Exception("Invalid version-2 coordination state")
            }
            for field in value.EnumerateObject() {
                result.Fields[field.Name] = field.Value.Clone()
            }
            return result
        }

        internal func Approve(repo string, issue int32, approval Object) {
            let state = Load(repo, issue, true)
            let expected = state.Sha == "" ? J.Text(J.Parse(J.Write(approval)), "base"): state.Sha
            state.Fields["version"] = 2
            state.Fields["repo"] = repo
            state.Fields["issue"] = issue
            state.Fields["approval"] = approval
            state.Fields["approval_id"] = Data.Hash(RequestData.Canonical(J.Parse(J.Write(approval))))
            state.Fields["revoked"] = false
            state.Fields["reservation"] = nil
            state.Fields["contribution"] = nil
            state.Fields["amendments"] = []Object{}
            if !state.Fields.ContainsKey("outcomes") {
                state.Fields["outcomes"] = []Object{}
            }
            state.Write(repo, issue, expected)
        }
    }
}
