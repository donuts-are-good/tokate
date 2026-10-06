package Tokate

import System
import System.IO

internal class RunStorage {
    shared {
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
            return J.Map(
                "retained_bytes",
                retainedBytes,
                "checkout_bytes",
                checkoutBytes,
                "measurement",
                "Regular-file bytes; symlinks are not followed; shared/reflink blocks are not deduplicated.",
                "next_safe_cleanup",
                run.Text("state") == "published" || run.Text("state") == "generated" ?
                "Keep this run for amendment and recovery. Once the work is accepted and evidence is backed up, explicitly delete only this run directory; later amendment will no longer be available. Do not delete ignored or untracked files.":
                "Keep the checkout and evidence for completion or no-inference recovery. Do not delete ignored or untracked files to reclaim space."
            )
        }
    }
}
