package Tokate

import System
import System.IO
import System.Text.Json

internal class Reconciliation {
    shared {
        private func Published(run Data) JsonElement {
            if (run.Number("version") == 1 && run.Text("state") != "published") ||
                (run.Number("version") == 2 && run.Text("state") != "generated" && run.Text("state") != "published") ||
                (run.Number("version") != 1 && run.Number("version") != 2) {
                throw CliFailure(
                    "invalid_state",
                    "Reconcile requires an already-published successful v1/v2 contribution; inspect status and return to the owner for unsupported or failed work."
                )
            }
            let authority = Amendment.Authority(run, nil)
            let record = run.Number("version") == 2 ? J.Get(authority, "record"): authority
            let pr = run.Number("version") == 2 ? J.Number(
                J.Get(CoordinationState.Current(J.Get(authority, "state")), "outcome"),
                "pr"
            ): run.Number("pr")
            if pr < 1 {
                throw CliFailure("invalid_state", "No published PR; inspect saved publication before reconciling.")
            }
            let pull = Amendment.Pull(run, pr, run.Text("commit"), "")
            Amendment.Remote(run, run.Text("commit"), "")
            ReceiptVerification.Verify(run.Text("repo"), pr, false)
            let receipt = PrBody.Receipt(J.Text(pull, "body"))
            let upstream = GitHub.Branch(run.Text("repo"), run.Text("base_branch"))
            return J.Parse(
                J.Write(
                    J.Map(
                        "record",
                        record,
                        "pr",
                        pr,
                        "receipt",
                        receipt,
                        "upstream",
                        upstream,
                        "expected",
                        run.Number("version") == 2 ? J.Text(authority, "sha"): ""
                    )
                )
            )
        }

        private func Fresh(run Data, intent JsonElement) JsonElement {
            let live = Published(run)
            if run.Text("commit") != J.Text(intent, "previous") || run.Text("approval") != J.Text(intent, "approval") ||
                run.Text("base") != J.Text(intent, "base") || run.Text("base_branch") != J.Text(intent, "target") ||
                J.Text(live, "upstream") != J.Text(intent, "upstream") || J.Text(live, "expected") != J.Text(
                intent,
                "expected"
            ) ||
                J.Number(live, "pr") != J.Number(intent, "pr") || !RequestData.Same(
                J.Get(live, "receipt"),
                J.Get(intent, "receipt")
            ) {
                throw CliFailure(
                    "invalid_state",
                    "Published head, target or approval changed; preserve this workspace and ask the owner to review the saved exact intent. No reset or retarget was performed."
                )
            }
            return J.Get(live, "record")
        }

        private func Head(checkout string) string -> RepositoryIdentity.CommitSha(
            Commands.Git(checkout, "rev-parse", "HEAD")
        )

        private func HeadRef(checkout string) string -> Commands.Git(
            checkout,
            "rev-parse",
            "--symbolic-full-name",
            "HEAD"
        )

        private func Clean(checkout string) {
            if Commands.Git(
                checkout,
                "--no-optional-locks",
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored",
                "--ignore-submodules=none"
            ) != "" {
                throw CliFailure(
                    "invalid_state",
                    "Dirty workspace preserved; inspect and commit or move your changes explicitly, then reconcile. No files were replaced."
                )
            }
        }

        private func Operations(checkout string, intent JsonElement, resume bool) {
            let git = Path.Combine(checkout, ".git")
            for name in[]string{
                "CHERRY_PICK_HEAD",
                "REVERT_HEAD",
                "REBASE_HEAD",
                "rebase-merge",
                "rebase-apply",
                "sequencer",
                "BISECT_START",
                "index.lock",
                "HEAD.lock",
                "MERGE_AUTOSTASH"
            } {
                if File.Exists(Path.Combine(git, name)) || Directory.Exists(Path.Combine(git, name)) {
                    throw CliFailure(
                        "invalid_state",
                        "Unrelated or active Git operation preserved; inspect and finish that operation explicitly before reconcile: " +
                            name
                    )
                }
            }
            let merge = Path.Combine(git, "MERGE_HEAD")
            if !File.Exists(merge) {
                return
            }
            if !resume || J.Text(intent, "phase") != "merging" || File.ReadAllText(merge).Trim() != J.Text(
                intent,
                "upstream"
            ) ||
                Head(checkout) != J.Text(intent, "start") || Commands.Git(checkout, "rev-parse", "ORIG_HEAD") != J.Text(
                intent,
                "start"
            ) {
                throw CliFailure(
                    "invalid_state",
                    "Unidentified merge preserved; inspect its physical Git state and use its original operation intent. No merge was repeated."
                )
            }
            throw CliFailure(
                "invalid_state",
                "Saved merge is unfinished; resolve conflicts in the saved checkout, stage and commit the resolution, then use reconcile --run DIR --resume. Index and workspace preserved."
            )
        }

        private func Candidate(directory string, checkout string, run Data, intent JsonElement) {
            Preparation.PublishedSource(checkout, run)
            Operations(checkout, intent, true)
            if HeadRef(checkout) != J.Text(intent, "head_ref") {
                throw CliFailure(
                    "invalid_state",
                    "Local branch identity changed; inspect the original saved checkout before resuming. Workspace preserved."
                )
            }
            Clean(checkout)
            let candidate = Head(checkout)
            if Commands.GitResult(
                checkout,
                []string{"merge-base", "--is-ancestor", run.Text("base"), J.Text(intent, "upstream")}
            )
                .Code != 0 {
                throw CliFailure(
                    "invalid_state",
                    "Saved target lacks approved-base ancestry; preserve the workspace and ask the owner to inspect that exact target."
                )
            }
            for ancestor in[]string{J.Text(intent, "previous"), J.Text(intent, "start"), J.Text(intent, "upstream")} {
                if Commands.GitResult(checkout, []string{"merge-base", "--is-ancestor", ancestor, candidate})
                    .Code != 0 {
                    throw CliFailure(
                        "invalid_state",
                        "No completed merge with saved H, starting head and U ancestry; inspect physical state, fetch and merge the saved exact U explicitly if needed, commit, then reconcile --run DIR --resume. No merge was repeated."
                    )
                }
            }
            if J.Text(intent, "phase") == "complete" && candidate != J.Text(intent, "candidate") {
                throw CliFailure(
                    "invalid_state",
                    "Completed local candidate changed; inspect the saved exact candidate before resuming."
                )
            }
            let record = Fresh(run, intent)
            ProtectedPaths.EqualTrees(
                J.Get(record, "policy"),
                J.Get(record, "approval"),
                GitHubPathEvidence.Tree(run.Text("repo"), J.Text(intent, "upstream")),
                ProtectedPaths.LocalTree(checkout, candidate)
            )
            Fresh(run, intent)
            Preparation.PublishedSource(checkout, run)
            Operations(checkout, intent, true)
            Clean(checkout)
            if Head(checkout) != candidate || HeadRef(checkout) != J.Text(intent, "head_ref") {
                throw CliFailure(
                    "invalid_state",
                    "Local candidate changed during inspection; preserve and inspect before resume."
                )
            }
            let saved = Data()
            for field in intent.EnumerateObject() {
                saved.Fields[field.Name] = field.Value.Clone()
            }
            saved.Fields["phase"] = "complete"
            saved.Fields["candidate"] = candidate
            run.Fields["reconciliation"] = saved.Element()
            run.Save(directory)
            PublicOutput.ResultData = J.Map(
                "candidate",
                candidate,
                "upstream",
                J.Text(intent, "upstream"),
                "previous",
                J.Text(intent, "previous"),
                "local",
                true,
                "verified",
                false
            )
            PublicOutput.Actions.Add(
                []string{
                    "tokate",
                    "authorize-sync",
                    "--repo",
                    run.Text("repo"),
                    "--pr",
                    J.Number(intent, "pr").ToString(),
                    "--commit",
                    candidate,
                    "--upstream",
                    J.Text(intent, "upstream")
                }
            )
            Terminal.Message(
                "Local, unverified candidate C: " + candidate + "; target U: " + J.Text(intent, "upstream") +
                    ". Owner: authorize-sync for exact C/U, then donor: amend --run DIR --commit C --sync G --seconds N for independent verification and publication."
            )
        }

        internal func Run(args Args) {
            let directory = Path.GetFullPath(args.Need("run"))
            PublicOutput.RunDirectory = directory
            using let lease = Preparation.Lease(directory)
            let run = Data.Load(directory)
            let checkout = Path.Combine(directory, "checkout")
            Preparation.PublishedSource(checkout, run)
            let old = J.Get(run.Element(), "reconciliation")
            if args.Get("resume") == "true" {
                if old.ValueKind != JsonValueKind.Object {
                    throw CliFailure(
                        "invalid_state",
                        "No saved reconciliation intent; inspect status, then reconcile --run DIR without --resume."
                    )
                }
                Fresh(run, old)
                Candidate(directory, checkout, run, old)
                return
            }
            if old.ValueKind != JsonValueKind.Undefined &&
                (J.Text(old, "phase") != "complete" || J.Text(old, "candidate") != run.Text("commit")) {
                throw CliFailure(
                    "invalid_state",
                    "Saved reconciliation retained; use reconcile --run DIR --resume. Obtain owner authorization and amend the exact completed candidate before starting another reconciliation."
                )
            }
            Operations(checkout, default(JsonElement), false)
            Clean(checkout)
            let live = Published(run)
            let start = Head(checkout)
            let headRef = HeadRef(checkout)
            if headRef != "HEAD" && headRef != "refs/heads/" + run.Text("branch") {
                throw CliFailure(
                    "invalid_state",
                    "Unidentified local branch preserved; return explicitly to the saved contribution branch or detached candidate before reconcile."
                )
            }
            if J.Get(run.Element(), "preparation_head_id").ToString() != J.Get(
                GitHub.Api("repos/" + run.Text("head_repo")),
                "id"
            )
                .ToString() {
                throw CliFailure(
                    "invalid_state",
                    "Saved fork identity changed; inspect the original fork before reconciliation."
                )
            }
            if Commands.GitResult(checkout, []string{"merge-base", "--is-ancestor", run.Text("commit"), start})
                .Code != 0 {
                throw CliFailure(
                    "invalid_state",
                    "Local head does not descend from published H; inspect committed work and use the original contribution checkout. No reset was performed."
                )
            }
            let intent = J.Map(
                "previous",
                run.Text("commit"),
                "upstream",
                J.Text(live, "upstream"),
                "start",
                start,
                "head_ref",
                headRef,
                "target",
                run.Text("base_branch"),
                "base",
                run.Text("base"),
                "approval",
                run.Text("approval"),
                "expected",
                J.Text(live, "expected"),
                "pr",
                J.Number(live, "pr"),
                "receipt",
                J.Get(live, "receipt"),
                "phase",
                "fetching"
            )
            run.Fields["reconciliation"] = intent
            run.Save(directory)
            let bound = J.Parse(J.Write(intent))
            Fresh(run, bound)
            Commands.Git(
                checkout,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                "https://github.com/" + run.Text("repo") + ".git",
                J.Text(bound, "upstream")
            )
            Fresh(run, bound)
            Preparation.PublishedSource(checkout, run)
            Operations(checkout, bound, false)
            Clean(checkout)
            if Head(checkout) != start || HeadRef(checkout) != J.Text(bound, "head_ref") {
                throw CliFailure(
                    "invalid_state",
                    "Local starting head changed before merge; inspect saved intent and resume explicitly. Workspace preserved."
                )
            }
            Commands.Git(checkout, "merge-base", "--is-ancestor", run.Text("base"), J.Text(bound, "upstream"))
            intent["phase"] = "merging"
            run.Fields["reconciliation"] = intent
            run.Save(directory)
            let merged = Commands.GitResult(
                checkout,
                []string{
                    "-c",
                    "user.name=" + run.Text("donor"),
                    "-c",
                    "user.email=tokate@users.noreply.github.com",
                    "-c",
                    "commit.gpgsign=false",
                    "merge",
                    "--no-ff",
                    "--no-edit",
                    "--no-verify",
                    J.Text(bound, "upstream")
                }
            )
            if merged.Code != 0 {
                throw CliFailure(
                    "invalid_state",
                    "Merge stopped; inspect the saved checkout and index, resolve and commit conflicts if present, then reconcile --run DIR --resume. No reset or retry was performed."
                )
            }
            Candidate(directory, checkout, run, J.Parse(J.Write(intent)))
        }
    }
}
