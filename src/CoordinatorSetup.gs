package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text.Json
import System.Text.RegularExpressions

internal class CoordinatorSetup {
    shared {
        internal func Run(args Args) {
            let repo = Data.Repo(args.Need("repo"))
            let requested = Path.GetFullPath(args.Need("output"))
            let output = Path.Combine(
                Worker.CanonicalPath(
                    Path.GetDirectoryName(requested) ?? throw Exception("Output needs a parent directory")
                ),
                Path.GetFileName(requested)
            )
            if output.Contains("/.github/") || File.Exists(output) || Directory.Exists(output) || FileInfo(
                output
            ).LinkTarget != nil {
                throw Exception(
                    "Generate to a new file outside protected .github paths; installation is an owner action after release"
                )
            }
            let info = Workflow.RequireOwner(repo)
            let existing = GitHub.Api(
                "repos/" + repo + "/contents/.github/workflows/tokate-coordinator.yml?ref=" + Uri.EscapeDataString(
                    J.Text(info, "default_branch")
                ),
                missing: true
            )
            if existing.ValueKind != JsonValueKind.Undefined {
                throw Exception("Coordinator workflow already exists; refusing replacement")
            }
            let version = Data.Version()
            let release = GitHub.Api("repos/obselate/tokate/releases/tags/v" + version, missing: true)
            if release.ValueKind == JsonValueKind.Undefined || J.Bool(release, "draft") || J.Bool(
                release,
                "prerelease"
            ) ||
                J.Text(release, "tag_name") != "v" + version {
                throw Exception("This binary version has no trusted stable release; setup is unavailable until release")
            }
            let bundle = "tokate-" + version + "-linux-x64"
            var archive JsonElement
            var checksum JsonElement
            for asset in J.Items(J.Get(release, "assets")) {
                if J.Text(asset, "name") == bundle + ".tar.gz" {
                    archive = asset
                } else if J.Text(asset, "name") == bundle + ".tar.gz.sha256" {
                    checksum = asset
                }
            }
            let archiveUrl = AssetUrl(archive)
            let checksumUrl = AssetUrl(checksum)
            let directory = Directory.CreateTempSubdirectory("tokate-release-").FullName
            try {
                let archivePath = Path.Combine(directory, "archive.tar.gz")
                let checksumPath = Path.Combine(directory, "checksum")
                Download(archiveUrl, archivePath)
                Download(checksumUrl, checksumPath)
                if FileInfo(checksumPath).Length > 256 {
                    throw Exception("Invalid release checksum sidecar")
                }
                let text = File.ReadAllText(checksumPath).Trim()
                if !Regex.IsMatch(text, "^[0-9a-f]{64}  " + Regex.Escape(bundle + ".tar.gz") + "$") {
                    throw Exception("Invalid release checksum sidecar")
                }
                let hash = text.Substring(0, 64)
                if HashFile(archivePath) != hash {
                    throw Exception("Release archive checksum mismatch")
                }
                let member = bundle + "/tokate"
                Commands.Checked(
                    "tar",
                    []string{
                        "-xzf",
                        archivePath,
                        "--no-same-owner",
                        "--no-same-permissions",
                        "-C",
                        directory,
                        "--",
                        member
                    }
                )
                let binary = Path.Combine(directory, member)
                if FileInfo(binary).LinkTarget != nil || HashFile(binary) != HashFile(Environment.ProcessPath ?? "") {
                    throw Exception("Running binary does not match the released archive member")
                }
                let yaml = Data
                    .Resource("coordinator.yml")
                    .Replace("@ARCHIVE_URL@", archiveUrl)
                    .Replace("@ARCHIVE_SHA256@", hash)
                    .Replace("@MEMBER@", member)
                File.WriteAllText(output, yaml)
                Terminal.Message(
                    "Generated " +
                        output +
                        ". Owner: review, then install as .github/workflows/tokate-coordinator.yml; opt in with policy version 2 and fresh approvals."
                )
            } finally {
                Directory.Delete(directory, true)
            }
        }

        private func AssetUrl(asset JsonElement) string {
            var id int64
            if !J.Get(asset, "id").TryGetInt64(out id) || id < 1 || J.Text(asset, "state") != "uploaded" || J.Number(
                asset,
                "size"
            ) < 1 ||
                J.Number(asset, "size") > 128 * 1024 * 1024 {
                throw Exception("Release is missing a bounded uploaded archive or checksum asset")
            }
            return "https://api.github.com/repos/obselate/tokate/releases/assets/" + id.ToString()
        }

        private func Download(url string, path string) -> Commands.Checked(
            "curl",
            []string{
                "-qfsSL",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--max-time",
                "60",
                "--max-filesize",
                "134217728",
                "-H",
                "Accept: application/octet-stream",
                "--output",
                path,
                url
            }
        )

        private func HashFile(path string) string {
            using let file = File.OpenRead(path)
            return Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant()
        }
    }
}
