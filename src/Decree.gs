package Tokate

import System
import System.Text
import System.Text.Json

internal class Decree {
    shared {
        internal func HasSnapshot(approval JsonElement) bool -> J.Get(approval, "decree").ValueKind !=
        JsonValueKind.Undefined

        internal func Capture(repo string, revision string) JsonElement {
            let commit = GitHub.Api("repos/" + repo + "/git/commits/" + Data.CommitSha(revision))
            let treeSha = Data.CommitSha(J.Text(J.Get(commit, "tree"), "sha"))
            return CaptureTree(repo, treeSha)
        }

        internal func CaptureTree(repo string, treeSha string) JsonElement {
            Data.CommitSha(treeSha)
            let tree = GitHub.Api("repos/" + repo + "/git/trees/" + treeSha)
            if J.Get(tree, "truncated").ValueKind != JsonValueKind.False || J.Get(tree, "tree")
                .ValueKind != JsonValueKind.Array ||
                J.Text(tree, "sha") != treeSha {
                throw Exception("DECREE.md discovery is unreadable or truncated")
            }
            var entry JsonElement
            for item in J.Items(J.Get(tree, "tree")) {
                if J.Text(item, "path") == "DECREE.md" {
                    if entry.ValueKind != JsonValueKind.Undefined {
                        throw Exception("Ambiguous root DECREE.md")
                    }
                    entry = item
                }
            }
            if entry.ValueKind == JsonValueKind.Undefined {
                return J.Parse(J.Write(J.Map("present", false, "sha256", nil, "text", "")))
            }
            let mode = J.Text(entry, "mode")
            if (mode != "100644" && mode != "100755") || J.Text(entry, "type") != "blob" {
                throw Exception(
                    "DECREE.md must be a regular Git blob (100644 or 100755); links, directories and submodules are unsupported"
                )
            }
            var size int32
            if J.Get(entry, "size").ValueKind != JsonValueKind.Number || !J.Get(entry, "size").TryGetInt32(out size) ||
                size < 0 ||
                size > 65536 {
                throw Exception("DECREE.md must be at most 64 KiB of source bytes")
            }
            let sha = Data.CommitSha(J.Text(entry, "sha"))
            var blob JsonElement
            try {
                blob = GitHub.Api("repos/" + repo + "/git/blobs/" + sha)
            } catch (error Exception) {
                throw Exception("DECREE.md blob is unreadable. " + error.Message)
            }
            var blobSize int32
            if J.Text(blob, "sha") != sha || J.Text(blob, "encoding") != "base64" || J.Get(blob, "content")
                .ValueKind != JsonValueKind.String ||
                J
                .Get(blob, "size").ValueKind != JsonValueKind.Number || !J.Get(blob, "size").TryGetInt32(
                out blobSize
            ) ||
                blobSize != size {
                throw Exception("DECREE.md blob is unreadable or incomplete")
            }
            var bytes[]byte
            try {
                bytes = Convert.FromBase64String(J.Text(blob, "content"))
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
            return J.Parse(J.Write(J.Map("present", true, "sha256", Data.Hash(text), "text", text)))
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
            if (present.ValueKind != JsonValueKind.True && present.ValueKind != JsonValueKind.False) || J.Get(
                snapshot,
                "text"
            )
                .ValueKind != JsonValueKind.String {
                throw Exception("Invalid approved DECREE.md snapshot")
            }
            let text = J.Text(snapshot, "text")
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
            } catch (error Exception) {
                throw Exception(
                    "Current DECREE.md is unsupported or unreadable; fresh owner approval is required. " + error.Message
                )
            }
            if J.Bool(current, "present") != J.Bool(approved, "present") || J.Text(current, "sha256") != J.Text(
                approved,
                "sha256"
            ) {
                throw Exception("DECREE.md changed; fresh owner approval is required")
            }
        }

        internal func Protected(path string, approval JsonElement) bool -> HasSnapshot(approval) &&
            (path == "DECREE.md" || path.StartsWith("DECREE.md/"))
    }
}
