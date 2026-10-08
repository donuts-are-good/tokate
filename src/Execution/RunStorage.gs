package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class RunStorage {
    shared {
        internal func Root() string -> Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".local/state/tokate/runs"
        )

        internal func Discover() JsonElement {
            let rows = SortedDictionary[string, Object?](StringComparer.Ordinal)
            var skipped int32
            var scanned int32
            var truncated bool
            let root = Root()
            if Directory.Exists(root) {
                LocalPaths.DirectoryPath(root)
                for directory in Directory.EnumerateDirectories(root) {
                    if scanned >= 128 {
                        truncated = true
                        break
                    }
                    scanned++
                    try {
                        Preparation.ControlPaths(directory)
                        let value = RequestData.FileData(Path.Combine(directory, "run.json"), 1024 * 1024)
                        RepositoryIdentity.Repo(J.Text(value, "repo"))
                        for key in[]string{"id", "repo", "donor", "model", "state"} {
                            if J.Text(value, key).Length > 256 {
                                throw Exception("Saved contribution metadata is too long")
                            }
                        }
                        if J.Number(value, "issue") < 1 || J.Text(value, "state") == "" {
                            throw Exception("Incomplete saved contribution")
                        }
                        rows[directory] = map[string, Object?]{
                            "run": directory,
                            "id": J.Text(value, "id"),
                            "repo": J.Text(value, "repo"),
                            "issue": J.Number(value, "issue"),
                            "donor": J.Text(value, "donor"),
                            "model": J.Text(value, "model"),
                            "state": J.Text(value, "state")
                        }
                    } catch (error Exception) {
                        skipped++
                    }
                }
            }
            return J.Parse(
                J.Write(
                    map[string, Object?]{"runs": List[Object?](rows.Values), "skipped": skipped, "truncated": truncated}
                )
            )
        }

        private func Size(path string) int64 {
            if FileInfo(path).LinkTarget != nil {
                return 0
            }
            if !Directory.Exists(path) {
                return FileInfo(path).Length
            }
            var bytes int64
            for entry in Directory.EnumerateFileSystemEntries(path) {
                bytes += Size(entry)
            }
            return bytes
        }

        internal func Summary(directory string, run Data) Object {
            let root = LocalPaths.DirectoryPath(directory)
            let checkout = Path.Combine(root, "checkout")
            var retainedBytes int64
            var checkoutBytes int64
            for entry in Directory.EnumerateFileSystemEntries(root) {
                let bytes = Size(entry)
                retainedBytes += bytes
                if entry == checkout && Directory.Exists(entry) {
                    checkoutBytes = bytes
                }
            }
            return map[string, Object?]{
                "retained_bytes": retainedBytes,
                "checkout_bytes": checkoutBytes,
                "measurement": "Regular-file bytes; symlinks are not followed; shared/reflink blocks are not deduplicated.",
                "next_safe_cleanup": run.Text("state") == "published" || run.Text("state") == "generated" ?
                "Keep this run for amendment and recovery. Once the work is accepted and evidence is backed up, explicitly delete only this run directory; later amendment will no longer be available. Do not delete ignored or untracked files.":
                "Keep the checkout and evidence for completion or no-inference recovery. Do not delete ignored or untracked files to reclaim space."
            }
        }
    }
}
