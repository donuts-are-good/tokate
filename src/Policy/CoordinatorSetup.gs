package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text.Json
import System.Text.RegularExpressions

internal class CoordinatorSetup {
    shared {
        internal func EventPolicy(repo string, workflow string = ".github/workflows/tokate-coordinator.yml") {
            let policies = GitHub.Api("repos/" + repo + "/actions/policies?has_parents=true&per_page=100")
            let rows = J.Get(policies, "policies")
            if rows.ValueKind != JsonValueKind.Array || J.Number(policies, "total_count") != rows.GetArrayLength() ||
                rows.GetArrayLength() > 100 {
                throw Exception(
                    "Cannot inspect all applicable Actions policies; owner setup requires a complete policy read"
                )
            }
            var configured bool
            for row in J.Items(rows) {
                let id = RepositoryIdentity.PositiveId(J.Get(row, "id"))
                var path = "repos/" + repo + "/actions/policies/" + id.ToString()
                let self = J.Text(J.Get(J.Get(row, "_links"), "self"), "href")
                if self != "" {
                    let prefix = "https://api.github.com/"
                    if !self.StartsWith(prefix, StringComparison.Ordinal) {
                        throw Exception("Invalid applicable Actions policy location")
                    }
                    let source = self.Substring(prefix.Length)
                    if source != path && !Regex.IsMatch(
                        source,
                        "^(?:orgs|enterprises)/[A-Za-z0-9][A-Za-z0-9_.-]*/actions/policies/" + id.ToString() + "$"
                    ) {
                        throw Exception("Invalid inherited Actions policy location")
                    }
                    path = source
                }
                let policy = GitHub.Api(path)
                let enforcement = J.Text(policy, "enforcement")
                if enforcement == "disabled" {
                    continue
                }
                if enforcement != "active" && enforcement != "evaluate" || J.Get(policy, "rules")
                    .ValueKind != JsonValueKind.Array {
                    throw Exception("Malformed Actions policy; inspect Settings > Actions > Policies before setup")
                }
                let condition = J.Get(J.Get(policy, "conditions"), "workflow_path")
                if condition.ValueKind != JsonValueKind.Undefined && !Applies(condition, workflow) {
                    continue
                }
                for rule in J.Items(J.Get(policy, "rules")) {
                    let type = J.Text(rule, "type")
                    if type == "restrict_actions_actors" && enforcement == "active" {
                        throw Exception(
                            "Active Actions actor policy may prevent outsider admission; review Settings > Actions > Policies before setup"
                        )
                    }
                    if type != "restrict_action_events" {
                        continue
                    }
                    let events = J.Get(J.Get(rule, "parameters"), "allowed_events")
                    if events.ValueKind != JsonValueKind.Array {
                        throw Exception("Malformed Actions event policy")
                    }
                    let allowed = HashSet[string]()
                    for event in J.Items(events) {
                        if event.ValueKind != JsonValueKind.String {
                            throw Exception("Malformed Actions event name")
                        }
                        allowed.Add(event.GetString() ?? "")
                    }
                    if !allowed.Contains("issue_comment") || !allowed.Contains("pull_request_target") ||
                        !allowed
                        .Contains("workflow_call") {
                        throw Exception(
                            "Actions event policy blocks Tokate. The owner must allow issue_comment, pull_request_target and workflow_call in Settings > Actions > Policies; the default public-repository block is enforced November 2, 2026"
                        )
                    }
                    configured = true
                }
            }
            if !configured {
                throw Exception(
                    "Explicit Actions event policy required before admission setup. Allow issue_comment, pull_request_target and workflow_call in Settings > Actions > Policies; the default public-repository block is enforced November 2, 2026"
                )
            }
            Terminal.Message(
                "Actions event policy permits Tokate events. Review actor rules so external PR events can run admission."
            )
        }

        private func Applies(condition JsonElement, workflow string) bool {
            let included = J.Get(condition, "include")
            let excluded = J.Get(condition, "exclude")
            if included.ValueKind != JsonValueKind.Array || excluded.ValueKind != JsonValueKind.Array {
                throw Exception("Malformed Actions workflow path condition")
            }
            var applies = included.GetArrayLength() == 0
            for pattern in J.Items(included) {
                applies = Matches(pattern, workflow) || applies
            }
            for pattern in J.Items(excluded) {
                if Matches(pattern, workflow) {
                    return false
                }
            }
            return applies
        }

        private func Matches(pattern JsonElement, workflow string) bool {
            if pattern.ValueKind != JsonValueKind.String || pattern.GetString() == "" {
                throw Exception("Malformed Actions workflow path pattern")
            }
            let value = pattern.GetString() ?? ""
            if value == "~ALL" {
                return true
            }
            if value.Contains('[') || value.Contains('{') || value.Contains('\\') || value.StartsWith('!') {
                throw Exception("Unsupported Actions workflow path pattern; inspect event policy before setup")
            }
            let expression = Regex.Escape(value).Replace("\\*\\*", ".*").Replace("\\*", "[^/]*").Replace("\\?", "[^/]")
            return Regex.IsMatch(workflow, "^" + expression + "$")
        }

        internal func Run(args Args) {
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let requested = Path.GetFullPath(args.Need("output"))
            let output = Path.Combine(
                LocalPaths.CanonicalPath(
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
            RepositoryAccess.RequireOwner(repo)
            EventPolicy(repo)
            let yaml = Resolve()
            OwnerSetup.Preview(output, File.Exists(output) ? File.ReadAllText(output): "", yaml)
            if OwnerSetup.Confirm(args) {
                File.WriteAllText(output, yaml)
                Terminal.Message("Generated a pinned shared workflow entry. Owner: review and install it separately.")
            }
        }

        internal func Resolve() string {
            let version = ApplicationInfo.Version()
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
                let tag = GitHub.Api("repos/obselate/tokate/git/ref/tags/v" + version)
                var identity = J.Get(tag, "object")
                var depth int32
                while J.Text(identity, "type") == "tag" && depth < 8 {
                    let annotated = GitHub.Api(
                        "repos/obselate/tokate/git/tags/" + RepositoryIdentity.CommitSha(J.Text(identity, "sha"))
                    )
                    identity = J.Get(annotated, "object")
                    depth++
                }
                if J.Text(identity, "type") != "commit" {
                    throw Exception("Stable release tag does not resolve to a commit")
                }
                let commit = RepositoryIdentity.CommitSha(J.Text(identity, "sha"))
                let hosted = GitHub.FileAt(
                    "obselate/tokate",
                    ".github/workflows/tokate-shared.yml",
                    commit,
                    missing: true
                )
                if hosted.Replace("\r", "").TrimEnd() != ApplicationInfo
                    .Resource("coordinator.yml")
                    .Replace("\r", "")
                    .TrimEnd() {
                    throw Exception(
                        "Bootstrap required: the owner must install the reviewed central reusable workflow in the matching release before setup can write adopter files"
                    )
                }
                return "name: Tokate\non:\n  issue_comment:\n    types: [created]\n  pull_request_target:\n    types: [opened, reopened, synchronize, edited, ready_for_review, converted_to_draft, labeled, unlabeled, assigned, unassigned]\npermissions: {}\njobs:\n  coordinate:\n" +
                    "    permissions:\n      contents: write\n      issues: read\n      pull-requests: write\n" +
                    "    uses: obselate/tokate/.github/workflows/tokate-shared.yml@" +
                    commit +
                    "\n" +
                    "    with:\n      archive_url: '" +
                    archiveUrl +
                    "'\n      archive_sha256: '" +
                    hash +
                    "'\n      member: '" +
                    member +
                    "'\n"
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
