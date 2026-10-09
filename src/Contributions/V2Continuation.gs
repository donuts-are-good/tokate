package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class V2Continuation {
    shared {
        private func Id(value string) {
            var id Guid
            if !Guid.TryParseExact(value, "D", out id) || id.ToString("D") != value {
                throw Exception("Continuation requires canonical contribution and attempt identities")
            }
        }

        internal func RunDirectory(args Args, attempt string) string {
            let source = LocalPaths.DirectoryPath(args.Need("continue-from"))
            let root = Path.GetDirectoryName(source) ?? throw Exception("Unsupported source run store")
            if args.Get("runs") != "" && LocalPaths.DirectoryPath(args.Need("runs")) != root {
                throw Exception(
                    "Continuation must use the source run store so each destination fence has one saved run"
                )
            }
            return Path.Combine(root, attempt)
        }

        internal func Location(directory string, run Data) {
            if run.Number("version") == 2 && V1Continuation.Has(run) && Path.GetFullPath(directory) != Path.Combine(
                Path.GetDirectoryName(run.Text("continuation_source")) ?? "",
                run.Text("attempt")
            ) {
                throw Exception(
                    "Continuation destination moved or shares an ambiguous execution fence; use its original saved run"
                )
            }
        }

        internal func Provenance(source Data) JsonElement {
            let prior = map[string, Object?]{
                "version": 2,
                "repo_id": J.Get(source.Element(), "preparation_repo_id"),
                "donor_id": J.Get(source.Element(), "donor_id")
            }
            for key in[]string{
                "id",
                "attempt",
                "state_sha",
                "approval",
                "base",
                "state",
                "failure_reason",
                "harness",
                "provider",
                "model",
                "effort"
            } {
                prior[key] = source.Text(key)
            }
            return J.Parse(J.Write(prior))
        }

        private func Predecessor(prior JsonElement, attempt string, tools JsonElement) {
            RequestData.Keys(
                prior,
                "version,id,attempt,state_sha,approval,base,repo_id,donor_id,state,failure_reason,harness,provider,model,effort"
            )
            Id(J.Text(prior, "id"))
            Id(J.Text(prior, "attempt"))
            Id(attempt)
            RepositoryIdentity.CommitSha(J.Text(prior, "state_sha"))
            RepositoryIdentity.CommitSha(J.Text(prior, "base"))
            RepositoryIdentity.PositiveId(J.Get(prior, "donor_id"))
            RepositoryIdentity.PositiveId(J.Get(prior, "repo_id"))
            RequestData.Tools(tools)
            let declared = J.Items(tools)
            if J.Number(prior, "version") != 2 || J.Text(prior, "attempt") == attempt || !Regex.IsMatch(
                J.Text(prior, "approval"),
                "^[0-9a-f]{64}$"
            ) ||
                (J.Text(prior, "state") != "failed" && J.Text(prior, "state") != "running") ||
                declared.Count != 1 ||
                Array.IndexOf(
                []string{"inference_failed", "inference_interrupted", "incomplete_turn"},
                J.Text(prior, "failure_reason")
            ) < 0 ||
                (
                (J.Text(prior, "harness") != "codex" || J.Text(prior, "provider") != "openai") &&
                    (J.Text(prior, "harness") != "pi" || J.Text(prior, "provider") != "local-chat-completions")
            ) {
                throw Exception("Invalid stopped managed v2 predecessor or destination attempt")
            }
            for key in[]string{"harness", "provider", "model", "effort"} {
                if J.Text(prior, key) != J.Text(declared[0], key) {
                    throw Exception("Continuation cannot change its predecessor tool selection")
                }
            }
        }

        internal func Declaration(metadata JsonElement) {
            let prior = J.Get(metadata, "predecessor")
            let hash = J.Get(metadata, "import_manifest_sha256")
            if prior.ValueKind == JsonValueKind.Undefined && hash.ValueKind == JsonValueKind.Undefined {
                return
            }
            if J.Text(metadata, "source") != "tokate" || !Regex.IsMatch(
                J.Text(metadata, "import_manifest_sha256"),
                "^[0-9a-f]{64}$"
            ) {
                throw Exception("Continuation requires managed source and bound import evidence")
            }
            Predecessor(prior, J.Text(metadata, "attempt"), J.Get(metadata, "tools"))
        }

        internal func Authority(state CoordinationState, prior JsonElement) {
            let value = state.Value()
            let approval = J.Get(value, "approval")
            let reservation = J.Get(value, "reservation")
            let identity = J.Get(value, "identity")
            let actor = RepositoryIdentity.PositiveId(J.Get(prior, "donor_id"))
            let repoId = RepositoryIdentity.PositiveId(J.Get(prior, "repo_id"))
            if RepositoryIdentity.PositiveId(J.Get(GitHub.Api("repos/" + J.Text(value, "repo")), "id")) != repoId ||
                (
                J.Get(approval, "repo_id").ValueKind != JsonValueKind.Undefined && RepositoryIdentity.PositiveId(
                    J.Get(approval, "repo_id")
                ) != repoId
            ) {
                throw Exception("Continuation repository numeric identity changed")
            }
            if !LeaseLifecycle.Supported(value) || J.Text(reservation, "status") != "active" || J.Text(
                reservation,
                "attempt"
            ) == J.Text(prior, "attempt") || J.Text(reservation, "reservation") != J.Text(prior, "id") || J.Text(
                identity,
                "id"
            ) != J.Text(prior, "id") || RepositoryIdentity.PositiveId(J.Get(identity, "actor")) != actor ||
                RepositoryIdentity.PositiveId(J.Get(reservation, "actor")) != actor || J.Text(
                value,
                "approval_id"
            ) != J.Text(prior, "approval") || J.Text(approval, "base") != J.Text(prior, "base") {
                throw CliFailure(
                    "stale_approval",
                    "Continuation needs unchanged authority and a fresh same-donor attempt"
                )
            }
            let original = CoordinationState.At(
                J.Text(value, "repo"),
                J.Number(value, "issue"),
                J.Text(prior, "state_sha")
            )
            let evidence = original.Value()
            Synchronization.Ancestor(J.Text(value, "repo"), original.Sha, J.Text(value, "repo"), state.Sha)
            let old = J.Get(evidence, "reservation")
            let oldIdentity = J.Get(evidence, "identity")
            if !LeaseLifecycle.Supported(evidence) || J.Bool(evidence, "revoked") || J.Text(
                evidence,
                "approval_id"
            ) != J.Text(prior, "approval") || !RequestData.Same(J.Get(evidence, "approval"), approval) || J.Text(
                old,
                "status"
            ) != "active" ||
                J.Text(old, "attempt") != J.Text(prior, "attempt") || J.Text(old, "reservation") != J.Text(
                prior,
                "id"
            ) ||
                J.Text(oldIdentity, "id") != J.Text(prior, "id") || RepositoryIdentity.PositiveId(
                J.Get(old, "actor")
            ) != actor ||
                RepositoryIdentity.PositiveId(J.Get(oldIdentity, "actor")) != actor || J.Get(evidence, "contribution")
                .ValueKind == JsonValueKind.Object ||
                J
                .Items(J.Get(evidence, "amendments")).Count != 0 {
                throw Exception("Ambiguous predecessor lineage or changed approval and contribution evidence")
            }
        }

        internal func Recheck(run Data, state CoordinationState) {
            let prior = J.Get(run.Element(), "continuation")
            if !V1Continuation.Has(run) && prior.ValueKind == JsonValueKind.Undefined && !run.Fields.ContainsKey(
                "continuation_manifest_sha256"
            ) {
                return
            }
            if !V1Continuation.Has(run) || run.Text("source") != "tokate" || run.Number("verification_reserve") < 1 ||
                !Regex
                .IsMatch(run.Text("continuation_source_metadata_sha256"), "^[0-9a-f]{64}$") {
                throw Exception("Saved continuation lost its explicit import identity or verification budget")
            }
            RuntimeBudget.Validate(run)
            Predecessor(prior, run.Text("attempt"), J.Get(run.Element(), "tools"))
            Authority(state, prior)
            if run.Text("state") != "preparing" || run.Text("continuation_phase") != "" {
                Declaration(Metadata(run))
            }
        }

        internal func Metadata(run Data) JsonElement -> J.Parse(
            J.Write(
                map[string, Object?]{
                    "source": run.Text("source"),
                    "tools": J.Get(run.Element(), "tools"),
                    "attempt": run.Text("attempt"),
                    "predecessor": J.Get(run.Element(), "continuation"),
                    "import_manifest_sha256": run.Text("continuation_manifest_sha256")
                }
            )
        )

        internal func Keep(fields Dictionary[string, Object?], metadata JsonElement) {
            Declaration(metadata)
            if J.Get(metadata, "predecessor").ValueKind != JsonValueKind.Undefined {
                for key in[]string{"predecessor", "import_manifest_sha256", "attempt"} {
                    fields[key] = J.Get(metadata, key)
                }
            }
        }

        internal func Source(directory string, run Data, record JsonElement) Data {
            let source = Data.From(J.Parse(V1Continuation.Metadata(directory)))
            let state = source.Text("state")
            if source.Number("version") != 2 || source.Number("preparation_version") != 1 || source.Text(
                "source"
            ) != "tokate" ||
                source.Flag("turn_completed") || (state != "failed" && state != "running") || source.Text(
                "failure_stage"
            ) != "inference" ||
                (
                source.Text("harness") == "codex" ? source.Text("codex_version") == "":
                source.Text("harness") != "pi" || source.Text("pi_version") == ""
            ) ||
                source.Text("commit") != "" || source.Number("pr") != 0 || source.Text("pr_url") != "" || source.Text(
                "publication_uuid"
            ) != "" ||
                source.Text("publication_expected") != "" {
                throw Exception("Source must be stopped, unpublished managed v2 work with incomplete coding")
            }
            for name in[]string{
                "publication.json",
                "request.json",
                "request.json.posting.json",
                "correction.json",
                "amendments"
            } {
                let path = Path.Combine(directory, name)
                if File.Exists(path) || Directory.Exists(path) || FileInfo(path).LinkTarget != nil {
                    throw Exception("Publication-pending or corrected source work cannot be continued")
                }
            }
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, source) || !RepositoryIdentity.SameDonor(viewer, run) ||
                !RepositoryIdentity.SameRepo(source.Text("repo"), run.Text("repo")) || source.Number(
                "issue"
            ) != run.Number("issue") {
                throw Exception("Continuation source has a different numeric donor, repository or issue")
            }
            for key in[]string{
                "approval",
                "base",
                "base_branch",
                "policy_hash",
                "id",
                "branch",
                "harness",
                "harness_path",
                "provider",
                "model",
                "effort",
                "pi_endpoint",
                "pi_root",
                "pi_node"
            } {
                if source.Text(key) != run.Text(key) {
                    throw Exception("Continuation changed predecessor binding or selection: " + key)
                }
            }
            let live = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            live.Reservation(J.Get(viewer, "id"))
            LeaseLifecycle.Fence(live, run.Text("attempt"))
            let checked = live.Check(run.Text("repo"), run.Number("issue"), run.Text("donor"), J.Get(viewer, "id"))
            if !RequestData.Same(J.Get(checked, "approval"), J.Get(record, "approval")) || J.Get(
                live.Value(),
                "contribution"
            )
                .ValueKind == JsonValueKind.Object {
                throw Exception("Published or changed authority cannot be continued")
            }
            Predecessor(Provenance(source), run.Text("attempt"), J.Get(run.Element(), "tools"))
            Authority(live, Provenance(source))
            Preparation.Source(Path.Combine(directory, "checkout"), source)
            let upstream = GitHub.Api("repos/" + run.Text("repo"))
            let head = GitHub.Api("repos/" + RepositoryIdentity.Repo(source.Text("head_repo")))
            let repoId = RepositoryIdentity.PositiveId(J.Get(upstream, "id"))
            if repoId != RepositoryIdentity.PositiveId(J.Get(source.Element(), "preparation_repo_id")) ||
                repoId != RepositoryIdentity.PositiveId(J.Get(run.Element(), "preparation_repo_id")) ||
                RepositoryIdentity.PositiveId(J.Get(head, "id")) != RepositoryIdentity.PositiveId(
                J.Get(source.Element(), "preparation_head_id")
            ) ||
                !RepositoryIdentity
                .SameRepo(source.Text("head_repo"), run.Text("head_repo")) {
                throw Exception("Continuation repository or fork identity changed")
            }
            RepositoryAccess.ValidateRepository(
                source.Text("repo"),
                source.Text("head_repo"),
                J.Get(viewer, "id"),
                head,
                upstream: upstream
            )
            if Publication.Pulls(source).Count != 0 {
                throw Exception("Published contributions cannot be imported")
            }
            let reference = GitHub.Api(
                "repos/" + source.Text("head_repo") + "/git/ref/heads/" + Uri.EscapeDataString(source.Text("branch"))
            )
            if J.Text(J.Get(reference, "object"), "sha") != source.Text("base") {
                throw Exception("Source branch changed or publication is pending; source is preserved")
            }
            return source
        }
    }
}
