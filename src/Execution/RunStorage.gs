package Tokate

import System
import System.IO

internal class RunStorage {
    shared {
        private func Size(directory string) int64 {
            var bytes int64
            for entry in Directory.EnumerateFileSystemEntries(directory) {
                if FileInfo(entry).LinkTarget != nil {
                    continue
                }
                bytes += Directory.Exists(entry) ? Size(entry): FileInfo(entry).Length
            }
            return bytes
        }

        internal func Summary(directory string, run Data) Object {
            let root = LocalPaths.DirectoryPath(directory)
            let checkout = Path.Combine(root, "checkout")
            let checkoutBytes = Directory.Exists(checkout) && FileInfo(checkout).LinkTarget == nil ? Size(checkout): 0
            return J.Map(
                "retained_bytes",
                Size(root),
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
