package Tokate

import System
import System.Text.Json

internal class RepositoryAccess {
    shared {
        internal func ValidateFork(repo string, metadata JsonElement, actor JsonElement) {
            let fork = RepositoryIdentity.Repo(J.Text(metadata, "fork"))
            let info = GitHub.Api("repos/" + fork)
            RepositoryAccess.ValidateRepository(repo, fork, actor, info, push: false)
            let reference = GitHub.Api("repos/" + fork + "/git/ref/heads/" + J.Text(metadata, "branch"))
            if J.Text(J.Get(reference, "object"), "sha") != J.Text(metadata, "head") {
                throw Exception("Fork branch does not point to the exact declared commit")
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
