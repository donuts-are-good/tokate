package Tokate

import Microsoft.Win32.SafeHandles
import System
import System.Collections.Generic
import System.IO
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text.Json

@DllImport("libc", EntryPoint: "open", SetLastError: true)
func EvidenceOpen(path string, flags int32) int32;

internal class OriginalEvidence {
    shared {
        private func FileHash(path string) string {
            using let stream = File.OpenRead(path)
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()
        }

        internal func CopyFile(source string, target string) {
            let descriptor = EvidenceOpen(source, 131072 | 2048)
            if descriptor < 0 {
                throw Exception("Cannot safely capture original evidence: " + source)
            }
            using let handle = SafeFileHandle(IntPtr(descriptor), true)
            using let input = FileStream(handle, FileAccess.Read)
            if !input.CanSeek {
                throw Exception("Original evidence must be a regular file: " + source)
            }
            using let output = FileStream(
                target,
                FileStreamOptions{
                    Mode: FileMode.CreateNew,
                    Access: FileAccess.Write,
                    Share: FileShare.None,
                    UnixCreateMode: UnixFileMode.UserRead | UnixFileMode.UserWrite
                }
            )
            input.CopyTo(output)
        }

        private func Inventory(directory string) Dictionary[string, Object?] {
            let files = Dictionary[string, Object?]()
            for path in Directory.EnumerateFileSystemEntries(directory) {
                if FileInfo(path).LinkTarget != nil {
                    throw Exception("Original archive contains a link")
                }
                if Directory.Exists(path) {
                    for entry in Inventory(path) {
                        files[Path.GetFileName(path) + "/" + entry.Key] = entry.Value
                    }
                } else {
                    files[Path.GetFileName(path)] = FileHash(path)
                }
            }
            return files
        }

        internal func VerificationArtifacts(directory string, target string) {
            LocalPaths.DirectoryPath(directory)
            for evidence in Directory.EnumerateFileSystemEntries(directory, "verification-*") {
                if FileInfo(evidence).LinkTarget != nil || !Directory.Exists(evidence) {
                    throw Exception("Original verification evidence must be real directories without links")
                }
                let destination = Path.Combine(target, Path.GetFileName(evidence))
                Directory.CreateDirectory(destination)
                for file in Directory.EnumerateFileSystemEntries(evidence) {
                    CopyFile(file, Path.Combine(destination, Path.GetFileName(file)))
                }
            }
        }

        private func VerificationReferences(directory string, checks JsonElement) {
            let root = LocalPaths.DirectoryPath(directory)
            for check in J.Items(checks) {
                for field in[]string{"output_file", "error_file"} {
                    let value = J.Get(check, field)
                    if value.ValueKind == JsonValueKind.Undefined {
                        continue
                    }
                    let relative = J.Text(check, field)
                    let path = Path.GetFullPath(Path.Combine(root, relative))
                    let failure = "Original recorded verification artifact is missing or outside its archive"
                    if relative == "" || Path.IsPathRooted(relative) || !path.StartsWith(
                        root + "/",
                        StringComparison.Ordinal
                    ) {
                        throw Exception(failure)
                    }
                    LocalPaths.DirectoryPath(Path.GetDirectoryName(path) ?? root)
                    if FileInfo(path).LinkTarget != nil || !File.Exists(path) {
                        throw Exception(failure)
                    }
                }
            }
        }

        internal func Seal(directory string) {
            VerificationReferences(directory, J.Get(Data.Load(directory).Element(), "verification"))
            let checks = Path.Combine(directory, "verification.json")
            if File.Exists(checks) {
                VerificationReferences(directory, J.Parse(File.ReadAllText(checks)))
            }
            let inventory = Inventory(directory)
            let manifest = RequestData.Canonical(J.Parse(J.Write(inventory)))
            File.WriteAllText(Path.Combine(directory, "manifest.json"), manifest + "\n")
            let seal = Data()
            seal.Fields["manifest_sha256"] = Data.Hash(manifest)
            seal.Write(Path.Combine(directory, "seal.json"))
        }

        internal func Load(directory string, run Data? = nil) Data {
            let archive = LocalPaths.DirectoryPath(Path.Combine(directory, "original-evidence"))
            let inventory = Inventory(archive)
            let manifest = File.ReadAllText(Path.Combine(archive, "manifest.json")).TrimEnd('\n')
            let seal = Data.Read(Path.Combine(archive, "seal.json"))
            inventory.Remove("manifest.json")
            inventory.Remove("seal.json")
            if Data.Hash(manifest) != seal.Text("manifest_sha256") || RequestData.Canonical(
                J.Parse(J.Write(inventory))
            ) != manifest {
                throw Exception(
                    "Original evidence archive changed or is incomplete; no silent reconstruction is allowed"
                )
            }
            let original = Data.Load(archive)
            if run != nil {
                for key in[]string{
                    "version",
                    "id",
                    "repo",
                    "issue",
                    "donor",
                    "donor_id",
                    "head_repo",
                    "approval",
                    "state_sha",
                    "base",
                    "base_branch",
                    "policy_hash",
                    "branch",
                    "model",
                    "effort",
                    "seconds",
                    "network",
                    "source",
                    "tools",
                    "usage",
                    "execution_seconds",
                    "elapsed_seconds",
                    "codex_version",
                    "inference_exit_code",
                    "turn_completed"
                } {
                    if key == "repo" || key == "head_repo" {
                        if !RepositoryIdentity.SameRepo(original.Text(key), run.Text(key)) {
                            throw Exception("Saved original authority changed: " + key)
                        }
                    } else if !RequestData.Same(J.Get(original.Element(), key), J.Get(run.Element(), key)) {
                        throw Exception("Saved original authority or execution attribution changed: " + key)
                    }
                }
            }
            return original
        }
    }
}
