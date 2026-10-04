package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography

internal class FixtureSnapshot : IDisposable {
    private let Storage Temp = Temp()
    private let Root string
    private let Baseline string
    private let Evidence Dictionary[string, string] = Dictionary[string, string]()

    internal init(root string) {
        Root = root
        Baseline = Path.Combine(Storage.Root, "baseline")
        try {
            Copy(Root, Baseline)
            Record(Baseline, "", Evidence)
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

    private func Record(root string, prefix string, evidence Dictionary[string, string]) {
        for path in Directory.GetFileSystemEntries(root) {
            let name = Path.Combine(prefix, Path.GetFileName(path))
            let info = FileInfo(path)
            if info.LinkTarget != nil {
                evidence[name] = "link:" + info.LinkTarget
            } else {
                let mode = File.GetUnixFileMode(path).ToString()
                if (info.Attributes & FileAttributes.Directory) != 0 {
                    evidence[name] = "directory:" + mode
                    Record(path, name, evidence)
                } else {
                    evidence[name] = mode + ":" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
                }
            }
        }
    }

    internal func Restore() {
        Directory.Delete(Root, true)
        Copy(Baseline, Root)
        let restored = Dictionary[string, string]()
        Record(Root, "", restored)
        Check.That(restored.Count == Evidence.Count, "Fixture reset retained or lost paths")
        for entry in Evidence {
            Check.That(
                restored.ContainsKey(entry.Key) && restored[entry.Key] == entry.Value,
                "Fixture reset changed bytes, mode or link: " + entry.Key
            )
        }
    }

    public func Dispose() -> Storage.Dispose()
}
