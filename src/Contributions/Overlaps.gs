package Tokate

import System
import System.Collections.Generic
import System.Text
import System.Text.Json

internal class OverlapContribution {
    internal let Number int32
    internal let Facts Dictionary[string, Object?]
    internal var Identity string = ""
    internal var Target string = ""
    internal var Binding Data? = nil
    internal var Files HashSet[string]? = nil
    internal var Stable bool
    internal init(number int32) {
        Number = number
        Facts = map[string, Object?]{
            "pr": number,
            "binding_status": "unknown",
            "identity_status": "unknown",
            "diff_status": "unknown",
            "checks_status": "unknown",
            "dependency_gate": "unknown"
        }
    }

    internal func Invalidate() {
        Facts["diff_status"] = "unknown"
        Facts["checks_status"] = "unknown"
        Facts["dependency_gate"] = "unknown"
        Facts["dependencies_status"] = "unknown"
        Files = nil
    }
}

internal class Overlaps {
    shared {
        private let Advisory string = "Filename overlap is advisory and never blocks work or determines merge order. Disjoint files and clean merge metadata do not prove semantic compatibility. Closed-completed dependencies remove only the open-dependency gate; they do not prove implementation completion. Previous checks and owner review do not verify a new head or target. Owners retain final acceptance; use verify-pr and checks for single-contribution gates."
        private var Remaining int32 = 24000

        private func Retain(rows List[Object], item Object) {
            let bytes = Encoding.UTF8.GetByteCount(J.Write(item))
            if bytes > Remaining {
                PublicOutput.Truncated = true
                return
            }
            Remaining -= bytes
            rows.Add(item)
        }

        private func Identity(pull JsonElement) string -> J.Write(
            map[string, Object?]{
                "head": PublicOutput.Select(J.Get(pull, "head"), "sha,ref"),
                "head_repo": J.Text(J.Get(J.Get(pull, "head"), "repo"), "full_name"),
                "target": J.Text(J.Get(pull, "base"), "ref"),
                "target_repo": J.Text(J.Get(J.Get(pull, "base"), "repo"), "full_name"),
                "body_hash": Data.Hash(J.Text(pull, "body"))
            }
        )

        private func Failure(facts Dictionary[string, Object?], key string, error Exception) {
            facts[key + "_status"] = "unknown"
            facts[key + "_error"] = error is CliFailure failure ? PublicOutput.Message(
                failure.Code
            ): "Evidence unavailable, incomplete or changed; owner review required."
        }

        private func Resolution(issue JsonElement) Object {
            let result = PublicOutput.Select(issue, "closed_at")
            let closer = J.Get(issue, "closed_by")
            if closer.ValueKind == JsonValueKind.Object {
                result["closed_by"] = PublicOutput.Select(closer, "id,login")
            }
            for key in[]string{"duplicate_of", "resolution"} {
                let value = J.Get(issue, key)
                if value.ValueKind == JsonValueKind.Object {
                    result[key] = PublicOutput.Select(value, "id,number,url,html_url,type,reason,state,state_reason")
                } else if value.ValueKind == JsonValueKind.String || value.ValueKind == JsonValueKind.Number {
                    result[key] = value
                }
            }
            return result
        }

        private func Dependencies(repo string, issue int32, facts Dictionary[string, Object?]) {
            let rows = List[Object]()
            let seen = HashSet[string](StringComparer.Ordinal)
            var complete bool
            var valid bool = true
            var blocked bool
            var review bool
            var count int32
            try {
                for page in 1 ... 11 {
                    let value = GitHub.Api(
                        "repos/" + repo + "/issues/" + issue.ToString() +
                            "/dependencies/blocked_by?per_page=100&page=" +
                            page.ToString()
                    )
                    if value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > 100 {
                        throw Exception("Incomplete native dependency evidence")
                    }
                    for dependency in value.EnumerateArray() {
                        count++
                        let url = J.Text(dependency, "url")
                        if url == "" || J.Number(dependency, "number") < 1 || !seen.Add(url) || J.Get(
                            dependency,
                            "pull_request"
                        )
                            .ValueKind != JsonValueKind.Undefined {
                            review = true
                            valid = false
                        }
                        let state = J.Text(dependency, "state")
                        let reason = J.Text(dependency, "state_reason")
                        let resolution = J.Parse(J.Write(Resolution(dependency)))
                        let nativeResolution = J.Get(resolution, "resolution")
                        let resolved = nativeResolution.ValueKind == JsonValueKind.Undefined ||
                            (
                            nativeResolution.ValueKind == JsonValueKind.String &&
                                nativeResolution.GetString() == "completed"
                        ) ||
                            (
                            nativeResolution.ValueKind == JsonValueKind.Object && J.Text(
                                nativeResolution,
                                "type"
                            ) == "completed"
                        )
                        let duplicate = J.Get(resolution, "duplicate_of")
                            .ValueKind != JsonValueKind.Undefined ||
                            J.Text(J.Get(resolution, "resolution"), "type") == "duplicate" || J.Text(
                            resolution,
                            "resolution"
                        ) == "duplicate"
                        let gate = state == "open" ? "blocking": (
                            state == "closed" &&
                                reason == "completed" &&
                                !duplicate &&
                                resolved ? "open_dependency_removed": "owner_review"
                        )
                        blocked = blocked || gate == "blocking"
                        review = review || gate == "owner_review"
                        let row = PublicOutput.Select(dependency, "id,number,url,html_url,state,state_reason")
                        row["resolution"] = resolution
                        row["gate"] = gate
                        Retain(rows, row)
                    }
                    if value.GetArrayLength() < 100 {
                        complete = valid
                        break
                    }
                }
            } catch (error Exception) {
                Failure(facts, "dependencies", error)
            }
            facts["dependencies"] = rows
            facts["dependency_count"] = count
            facts["dependencies_status"] = complete ? "complete": "incomplete"
            facts["dependencies_output_complete"] = rows.Count == count
            facts["dependency_gate"] = blocked ? "blocked": (
                !complete ? "unknown": (review ? "owner_review": "no_open_dependencies")
            )
        }

        internal func RequireDependencies(repo string, issue int32) {
            let facts = Dictionary[string, Object?]()
            Dependencies(repo, issue, facts)
            ApiTransport.CheckDeadline()
            if facts["dependencies_status"]?.ToString() != "complete" ||
                facts["dependency_gate"]?.ToString() != "no_open_dependencies" {
                throw CliFailure("invalid_state", "Dependency evidence is blocked, incomplete or requires owner review")
            }
        }

        private func Read(repo string, item OverlapContribution, targets Dictionary[string, string]) {
            let facts = item.Facts
            try {
                let pull = GitHub.Api("repos/" + repo + "/pulls/" + item.Number.ToString())
                item.Identity = Identity(pull)
                let head = J.Get(pull, "head")
                facts["head"] = RepositoryIdentity.CommitSha(J.Text(head, "sha"))
                facts["head_branch"] = J.Text(head, "ref")
                facts["head_repo"] = RepositoryIdentity.Repo(J.Text(J.Get(head, "repo"), "full_name"))
                let branch = RepositoryIdentity.Branch(J.Text(J.Get(pull, "base"), "ref"))
                item.Target = branch
                facts["target_branch"] = branch
                if !targets.ContainsKey(branch) {
                    try {
                        targets[branch] = GitHub.Branch(repo, branch)
                    } catch (error Exception) {
                        targets[branch] = ""
                    }
                }
                facts["target_revision"] = targets[branch]
                facts["pr_url"] = J.Text(pull, "html_url")
                facts["mergeable"] = J.Get(pull, "mergeable")
                    .ValueKind == JsonValueKind.True ? true: (
                    J.Get(pull, "mergeable").ValueKind == JsonValueKind.False ? false as Object: nil
                )
                let binding = ReceiptVerification.Verify(repo, item.Number, ready: false, paths: false)
                item.Binding = binding
                facts["binding_status"] = "validated"
                facts["binding"] = PublicOutput.Select(
                    binding.Element(),
                    "version,issue,approval,authority_revision,donor,base,base_branch,commit"
                )
                try {
                    let files = GitHubPathEvidence.Diff(
                        repo,
                        binding.Text("base"),
                        J.Text(J.Get(head, "repo"), "full_name"),
                        binding.Text("commit")
                    )
                    item.Files = files
                    facts["diff_status"] = "complete"
                    facts["file_count"] = files.Count
                    facts["diff_base"] = binding.Text("base")
                    facts["diff_head"] = binding.Text("commit")
                } catch (error Exception) {
                    Failure(facts, "diff", error)
                }
                try {
                    let checks = CommitChecks.Read(repo, binding.Text("commit"))
                    let rows = List[Object]()
                    for check in J.Items(checks) {
                        Retain(rows, PublicOutput.Select(check, "name,state,bucket,link,workflow"))
                    }
                    facts["checks"] = rows
                    facts["check_count"] = checks.GetArrayLength()
                    facts["checks_status"] = "complete"
                    facts["checks_output_complete"] = rows.Count == checks.GetArrayLength()
                    facts["checks_head"] = binding.Text("commit")
                    let names = J.Items(J.Get(J.Get(binding.Element(), "policy"), "required_checks"))
                    let required = List[Object]()
                    for name in names {
                        Retain(required, name)
                    }
                    facts["required_checks"] = required
                    facts["required_check_count"] = names.Count
                } catch (error Exception) {
                    Failure(facts, "checks", error)
                }
                Dependencies(repo, binding.Number("issue"), facts)
            } catch (error Exception) {
                Failure(facts, "binding", error)
            }
        }

        internal func Run(args Args) {
            Remaining = 24000
            let repo = RepositoryIdentity.Repo(args.Need("repo"))
            let numbers = Cli.PullNumbers(args.Need("prs"))
            let items = List[OverlapContribution]()
            let targets = Dictionary[string, string](StringComparer.Ordinal)
            for number in numbers {
                let item = OverlapContribution(number)
                items.Add(item)
                Read(repo, item, targets)
            }
            for item in items {
                try {
                    let pull = GitHub.Api("repos/" + repo + "/pulls/" + item.Number.ToString())
                    item.Facts["head_after"] = J.Text(J.Get(pull, "head"), "sha")
                    item.Facts["target_branch_after"] = J.Text(J.Get(pull, "base"), "ref")
                    if item.Identity == "" || Identity(pull) != item.Identity {
                        throw Exception("Contribution identity changed during evidence collection")
                    }
                    if let binding = item.Binding {
                        let live = ReceiptVerification.Verify(repo, item.Number, ready: false, paths: false)
                        let fields = "version,issue,approval,authority_revision,base,base_branch,commit"
                        let current = J.Write(PublicOutput.Select(live.Element(), fields))
                        let original = J.Write(PublicOutput.Select(binding.Element(), fields))
                        if current != original {
                            throw Exception("Contribution binding changed during evidence collection")
                        }
                    }
                    item.Stable = true
                    item.Facts["identity_status"] = "stable"
                } catch (error Exception) {
                    Failure(item.Facts, "identity", error)
                    item.Facts["binding_status"] = "unknown"
                    item.Invalidate()
                }
            }
            for target in targets {
                var current string = ""
                try {
                    current = GitHub.Branch(repo, target.Key)
                } catch (error Exception) { }
                for item in items {
                    if item.Target != target.Key {
                        continue
                    }
                    let stable = target.Value != "" && current == target.Value
                    item.Facts["target_status"] = stable ? "stable": "unknown"
                    item.Facts["target_revision_after"] = current
                    if !stable {
                        item.Facts[
                            "target_error"
                        ] = "Target evidence unavailable or changed during collection; owner review required."
                        item.Stable = false
                        item.Facts["identity_status"] = "unknown"
                        item.Invalidate()
                    }
                }
            }
            let pairs = List[Object]()
            for i in 0 ... items.Count {
                for j in i + 1 ... items.Count {
                    let left = items[i]
                    let right = items[j]
                    let same = left.Target != "" && left.Target == right.Target
                    let paths = List[Object]()
                    var count int32
                    let known = same && left.Stable && right.Stable && left.Files != nil && right.Files != nil
                    if known {
                        let names = List[string](left.Files ?? HashSet[string]())
                        names.Sort(StringComparer.Ordinal)
                        for name in names {
                            if right.Files?.Contains(name) == true {
                                count++
                                Retain(paths, name)
                            }
                        }
                    }
                    let status = !left.Stable ||
                        !right.Stable ||
                        left.Target == "" ||
                        right.Target == "" ? "unknown": (
                        !same ? "different_targets": (
                            !known ? "unknown": (count > 0 ? "overlap": "no_filename_overlap")
                        )
                    )
                    pairs.Add(
                        map[string, Object?]{
                            "left_pr": left.Number,
                            "right_pr": right.Number,
                            "status": status,
                            "target_branch": same ? left.Target: "",
                            "paths": paths,
                            "overlap_count": known ? count as Object: nil,
                            "paths_output_complete": paths.Count == count
                        }
                    )
                }
            }
            let contributions = List[Object]()
            for item in items {
                contributions.Add(item.Facts)
                if item.Binding != nil {
                    PublicOutput.Actions.Add(
                        []string{"tokate", "verify-pr", "--repo", repo, "--pr", item.Number.ToString(), "--json"}
                    )
                    PublicOutput.Actions.Add(
                        []string{"tokate", "checks", "--repo", repo, "--pr", item.Number.ToString(), "--json"}
                    )
                }
            }
            let result = map[string, Object?]{
                "repo": repo,
                "contributions": contributions,
                "pairs": pairs,
                "advisory": Advisory
            }
            PublicOutput.ResultData = result
            if !PublicOutput.Enabled {
                result["truncated"] = PublicOutput.Truncated
                Terminal.Message(Advisory, "cyan")
                Terminal.Json(J.Parse(J.Write(result)), "Selected contributions")
            }
        }
    }
}
