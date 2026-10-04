package Tokate

import System
import System.Text.Json

internal class RepositoryAccess {
    shared {
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
            let owner = RequestData.PositiveId(J.Get(J.Get(info, "owner"), "id"))
            if owner != RequestData.PositiveId(actor) || !String.Equals(
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
                upstream.ValueKind != JsonValueKind.Undefined && RequestData.PositiveId(
                    J.Get(parent, "id")
                ) != RequestData.PositiveId(J.Get(upstream, "id"))
            ) {
                throw Exception("Head repository is not a fork of the selected upstream")
            }
        }
    }
}
