package Tokate

import System
import System.Text.Json

internal class RepositoryAccess {
    shared {
        internal func ValidateFork(repo string, metadata JsonElement, actor JsonElement) JsonElement {
            let fork = RepositoryIdentity.Repo(J.Text(metadata, "fork"))
            let info = GitHub.Api("repos/" + fork)
            RepositoryAccess.ValidateRepository(
                repo,
                fork,
                actor,
                info,
                push: false,
                upstream: GitHub.Api("repos/" + repo)
            )
            let reference = GitHub.Api("repos/" + fork + "/git/ref/heads/" + J.Text(metadata, "branch"))
            if J.Text(J.Get(reference, "object"), "sha") != J.Text(metadata, "head") {
                throw Exception("Fork branch does not point to the exact declared commit")
            }
            return info
        }

        internal func ValidateRun(run Data) {
            let repo = RepositoryIdentity.Repo(run.Text("repo"))
            let head = RepositoryIdentity.Repo(run.Text("head_repo"))
            let upstream = GitHub.Api("repos/" + repo)
            let info = RepositoryIdentity.SameRepo(repo, head) ? upstream: GitHub.Api("repos/" + head)
            let saved = run.Element()
            ValidateRepository(repo, head, J.Get(saved, "donor_id"), info, upstream: upstream)
            for binding in[]string{"preparation_repo_id", "preparation_head_id"} {
                let expected = J.Get(saved, binding)
                if expected.ValueKind != JsonValueKind.Undefined && RepositoryIdentity.PositiveId(expected) !=
                RepositoryIdentity.PositiveId(J.Get(binding == "preparation_repo_id" ? upstream: info, "id")) {
                    throw Exception("Saved contribution repository identity changed")
                }
            }
        }

        internal func RequireOwner(repo string) JsonElement {
            let info = GitHub.Api("repos/" + repo)
            if !J.Bool(J.Get(info, "permissions"), "push") {
                throw Exception("Repository write permission is required")
            }
            return info
        }

        internal func ValidateRepository(
            repo string,
            head string,
            actor JsonElement,
            info JsonElement,
            push bool = true,
            upstream JsonElement = default(JsonElement)
        ) {
            RepositoryIdentity.PositiveId(J.Get(info, "id"))
            if upstream.ValueKind != JsonValueKind.Undefined && !RepositoryIdentity.SameRepo(
                J.Text(upstream, "full_name"),
                repo
            ) {
                throw Exception("Selected upstream repository identity changed")
            }
            let owner = RepositoryIdentity.PositiveId(J.Get(J.Get(info, "owner"), "id"))
            if owner != RepositoryIdentity.PositiveId(actor) || !String.Equals(
                J.Text(info, "full_name"),
                head,
                StringComparison.OrdinalIgnoreCase
            ) ||
                (push && !J.Bool(J.Get(info, "permissions"), "push")) {
                throw Exception("Head repository must be writable and numerically owned by the authenticated donor")
            }
            if String.Equals(head, repo, StringComparison.OrdinalIgnoreCase) {
                return
            }
            let parent = J.Get(info, "parent")
            if !J.Bool(info, "fork") || !String.Equals(
                J.Text(parent, "full_name"),
                repo,
                StringComparison.OrdinalIgnoreCase
            ) ||
                (
                upstream.ValueKind != JsonValueKind.Undefined && RepositoryIdentity.PositiveId(
                    J.Get(parent, "id")
                ) != RepositoryIdentity.PositiveId(J.Get(upstream, "id"))
            ) {
                throw Exception("Head repository is not a fork of the selected upstream")
            }
        }
    }
}
