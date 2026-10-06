package TokateTests

import System
import System.IO

internal class FixtureSnapshot : IDisposable {
    private let Storage Temp = Temp()
    private let Root string
    private let Baseline string

    internal init(root string) {
        Root = root
        Baseline = Path.Combine(Storage.Root, "baseline")
        try {
            Copy(Root, Baseline)
        } catch (error Exception) {
            Storage.Dispose()
            throw error
        }
    }

    private func Copy(source string, target string) {
        Directory.CreateDirectory(target)
        for path in Directory.GetFileSystemEntries(source) {
            let destination = Path.Combine(target, Path.GetFileName(path))
            let info = FileInfo(path)
            let directory = (info.Attributes & FileAttributes.Directory) != 0
            if info.LinkTarget != nil {
                if directory {
                    Directory.CreateSymbolicLink(destination, info.LinkTarget)
                } else {
                    File.CreateSymbolicLink(destination, info.LinkTarget)
                }
            } else if directory {
                Copy(path, destination)
            } else {
                File.Copy(path, destination)
                File.SetUnixFileMode(destination, File.GetUnixFileMode(path))
            }
        }
        File.SetUnixFileMode(target, File.GetUnixFileMode(source))
    }

    internal func Restore() {
        Directory.Delete(Root, true)
        Copy(Baseline, Root)
    }

    public func Dispose() -> Storage.Dispose()
}
