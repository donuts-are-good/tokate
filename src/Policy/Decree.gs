package Tokate

import System
import System.Text
import System.Text.Json

internal class Decree {
    shared {
        internal func HasSnapshot(approval JsonElement) bool -> J.Get(approval, "decree").ValueKind !=
        JsonValueKind.Undefined

        internal func Capture(repo string, revision string) JsonElement {
            let commit = GitHub.Api("repos/" + repo + "/git/commits/" + RepositoryIdentity.CommitSha(revision))
            let treeSha = RepositoryIdentity.CommitSha(J.Text(J.Get(commit, "tree"), "sha"))
            return CaptureTree(repo, treeSha)
        }

        internal func CaptureTree(repo string, treeSha string) JsonElement {
            RepositoryIdentity.CommitSha(treeSha)
            let tree = GitHub.Api("repos/" + repo + "/git/trees/" + treeSha)
            let entries = J.Get(tree, "tree")
            if J.Get(tree, "truncated")
                .ValueKind != JsonValueKind.False ||
                entries.ValueKind != JsonValueKind.Array ||
                J.Text(tree, "sha") != treeSha {
                throw Exception("DECREE.md discovery is unreadable or truncated")
            }
            var entry JsonElement
            for item in J.Items(entries) {
                if J.Text(item, "path") == "DECREE.md" {
                    if entry.ValueKind != JsonValueKind.Undefined {
                        throw Exception("Ambiguous root DECREE.md")
                    }
                    entry = item
                }
            }
            if entry.ValueKind == JsonValueKind.Undefined {
                return J.Parse(J.Write(map[string, Object?]{"present": false, "sha256": nil, "text": ""}))
            }
            let mode = J.Text(entry, "mode")
            if (mode != "100644" && mode != "100755") || J.Text(entry, "type") != "blob" {
                throw Exception(
                    "DECREE.md must be a regular Git blob (100644 or 100755); links, directories and submodules are unsupported"
                )
            }
            let sourceSize = J.Get(entry, "size")
            var size int32
            if sourceSize.ValueKind != JsonValueKind.Number || !sourceSize.TryGetInt32(out size) ||
                size < 0 ||
                size > 65536 {
                throw Exception("DECREE.md must be at most 64 KiB of source bytes")
            }
            let sha = RepositoryIdentity.CommitSha(J.Text(entry, "sha"))
            var blob JsonElement
            try {
                blob = GitHub.Api("repos/" + repo + "/git/blobs/" + sha)
            } catch (error ApiDeadlineException) {
                throw error
            } catch (error Exception) {
                throw Exception("DECREE.md blob is unreadable. " + error.Message)
            }
            let content = J.Get(blob, "content")
            let declaredSize = J.Get(blob, "size")
            var blobSize int32
            if J.Text(blob, "sha") != sha || J.Text(blob, "encoding") != "base64" ||
                content.ValueKind != JsonValueKind.String ||
                declaredSize.ValueKind != JsonValueKind.Number ||
                !declaredSize.TryGetInt32(out blobSize) || blobSize != size {
                throw Exception("DECREE.md blob is unreadable or incomplete")
            }
            var bytes[]byte
            try {
                bytes = Convert.FromBase64String(content.GetString() ?? "")
            } catch {
                throw Exception("DECREE.md blob is not readable base64")
            }
            if bytes.Length != size {
                throw Exception("DECREE.md blob is truncated or has an incorrect size")
            }
            var text string
            try {
                text = UTF8Encoding(false, true).GetString(bytes)
            } catch {
                throw Exception("DECREE.md must be strict UTF-8")
            }
            ValidateText(text)
            return J.Parse(J.Write(map[string, Object?]{"present": true, "sha256": Data.Hash(text), "text": text}))
        }

        private func ValidateText(text string) {
            var size int32
            try {
                size = UTF8Encoding(false, true).GetByteCount(text)
            } catch {
                throw Exception("DECREE.md must be strict UTF-8")
            }
            if size > 65536 || text.Contains('\0') {
                throw Exception("DECREE.md must be at most 64 KiB of UTF-8 without NUL")
            }
            if text.TrimStart('\uFEFF').StartsWith("version https://git-lfs.github.com/spec/v1") {
                throw Exception("DECREE.md Git LFS pointers are unsupported")
            }
        }

        internal func Validate(snapshot JsonElement) JsonElement {
            RequestData.Keys(snapshot, "present,sha256,text")
            let present = J.Get(snapshot, "present")
            let approvedText = J.Get(snapshot, "text")
            if (present.ValueKind != JsonValueKind.True && present.ValueKind != JsonValueKind.False) ||
                approvedText.ValueKind != JsonValueKind.String {
                throw Exception("Invalid approved DECREE.md snapshot")
            }
            let text = approvedText.GetString() ?? ""
            if !J.Bool(snapshot, "present") {
                if J.Get(snapshot, "sha256").ValueKind != JsonValueKind.Null || text != "" {
                    throw Exception("Invalid absent DECREE.md snapshot")
                }
            } else {
                ValidateText(text)
                if J.Text(snapshot, "sha256") != Data.Hash(text) {
                    throw Exception("Approved DECREE.md text differs from its SHA-256")
                }
            }
            return snapshot
        }

        internal func CheckCurrent(repo string, revision string, approval JsonElement) {
            if !HasSnapshot(approval) {
                return
            }
            let approved = Validate(J.Get(approval, "decree"))
            if revision == J.Text(approval, "base") {
                return
            }
            var current JsonElement
            try {
                current = Capture(repo, revision)
            } catch (error ApiDeadlineException) {
                throw error
            } catch (error Exception) {
                throw Exception(
                    "Current DECREE.md is unsupported or unreadable; fresh owner approval is required. " + error.Message
                )
            }
            if J.Bool(current, "present") != J.Bool(approved, "present") || J.Text(current, "sha256") != J.Text(
                approved,
                "sha256"
            ) {
                throw CliFailure("stale_approval", "DECREE.md changed; fresh owner approval is required")
            }
        }

        internal func Protected(path string, approval JsonElement) bool -> HasSnapshot(approval) &&
            (path == "DECREE.md" || path.StartsWith("DECREE.md/"))
    }
}
