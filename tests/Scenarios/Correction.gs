package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json.Nodes

internal class CorrectionChecks {
    shared {
        private func Read(run string, file string = "run.json") JsonNode -> Check.Json(
            File.ReadAllText(Path.Combine(run, file))
        )

        private func Once(flow NativeFixture, prs int32 = 0) {
            flow.Reload()
            Check.That(Check.Text(flow.State["exec_count"]) == "1", "Correction repeated inference")
            Check.That((flow.State["pulls"]?.AsArray().Count ?? 0) == prs, "Unexpected or duplicate PR")
        }

        private func Correct(flow NativeFixture, run string, text string = "Explicit donor correction\n") string {
            File.WriteAllText(Path.Combine(run, "checkout/result.txt"), text)
            return Commit(flow, run)
        }

        private func Commit(flow NativeFixture, run string, message string = "Explicit correction") string {
            let checkout = Path.Combine(run, "checkout")
            flow.Git("-C", checkout, "add", "-A")
            flow.Git(
                "-C",
                checkout,
                "-c",
                "user.name=Donor",
                "-c",
                "user.email=donor@example.test",
                "commit",
                "--allow-empty",
                "-m",
                message
            )
            return flow.Git("-C", checkout, "rev-parse", "HEAD")
        }

        private func Recover(
            flow NativeFixture,
            run string,
            commit string,
            code int32 = 0,
            tools string = "",
            seconds string = "30"
        ) Result {
            let args = List[string]{"recover", "--run", run, "--commit", commit, "--seconds", seconds}
            if tools != "" {
                args.AddRange([]string{"--tools", tools})
            }
            return flow.Call(args.ToArray(), code)
        }

        private func Prepared(flow NativeFixture, run string) string {
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let failed = File.Exists(Path.Combine(run, "verification.json")) ? File.ReadAllText(
                Path.Combine(run, "verification.json")
            ): ""
            flow.Call([]string{"recover", "--run", run, "--prepare"})
            Check.That(File.ReadAllText(Path.Combine(run, "run.json")) == original, "Preparation rewrote saved work")
            Check.That(!File.Exists(Path.Combine(run, "correction.json")), "Preparation created an attempt")
            let archive = Path.Combine(run, "original-evidence")
            Check.That(File.ReadAllText(Path.Combine(archive, "run.json")) == original, "Original record lost")
            for file in[]string{"events.jsonl", "report.md", "stderr.log"} {
                Check.That(
                    File.ReadAllText(Path.Combine(archive, file)) == File.ReadAllText(Path.Combine(run, file)),
                    "Original turn evidence lost: " + file
                )
            }
            if failed != "" {
                Check.That(File.ReadAllText(Path.Combine(archive, "verification.json")) == failed, "Prior checks lost")
            }
            let manifest = File.ReadAllText(Path.Combine(archive, "manifest.json"))
            flow.Call([]string{"recover", "--run", run, "--prepare"})
            Check.That(
                File.ReadAllText(Path.Combine(archive, "manifest.json")) == manifest,
                "Preparation retry replaced original archive"
            )
            Once(flow)
            return manifest
        }

        private func Whitespace(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("staged_whitespace")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "trailing whitespace")
            Check.That(
                !File.Exists(Path.Combine(run, "candidate.patch")),
                "Whitespace failure unexpectedly saved a candidate"
            )
            Check.That(
                !File.Exists(Path.Combine(run, "verification.json")),
                "Whitespace failure ran independent checks"
            )
            let checkout = Path.Combine(run, "checkout")
            File.AppendAllText(Path.Combine(checkout, "result.txt"), "Unstaged correction evidence\n")
            File.WriteAllText(Path.Combine(checkout, "untracked.bin"), "Untracked evidence\0bytes")
            let secret = Path.Combine(flow.Temp.Root, "private-evidence")
            File.WriteAllText(secret, "synthetic private data")
            File.CreateSymbolicLink(Path.Combine(checkout, "outside-link"), secret)
            flow.Call([]string{"recover", "--run", run, "--prepare", "--seconds", "30"}, 1)
            flow.Call([]string{"recover", "--run", run, "--prepare", "--commit", String('0', 40)}, 1)
            flow.Call([]string{"recover", "--run", run, "--prepare", "--tools", "missing"}, 1)
            flow.Call([]string{"recover", "--run", run, "--commit", String('0', 40)}, 1)
            let manifest = Prepared(flow, run)
            let archive = Path.Combine(run, "original-evidence")
            Check.Contains(
                File.ReadAllText(Path.Combine(archive, "staged.patch")),
                "Copied license with trailing whitespace \t"
            )
            Check.Contains(File.ReadAllText(Path.Combine(archive, "unstaged.patch")), "Unstaged correction evidence")
            Check.Contains(File.ReadAllText(Path.Combine(archive, "capture.json")), "candidate.patch")
            Check.Contains(
                File.ReadAllText(Path.Combine(archive, "capture.json")),
                "original model provenance is unproven"
            )
            Check.That(
                File.ReadAllText(Path.Combine(archive, "checkout/untracked.bin")) == "Untracked evidence\0bytes",
                "Untracked binary evidence lost"
            )
            Check.That(!File.Exists(Path.Combine(archive, "checkout/outside-link")), "Archive followed a symlink")
            Check.Contains(File.ReadAllText(Path.Combine(archive, "capture.json")), "outside-link")
            File.Delete(Path.Combine(checkout, "outside-link"))
            File.Delete(Path.Combine(checkout, "untracked.bin"))
            let commit = Correct(flow, run)
            Recover(flow, run, commit)
            Once(flow, 1)
            Check.That(
                File.ReadAllText(Path.Combine(archive, "manifest.json")) == manifest,
                "Correction changed original archive"
            )
            Check.That(File.ReadAllText(secret) == "synthetic private data", "Capture changed private data")
            let saved = Read(run)
            Check.That(Check.Text(saved["commit"]) == commit, "Published another commit")
            Check.That(Check.Text(saved["correction"]?["head"]) == commit, "Receipt lost exact candidate")
            Check.That(
                saved["correction"]?["tools"]?.AsArray().Count == 0,
                "Missing tools did not declare manual editing"
            )
            Check.That(saved["previous_published_head"] == nil, "Unpublished candidate treated as previous PR")
            Check.Contains(File.ReadAllText(Path.Combine(run, "pr-body.md")), "manual/unknown")
            Check.Contains(File.ReadAllText(Path.Combine(run, "pr-body.md")), "cover only the original completed turn")
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            flow.Call([]string{"recover", "--run", run, "--prepare"}, 1)
            Recover(flow, run, commit, 1)
            Once(flow, 1)
        }

        private func Reconstruct(flow NativeFixture, run string, patch string, tree string, name string) {
            let replay = Path.Combine(flow.Temp.Root, name)
            flow.Git("clone", "--no-local", Path.Combine(run, "checkout"), replay)
            flow.Git("-C", replay, "checkout", "--detach", Check.Text(Read(run)["base"]))
            flow.Git("-C", replay, "apply", "--index", "--binary", patch)
            Check.That(flow.Git("-C", replay, "write-tree") == tree, "Binary patch did not reconstruct the exact tree")
        }

        private func BinaryRename(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            let asset = [14 * 1024 * 1024]byte
            Random(91).NextBytes(asset)
            File.WriteAllBytes(Path.Combine(flow.Upstream, "artwork.bin"), asset)
            flow.Commit("Retained binary artwork")
            flow.Git("-C", flow.Upstream, "push", Path.Combine(flow.Bin, "fork"), "main")
            flow.Approve()
            let run = flow.Claim("120")
            flow.Mode("staged_whitespace")
            flow.Call([]string{"work", "--run", run}, 1)
            let checkout = Path.Combine(run, "checkout")
            Directory.CreateDirectory(Path.Combine(checkout, "branding"))
            flow.Git("-C", checkout, "mv", "artwork.bin", "branding/artwork.bin")
            let originalTree = flow.Git("-C", checkout, "write-tree")
            Check.That(
                flow.Git("-C", checkout, "diff", "--cached", "--binary", "--full-index", "--no-renames").Length >
                32 * 1024 * 1024,
                "Binary move fixture did not exceed the former capture limit"
            )
            flow.Git("-C", checkout, "config", "diff.renames", "false")
            Prepared(flow, run)
            let archivedPatch = Path.Combine(run, "original-evidence/staged.patch")
            Check.Contains(File.ReadAllText(archivedPatch), "similarity index 100%")
            Reconstruct(flow, run, archivedPatch, originalTree, "original-replay")
            flow.Git("-C", checkout, "config", "diff.renames", "true")
            Check.That(
                flow.Git("-C", checkout, "diff", "--cached", "--binary", "--full-index", "--find-renames=100%") ==
                File.ReadAllText(archivedPatch).Trim(),
                "Original binary evidence depends on rename configuration"
            )
            let commit = Correct(flow, run)
            let tree = flow.Git("-C", checkout, "rev-parse", "HEAD^{tree}")
            Recover(flow, run, commit, seconds: "120")
            let correction = Read(run, "correction.json")
            let patch = Path.Combine(run, "correction-" + Check.Text(correction["uuid"]), "candidate.patch")
            Reconstruct(flow, run, patch, tree, "corrected-replay")
            Check.That(Check.Text(correction["tree"]) == tree, "Correction bound another binary tree")
            flow.Git("-C", checkout, "config", "diff.renames", "false")
            Check.That(
                flow.Git(
                    "-C",
                    checkout,
                    "diff",
                    "--binary",
                    "--full-index",
                    "--find-renames=100%",
                    Check.Text(Read(run)["base"]),
                    commit
                ) == File
                    .ReadAllText(patch).Trim(),
                "Corrected binary evidence depends on rename configuration"
            )
            flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
            Once(flow, 1)
        }

        private func FirstVerification(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy("test -f result.txt", second: "printf second-original-check")
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("verification_fail")
            flow.Call([]string{"work", "--run", run}, 1)
            let original = File.ReadAllText(Path.Combine(run, "candidate.patch"))
            let failed = File.ReadAllText(Path.Combine(run, "verification.json"))
            Prepared(flow, run)
            let checkout = Path.Combine(run, "checkout")
            let bad = Correct(flow, run, "")
            File.Delete(Path.Combine(checkout, "result.txt"))
            let failing = Commit(flow, run, "Still fails")
            Check.Contains(Recover(flow, run, failing, 1).Error, "verification_failed")
            let attempt = Read(run, "correction.json")
            Check.That(
                attempt["verification"]?.AsArray().Count == 2,
                "Correction skipped an original owner command after failure"
            )
            Check.Contains(Check.Text(attempt["verification"]?[1]?["output"]), "second-original-check")
            let savedAttempt = File.ReadAllText(Path.Combine(run, "correction.json"))
            Recover(flow, run, failing, 1)
            Check.That(
                File.ReadAllText(Path.Combine(run, "correction.json")) == savedAttempt,
                "Failed correction retried implicitly"
            )
            let commit = Correct(flow, run)
            Check.That(commit != bad && commit != failing, "New attempt lacks a new explicit commit")
            Recover(flow, run, commit)
            Once(flow, 1)
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/candidate.patch")) == original,
                "Original saved candidate replaced"
            )
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/verification.json")) == failed,
                "Original failed checks replaced"
            )
            Check.That(Directory.GetDirectories(run, "correction-*").Length == 2, "Failed attempt evidence lost")
        }

        private func OriginalTimeout(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy(
                "printf synthetic-verifier-prefix; printf synthetic-verifier-error >&2; sleep 12 && test -f result.txt"
            )
            flow.Approve()
            let run = flow.Claim("10")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "Runtime limit reached")
            let interrupted = Read(run, "verification.json")[0]
            Check.That(interrupted?["exit_code"] == nil, "Timeout fabricated a completed check")
            Check.Contains(Check.Text(interrupted?["output"]), "synthetic-verifier-prefix")
            Check.Contains(Check.Text(interrupted?["error"]), "synthetic-verifier-error")
            Check.That(Check.Text(interrupted?["state"]) == "interrupted", "Interrupted phase was lost")
            let originalChecks = File.ReadAllText(Path.Combine(run, "verification.json"))
            let original = File.ReadAllText(Path.Combine(run, "candidate.patch"))
            let checkout = Path.Combine(run, "checkout")
            let tree = flow.Git("-C", checkout, "write-tree")
            Prepared(flow, run)
            let commit = Commit(flow, run)
            Check.That(flow.Git("-C", checkout, "rev-parse", "HEAD^{tree}") == tree, "Commit changed original work")
            Check.That(
                flow.Git("-C", checkout, "diff", "--binary", Check.Text(Read(run)["base"]), commit) == original,
                "Commit changed the original candidate patch"
            )
            Recover(flow, run, commit)
            Once(flow, 1)
            Check.That(Check.Text(Read(run, "correction.json")["tree"]) == tree, "Correction verified a different tree")
            for path in[]string{"candidate.patch", "original-evidence/candidate.patch"} {
                Check.That(File.ReadAllText(Path.Combine(run, path)) == original, "Original candidate was replaced")
            }
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/verification.json")) == originalChecks,
                "Interrupted original check evidence replaced"
            )
            Check.That(
                Directory.GetDirectories(Path.Combine(run, "original-evidence"), "verification-*").Length == 1,
                "Original raw verifier prefix was not sealed"
            )
            Check.Contains(Check.Text(Read(run, "original-evidence/run.json")["error"]), "Runtime limit reached")
        }

        private func WrongTarget(binary string) {
            for stage in[]string{"recover", "prepare"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                var commit = ""
                if stage == "recover" {
                    Prepared(flow, run)
                    commit = Correct(flow, run)
                }
                flow.Reload()
                let pulls = JsonArray()
                pulls.Add(
                    Check.Map(
                        "number",
                        9,
                        "state",
                        "open",
                        "draft",
                        true,
                        "base",
                        Check.Map("ref", "other"),
                        "head",
                        Check.Map(
                            "ref",
                            Check.Text(Read(run)["branch"]),
                            "repo",
                            Check.Map("full_name", "donor/project", "owner", Check.Map("login", "donor", "id", 123))
                        )
                    )
                )
                flow.State["pulls"] = pulls
                flow.Save()
                if stage == "prepare" {
                    Check.Contains(flow.Call([]string{"recover", "--run", run, "--prepare"}, 1).Error, "physical PR")
                    Check.That(!Directory.Exists(Path.Combine(run, "original-evidence")), "Published work was prepared")
                } else {
                    Check.Contains(Recover(flow, run, commit, 1).Error, "physical PR")
                    Check.That(Read(run, "correction.json")["verification"] == nil, "Published work reached checks")
                }
                Once(flow, 1)
                Check.That(flow.State["pr_create_count"] == nil, "Wrong-target PR caused another PR write")
            }
        }

        private func Tools(binary string) {
            for declared in[]bool{false, true} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                Prepared(flow, run)
                let commit = Correct(flow, run)
                let path = Path.Combine(flow.Temp.Root, "correction-tools.json")
                File.WriteAllText(
                    path,
                    "[{\"harness\":\"claude\",\"provider\":\"anthropic\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
                )
                Recover(flow, run, commit, 1, path)
                File.WriteAllText(
                    path,
                    "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"not-allowed\",\"effort\":\"high\"}]"
                )
                Recover(flow, run, commit, 1, path)
                File.WriteAllText(
                    path,
                    declared ? "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\",\"usage\":{\"input_tokens\":7},\"coding_seconds\":2}]": "[]"
                )
                Recover(flow, run, commit, tools: path)
                Once(flow, 1)
                let correction = Read(run, "correction.json")
                Check.That(correction["tools"]?.AsArray().Count == (declared ? 1: 0), "Tool declaration lost")
                Check.That(
                    Check.Text(Read(run)["usage"]?["input_tokens"]) == "100",
                    "Correction usage replaced original usage"
                )
                let body = File.ReadAllText(Path.Combine(run, "pr-body.md"))
                Check.Contains(body, declared ? "Donor-reported correction tools": "manual/unknown")
            }
        }

        private func Refusals(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Call([]string{"recover", "--run", run, "--prepare"}, 1)
            flow.NoInference()
            flow.Mode("staged_whitespace")
            flow.Call([]string{"work", "--run", run}, 1)
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            for key in[]string{"viewer_login", "viewer_id"} {
                flow.Reload()
                flow.State[key] = key == "viewer_login" ? JsonValue.Create("other") as JsonNode: JsonValue.Create(
                    999
                ) as JsonNode
                flow.Save()
                flow.Call([]string{"recover", "--run", run, "--prepare"}, 1)
                Check.That(!Directory.Exists(Path.Combine(run, "original-evidence")), "Another donor archived work")
                flow.Reload()
                flow.State.AsObject().Remove(key)
                flow.Save()
            }
            Prepared(flow, run)
            let commit = Correct(flow, run)
            Recover(flow, run, commit, 1, seconds: "86400")
            Recover(flow, run, commit, 1, seconds: "0")
            Recover(flow, run, String('0', 40), 1)
            let current = File.ReadAllText(Path.Combine(run, "correction.json"))
            flow.Reload()
            let issue = flow.State["issue"] ?? throw Exception("Missing issue")
            issue["labels"] = JsonArray()
            flow.Save()
            Recover(flow, run, commit, 1)
            Check.That(
                File.ReadAllText(Path.Combine(run, "correction.json")) == current,
                "Revocation changed correction progress"
            )
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/run.json")) == original,
                "Refusal rewrote original"
            )
            Once(flow)
        }

        private func Incomplete(binary string) {
            for mode in[]string{"incomplete_turn", "incomplete_tail", "failed_turn", "inference_exit_failure"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode(mode)
                flow.Call([]string{"work", "--run", run}, 1)
                let original = File.ReadAllText(Path.Combine(run, "run.json"))
                Check.Contains(flow.Call([]string{"recover", "--run", run, "--prepare"}, 1).Error, "incomplete_turn")
                Check.That(
                    !Directory.Exists(Path.Combine(run, "original-evidence")),
                    "Incomplete turn archived evidence"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(run, "run.json")) == original,
                    "Incomplete refusal changed run"
                )
                Once(flow)
            }
        }

        private func ProtectedAndExact(binary string) {
            for rename in[]bool{false, true} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.ProtectedPolicy()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                let archive = Prepared(flow, run)
                let checkout = Path.Combine(run, "checkout")
                if rename {
                    flow.Git("-C", checkout, "mv", "scripts/verify.sh", "ordinary-verifier.sh")
                } else {
                    File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "exit 0\n")
                }
                let commit = Correct(flow, run)
                Check.Contains(Recover(flow, run, commit, 1).Error, "protected owner path")
                Check.That(Read(run, "correction.json")["verification"] == nil, "Protected verifier executed")
                Check.That(
                    File.ReadAllText(Path.Combine(run, "original-evidence/manifest.json")) == archive,
                    "Protected correction changed original evidence"
                )
                Once(flow)
            }
            for flag in[]string{"--assume-unchanged", "--skip-worktree"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                Prepared(flow, run)
                let commit = Correct(flow, run)
                let checkout = Path.Combine(run, "checkout")
                flow.Git("-C", checkout, "update-index", flag, "result.txt")
                File.AppendAllText(Path.Combine(checkout, "result.txt"), "Hidden correction change\n")
                Check.That(flow.Git("-C", checkout, "status", "--porcelain") == "", "Index flag must hide change")
                let result = Recover(flow, run, commit, 1)
                Check.Contains(result.Error, "candidate_invalid")
                Check.Contains(result.Error, "index contains")
                Check.That(Read(run, "correction.json")["verification"] == nil, "Hidden index reached verification")
                Once(flow)
            }
            for rename in[]bool{false, true} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                Prepared(flow, run)
                let checkout = Path.Combine(run, "checkout")
                if rename {
                    flow.Git("-C", checkout, "mv", ".github/tokate-pr.md", "ordinary-template.md")
                } else {
                    Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
                    File.Move(
                        Path.Combine(checkout, "result.txt"),
                        Path.Combine(checkout, ".github/workflows/corrected.yml")
                    )
                    File.WriteAllText(
                        Path.Combine(checkout, ".github/workflows/corrected.yml"),
                        "Corrected renamed content\n"
                    )
                }
                let protectedCommit = Correct(flow, run)
                Check.Contains(Recover(flow, run, protectedCommit, 1).Error, "protected")
                Check.That(Read(run, "correction.json")["verification"] == nil, "Protected rename reached verification")
                Once(flow)
            }
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy("test -f result.txt && printf changed >> result.txt")
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("staged_whitespace")
            flow.Call([]string{"work", "--run", run}, 1)
            Prepared(flow, run)
            let commit = Correct(flow, run)
            Check.Contains(Recover(flow, run, commit, 1).Error, "candidate_changed")
            Check.That(
                Check.Text(Read(run, "correction.json")["verification"]?[0]?["exit_code"]) == "0",
                "Expected check to pass before exact-candidate refusal"
            )
            Once(flow)
        }

        private func InterruptedNative(binary string) {
            for mode in[]string{"push_fail_after_write", "pr_fail_after_create", "pr_fail"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                Prepared(flow, run)
                let commit = Correct(flow, run)
                flow.Mode(mode)
                Recover(flow, run, commit, mode == "pr_fail_after_create" ? 0: 1)
                let checks = Check.Text(Read(run, "correction.json")["verification"])
                let archive = File.ReadAllText(Path.Combine(run, "original-evidence/manifest.json"))
                flow.Mode("")
                if mode == "pr_fail" {
                    Check.Contains(Recover(flow, run, commit, 1).Error, "blind write retry")
                    flow.Call([]string{"publish", "--run", run}, 1)
                    Once(flow)
                    flow.Reload()
                    Check.That(Check.Text(flow.State["pr_create_count"]) == "1", "Uncertain missing PR was retried")
                } else {
                    if mode == "push_fail_after_write" {
                        Recover(flow, run, commit)
                    }
                    flow.Call([]string{"publish", "--run", run})
                    Once(flow, 1)
                    flow.Reload()
                    Check.That(Check.Text(flow.State["pr_create_count"]) == "1", "Publication duplicated a PR")
                    let pulls = flow.State["pulls"]?.AsArray() ?? throw Exception("Missing PR")
                    pulls.Add(pulls[0]?.DeepClone())
                    flow.Save()
                    flow.Call([]string{"publish", "--run", run}, 1)
                }
                Check.That(
                    Check.Text(Read(run, "correction.json")["verification"]) == checks,
                    "Publication resume repeated checks"
                )
                Check.That(
                    File.ReadAllText(Path.Combine(run, "original-evidence/manifest.json")) == archive,
                    "Publication resume changed archive"
                )
            }
        }

        private func ManagedRun(flow CoordinationFixture, mode string) string {
            flow.Claim()
            File.WriteAllText(
                flow.Tools,
                "[{\"harness\":\"codex\",\"provider\":\"openai\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}]"
            )
            let run = flow.Prepare("tokate")
            flow.Flow.Mode(mode)
            flow.Flow.Call([]string{"work", "--run", run}, mode == "" ? 0: 1)
            return run
        }

        private func InterruptedVerification(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy(
                "mkdir build-output; printf generated > build-output/data; printf completed-first-check",
                second: "test -s build-output/data; printf synthetic-interrupted-check; printf synthetic-interrupted-error >&2; sleep 3 && printf completed-second-check"
            )
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("staged_whitespace")
            flow.Call([]string{"work", "--run", run}, 1)
            Prepared(flow, run)
            let commit = Correct(flow, run)
            Check.Contains(Recover(flow, run, commit, 1, seconds: "1").Error, "verification_failed")
            let failed = Read(run, "correction.json")
            Check.That(
                failed["verification"]?.AsArray().Count == 2,
                "Interrupted verification lost prior or active check results"
            )
            Check.That(Check.Text(failed["verification"]?[0]?["exit_code"]) == "0", "Prior completed check lost")
            Check.That(failed["verification"]?[1]?["exit_code"] == nil, "Interrupted check fabricated an exit code")
            Check.Contains(Check.Text(failed["verification"]?[1]?["output"]), "synthetic-interrupted-check")
            Check.Contains(Check.Text(failed["verification"]?[1]?["error"]), "synthetic-interrupted-error")
            Check.Contains(Check.Text(failed["error"]), "Runtime limit")
            Check.That(
                !Directory.Exists(Path.Combine(run, "checkout/build-output")),
                "Interrupted correction build output retained"
            )
            let evidence = File.ReadAllText(Path.Combine(run, "correction.json"))
            Recover(flow, run, commit, 1, seconds: "1")
            Check.That(
                File.ReadAllText(Path.Combine(run, "correction.json")) == evidence,
                "Interrupted verification retried implicitly"
            )
            let corrected = Correct(flow, run)
            Recover(flow, run, corrected)
            Check.That(Directory.GetDirectories(run, "correction-*").Length == 2, "Interrupted attempt evidence lost")
            Once(flow, 1)
        }

        private func ChangedCandidate(binary string) {
            for mode in[]string{"change_checked_head", "change_checked_tree", "change_checked_patch"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                Prepared(flow, run)
                let commit = Correct(flow, run)
                let tree = flow.Git("-C", Path.Combine(run, "checkout"), "rev-parse", "HEAD^{tree}")
                flow.Mode(mode)
                Check.Contains(Recover(flow, run, commit, 1).Error, "candidate_changed")
                let correction = Read(run, "correction.json")
                Check.That(
                    Check.Text(correction["commit"]) == commit && Check.Text(correction["tree"]) == tree,
                    "Candidate binding changed during verification"
                )
                Check.That(
                    Check.Text(correction["verification"]?[0]?["exit_code"]) == "0",
                    "Concurrent change did not happen after a passed check"
                )
                Once(flow)
            }
        }

        private func LegacyAndArchive(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("staged_whitespace")
            flow.Call([]string{"work", "--run", run}, 1)
            let legacy = Read(run)
            for key in[]string{
                "turn_completed",
                "inference_exit_code",
                "usage",
                "execution_seconds",
                "failure_reason",
                "failure_stage"
            } {
                legacy.AsObject().Remove(key)
            }
            File.WriteAllText(Path.Combine(run, "run.json"), legacy.ToJsonString())
            Prepared(flow, run)
            let commit = Correct(flow, run)
            let reportPath = Path.Combine(run, "original-evidence/report.md")
            let report = File.ReadAllText(reportPath)
            File.AppendAllText(reportPath, "Archive was changed\n")
            Check.Contains(Recover(flow, run, commit, 1).Error, "archive changed")
            Check.That(!File.Exists(Path.Combine(run, "correction.json")), "Changed archive accepted a candidate")
            File.WriteAllText(reportPath, report)
            Recover(flow, run, commit)
            Check.Contains(File.ReadAllText(Path.Combine(run, "pr-body.md")), "unknown (original runtime not recorded)")
            Once(flow, 1)
            using let compatibility = NativeFixture(binary)
            compatibility.Initialize()
            compatibility.Approve()
            let failed = compatibility.Claim()
            compatibility.Mode("verification_fail")
            compatibility.Call([]string{"work", "--run", failed}, 1)
            let record = Read(failed)
            record.AsObject().Remove("failure_reason")
            record.AsObject().Remove("failure_stage")
            record["error"] = JsonValue.Create(
                "Owner verification failed. See verification.json. No PR will be opened."
            )
            File.WriteAllText(Path.Combine(failed, "run.json"), record.ToJsonString())
            File.WriteAllText(
                Path.Combine(failed, "checkout/result.txt"),
                "Disclosed edit requires explicit correction\n"
            )
            Check.Contains(
                compatibility.Call([]string{"recover", "--run", failed}, 1).Error,
                "Saved candidate patch changed"
            )
            Once(compatibility)
        }

        private func AuthorityChanges(binary string) {
            for change in[]string{"approval", "template", "policy", "assignment", "branch", "fork"} {
                using let flow = NativeFixture(binary)
                flow.Initialize()
                flow.Approve()
                let run = flow.Claim()
                flow.Mode("staged_whitespace")
                flow.Call([]string{"work", "--run", run}, 1)
                let original = Prepared(flow, run)
                let commit = Correct(flow, run)
                switch change {
                    case "approval" {
                        flow.Approve()
                    }
                    case "template" {
                        File.AppendAllText(
                            Path.Combine(flow.Upstream, ".github/tokate-pr.md"),
                            "Owner changed template\n"
                        )
                        flow.Commit("Changed template")
                    }
                    case "policy" {
                        let path = Path.Combine(flow.Upstream, ".github/tokate.json")
                        let policy = Check.Json(File.ReadAllText(path))
                        policy["max_seconds"] = JsonValue.Create(3000)
                        File.WriteAllText(path, policy.ToJsonString())
                        flow.Commit("Changed policy")
                    }
                    case "assignment" {
                        flow.Reload()
                        let issue = flow.State["issue"] ?? throw Exception("Missing issue")
                        issue["assignees"] = Check.Json("[{\"login\":\"other\"}]")
                        flow.Save()
                    }
                    case "branch" {
                        let fork = Path.Combine(flow.Bin, "fork")
                        let tree = flow.Git("-C", fork, "rev-parse", "main^{tree}")
                        let wrong = flow.Git(
                            "-C",
                            fork,
                            "-c",
                            "user.name=Other",
                            "-c",
                            "user.email=other@example.test",
                            "commit-tree",
                            tree,
                            "-m",
                            "Unrelated branch state"
                        )
                        flow.Git("-C", fork, "update-ref", "refs/heads/" + Check.Text(Read(run)["branch"]), wrong)
                    }
                    case "fork" {
                        flow.Reload()
                        flow.State["missing_fork"] = JsonValue.Create(true)
                        flow.Save()
                    }
                }
                Recover(flow, run, commit, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "original-evidence/manifest.json")) == original,
                    "Authority refusal replaced original archive"
                )
                Once(flow)
            }
        }

        private func ManagedRefusals(binary string) {
            for change in[]string{"expiry", "revocation", "identity", "revision"} {
                using let flow = CoordinationFixture(binary)
                flow.Initialize()
                let run = ManagedRun(flow, "staged_whitespace")
                Prepared(flow.Flow, run)
                let commit = Correct(flow.Flow, run)
                Recover(flow.Flow, run, commit)
                let saved = File.ReadAllText(Path.Combine(run, "correction.json"))
                switch change {
                    case "expiry" {
                        flow.Expire()
                    }
                    case "revocation" {
                        flow.Flow.Call([]string{"revoke", "--repo", "owner/project", "--issue", "1"}, owner: true)
                    }
                    case "identity" {
                        flow.Flow.Reload()
                        flow.Flow.State["viewer_id"] = JsonValue.Create(999)
                        flow.Flow.Save()
                    }
                    case "revision" {
                        let state = flow.State()["state"] ?? throw Exception("Missing state")
                        flow.RewriteState(state)
                    }
                }
                Recover(flow.Flow, run, commit, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "correction.json")) == saved,
                    "Refused recovery rewrote correction"
                )
                flow.Flow.Call([]string{"submit", "--run", run}, 1)
                flow.Flow.Reload()
                Check.That(flow.Flow.State["request_count"] == nil, "Refused authority posted a publication request")
                Once(flow.Flow)
            }
        }

        private func Managed(binary string, modelPolicy string = "") {
            for originalMode in modelPolicy == "" ? []string{"staged_whitespace", "verification_fail"}: []string{
                "staged_whitespace"
            } {
                using let flow = CoordinationFixture(binary)
                flow.Initialize()
                if modelPolicy != "" {
                    let path = Path.Combine(flow.Flow.Upstream, ".github/tokate.json")
                    let policy = Check.Json(File.ReadAllText(path))
                    policy["model_policy"] = JsonValue.Create(modelPolicy)
                    if modelPolicy == "unrestricted" {
                        policy.AsObject().Remove("models")
                    } else {
                        (policy["models"] ?? throw Exception("Missing model whitelist"))[
                            "claude-sonnet-4-6"
                        ] = Check.Json("[\"absent\"]")
                    }
                    File.WriteAllText(path, policy.ToJsonString())
                    flow.Flow.Commit("External correction effort policy")
                    flow.Flow.Approve()
                }
                let run = ManagedRun(flow, originalMode)
                Prepared(flow.Flow, run)
                let originalTools = Check.Text(Read(run)["tools"])
                let commit = Correct(flow.Flow, run)
                File.WriteAllText(
                    flow.Tools,
                    "[{\"harness\":\"claude\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"effort\":\"unknown\"}]"
                        .Replace("unknown", modelPolicy == "" ? "unknown": "absent")
                )
                Recover(flow.Flow, run, commit, tools: flow.Tools)
                Once(flow.Flow)
                Check.That(Read(run)["publication_uuid"] == nil, "Recovery posted a v2 publication")
                Check.That(Check.Text(Read(run)["tools"]) == originalTools, "Correction replaced original source/tools")
                let results = Check.Text(Read(run, "correction.json")["verification"])
                Recover(flow.Flow, run, commit, tools: flow.Tools)
                Check.That(
                    Check.Text(Read(run, "correction.json")["verification"]) == results,
                    "Repeated v2 correction reran checks"
                )
                flow.Flow.Call([]string{"submit", "--run", run})
                let request = Read(run, "request.json")
                Check.That(Check.Text(request["metadata"]?["source"]) == "tokate", "Correction replaced v2 source")
                Check.That(
                    Check.Text(request["metadata"]?["tools"]) == originalTools,
                    "Publication replaced original tools"
                )
                Check.That(Check.Text(request["metadata"]?["correction"]?["head"]) == commit, "v2 correction head lost")
                flow.Flow.Call([]string{"submit", "--run", run})
                flow.Flow.Reload()
                Check.That(
                    Check.Text(flow.Flow.State["request_count"]) == "1",
                    "Repeated submit posted a duplicate request"
                )
                flow.Flow.Reload()
                let posted = Check.PostedRequest(flow.Flow.State)
                let path = flow.Event(posted)
                flow.Flow.Mode("pr_fail_after_create")
                flow.Coordinate(path, 1)
                flow.Flow.Mode("")
                flow.Coordinate(path)
                flow.Coordinate(path)
                flow.Flow.Call([]string{"submit", "--run", run})
                flow.Flow.Call([]string{"submit", "--run", run})
                Once(flow.Flow, 1)
                Check.That(Check.Text(Read(run)["state"]) == "published", "v2 exact outcome not adopted")
                Check.That(
                    Check.Text(Read(run)["state_sha"]) == Check.Text(
                        Read(run, "original-evidence/run.json")["state_sha"]
                    ),
                    "Submit silently rewrote reservation revision"
                )
                Check.That(
                    Check.Text(Read(run, "correction.json")["verification"]) == results,
                    "v2 publication replay reran checks"
                )
                flow.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, owner: true)
                Check.Contains(Check.Text(flow.Flow.State["pulls"]?[0]?["body"]), "Original donor-reported tools")
                Check.Contains(Check.Text(flow.Flow.State["pulls"]?[0]?["body"]), "Donor-reported correction tools")
                Recover(flow.Flow, run, commit, 1, flow.Tools)
                flow.Expire()
                flow.Flow.Call([]string{"submit", "--run", run}, 1)
                Once(flow.Flow, 1)
            }
        }

        private func PublicationResponses(binary string) {
            for corrected in[]bool{false, true} {
                let faults = corrected ? []string{"issue", "repo", "author", "body", "id"}: []string{"body"}
                for fault in faults {
                    using let flow = CoordinationFixture(binary)
                    flow.Initialize()
                    let run = ManagedRun(flow, corrected ? "staged_whitespace": "")
                    if corrected {
                        Prepared(flow.Flow, run)
                        Recover(flow.Flow, run, Correct(flow.Flow, run))
                    }
                    flow.Flow.Mode("")
                    let results = Check.Text(Read(run)["verification"])
                    let before = File.ReadAllText(Path.Combine(run, "run.json"))
                    flow.Flow.Reload()
                    flow.Flow.State["request_response_fault"] = JsonValue.Create(fault)
                    flow.Flow.State["request_response_missing"] = JsonValue.Create(true)
                    flow.Flow.Save()
                    let first = flow.Flow.Call([]string{"submit", "--run", run}, 1)
                    let request = File.ReadAllText(Path.Combine(run, "request.json"))
                    Check.Contains(first.Error, "Uncertain request write")
                    Check.That(Check.Text(Read(run)["state"]) == "generated", "Inconsistent response published a run")
                    if corrected {
                        Check.That(
                            Check.Text(Read(run, "correction.json")["publication"]?["stage"]) ==
                            "request_pending",
                            "Inconsistent successful POST was recorded as requested"
                        )
                    }
                    flow.Flow.Reload()
                    flow.Flow.State["request_response_fault"] = nil
                    flow.Flow.State["request_response_missing"] = nil
                    flow.Flow.Save()
                    flow.Flow.Call([]string{"submit", "--run", run}, 1)
                    flow.Flow.Reload()
                    let comment = flow.Flow.State["request_comments"]?[0] ?? throw Exception("Missing posted comment")
                    (flow.Flow.State["comments"] ?? throw Exception("Missing comments"))[
                        Check.Text(comment["id"])
                    ] = comment.DeepClone()
                    flow.Flow.Save()
                    flow.Flow.Call([]string{"submit", "--run", run})
                    flow.Flow.Reload()
                    Check.That(Check.Text(flow.Flow.State["request_count"]) == "1", "Response recovery duplicated POST")
                    Check.That(Check.Text(Read(run)["verification"]) == results, "Response recovery reran verification")
                    Check.That(
                        File.ReadAllText(Path.Combine(run, "request.json")) == request,
                        "Response recovery changed request"
                    )
                    let original = Check.Json(before)
                    for field in[]string{"source", "tools", "correction", "commit", "state_sha"} {
                        Check.That(
                            Check.Text(Read(run)[field]) == Check.Text(original[field]),
                            "Response recovery changed " + field
                        )
                    }
                    Once(flow.Flow)
                }
            }
        }

        private func PublicationOutcomes(binary string) {
            for fault in[]string{"duplicate", "binding", "outcome"} {
                using let flow = CoordinationFixture(binary)
                flow.Initialize()
                let run = ManagedRun(flow, "staged_whitespace")
                Prepared(flow.Flow, run)
                Recover(flow.Flow, run, Correct(flow.Flow, run))
                flow.Flow.Mode("")
                flow.Flow.Call([]string{"submit", "--run", run})
                flow.Flow.Reload()
                flow.Coordinate(flow.Event(Check.PostedRequest(flow.Flow.State)))
                let state = flow.State()["state"] ?? throw Exception("Missing published state")
                let outcomes = state["outcomes"]?.AsArray() ?? throw Exception("Missing outcomes")
                let uuid = Check.Text(Read(run, "correction.json")["publication_uuid"])
                var recorded JsonNode? = nil
                for row in outcomes {
                    if Check.Text(row["uuid"]) == uuid {
                        recorded = row
                    }
                }
                let result = recorded ?? throw Exception("Missing publication outcome")
                switch fault {
                    case "duplicate" {
                        outcomes.Add(result.DeepClone())
                    }
                    case "binding" {
                        result["binding"] = JsonValue.Create("changed-binding")
                    }
                    case "outcome" {
                        result["outcome"] = Check.Map("status", "rejected")
                    }
                }
                let original = File.ReadAllText(Path.Combine(run, "run.json"))
                let checks = Check.Text(Read(run, "correction.json")["verification"])
                flow.Flow.Reload()
                flow.Flow.State["coordination_state_override"] = JsonValue.Create(state.ToJsonString())
                flow.Flow.Save()
                flow.Flow.Call([]string{"submit", "--run", run}, 1)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "run.json")) == original,
                    "Changed recorded outcome published a run"
                )
                flow.Flow.Reload()
                flow.Flow.State["coordination_state_override"] = nil
                flow.Flow.Save()
                flow.Flow.Call([]string{"submit", "--run", run})
                Check.That(Check.Text(Read(run)["state"]) == "published", "Exact recorded outcome was not recovered")
                Check.That(
                    Check.Text(Read(run, "correction.json")["verification"]) == checks,
                    "Outcome recovery reran checks"
                )
                flow.Flow.Reload()
                Check.That(Check.Text(flow.Flow.State["request_count"]) == "1", "Outcome recovery repeated request")
                Once(flow.Flow, 1)
            }
        }

        private func InterruptedManaged(binary string) {
            for mode in[]string{"push_fail_after_write", "request_fail_after_write", "request_fail_before_write"} {
                using let flow = CoordinationFixture(binary)
                flow.Initialize()
                let run = ManagedRun(flow, "staged_whitespace")
                Prepared(flow.Flow, run)
                let commit = Correct(flow.Flow, run)
                Recover(flow.Flow, run, commit)
                flow.Flow.Mode(mode)
                flow.Flow.Call([]string{"submit", "--run", run}, mode == "request_fail_after_write" ? 0: 1)
                let intent = Check.Text(Read(run, "correction.json")["publication"]?["request"])
                let checks = Check.Text(Read(run, "correction.json")["verification"])
                flow.Flow.Mode("")
                flow.Flow.Call([]string{"submit", "--run", run}, mode == "request_fail_before_write" ? 1: 0)
                flow.Flow.Reload()
                Check.That(
                    Check.Text(flow.Flow.State["request_count"]) == (mode == "request_fail_before_write" ? "": "1"),
                    "Interrupted submit duplicated a request"
                )
                Check.That(
                    Check.Text(Read(run, "correction.json")["publication"]?["request"]) == intent,
                    "Submit changed saved UUID/revision/metadata"
                )
                Check.That(Check.Text(Read(run, "correction.json")["verification"]) == checks, "Submit reran checks")
                Once(flow.Flow)
                if mode != "request_fail_before_write" {
                    let posted = Check.PostedRequest(flow.Flow.State)
                    let path = flow.Event(posted)
                    flow.Flow.Mode("lost_state_response")
                    flow.Coordinate(path, 1)
                    flow.Flow.Call([]string{"submit", "--run", run})
                    flow.Coordinate(path)
                    Once(flow.Flow, 1)
                }
            }
            using let external = CoordinationFixture(binary)
            external.Initialize()
            external.Claim()
            let run = external.Prepare()
            Check.Contains(external.Flow.Call([]string{"recover", "--run", run, "--prepare"}, 1).Error, "external")
            external.Flow.NoInference()
        }

        private func AmendCorrected(
            flow NativeFixture,
            run string,
            archive string,
            coordinator CoordinationFixture? = nil
        ) {
            let correction = Read(run)["correction"]?.DeepClone()
            let corrected = Check.Text(Read(run)["commit"])
            for text in[]string{"First amendment\n", "Second amendment\n"} {
                let commit = Correct(flow, run, text)
                let args = []string{"amend", "--run", run, "--commit", commit, "--seconds", "30"}
                flow.Call(args)
                if let managed = coordinator {
                    flow.Reload()
                    let request = Check.PostedRequest(flow.State)
                    managed.Coordinate(managed.Event(request))
                    flow.Call(args)
                }
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"})
                flow.Reload()
                let pull = flow.State["pulls"]?[0] ?? throw Exception("Missing corrected PR")
                let body = Check.Text(pull["body"])
                let prefix = "<!-- tokate-receipt:"
                let start = body.IndexOf(prefix) + prefix.Length
                let receiptText = body.Substring(start, body.IndexOf(" -->", start) - start)
                let receipt = Check.Json(receiptText)
                Check.That(
                    JsonNode.DeepEquals(receipt["correction"], correction),
                    "Amendment changed correction provenance"
                )
                Check.That(Check.Text(receipt["correction"]?["head"]) == corrected, "Historical corrected head lost")
                Check.That(Check.Text(receipt["head"]) == commit, "Receipt lost current amended head")
                Check.That(
                    File.ReadAllText(Path.Combine(run, "original-evidence/manifest.json")) == archive,
                    "Amendment changed original correction archive"
                )
                let provenance = receipt["correction"] ?? throw Exception("Missing correction provenance")
                provenance["head"] = JsonValue.Create(commit)
                pull["body"] = JsonValue.Create(body.Replace(receiptText, receipt.ToJsonString()))
                flow.Save()
                flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"}, 1)
                pull["body"] = JsonValue.Create(body)
                flow.Save()
            }
            let previous = Check.Text(Read(run)["commit"])
            File.WriteAllText(Path.Combine(run, "checkout/scripts/verify.sh"), "exit 0\n")
            let protectedCommit = Correct(flow, run)
            Check.Contains(
                flow.Call([]string{"amend", "--run", run, "--commit", protectedCommit, "--seconds", "30"}, 1).Error,
                "protected owner path"
            )
            Check.That(
                !Directory.Exists(Path.Combine(run, "amendments", protectedCommit)),
                "Protected amendment reached verification"
            )
            flow.Reload()
            Check.That(
                Check.Text(flow.State["pulls"]?[0]?["head"]?["sha"]) == previous,
                "Protected amendment published"
            )
            if let managed = coordinator {
                let state = managed.State()
                let metadata = Read(run)
                flow.Git(
                    "-C",
                    Path.Combine(run, "checkout"),
                    "push",
                    Path.Combine(flow.Bin, "fork"),
                    protectedCommit + ":refs/heads/" + Check.Text(metadata["branch"])
                )
                let request = Check.Map(
                    "uuid",
                    Guid.NewGuid().ToString("D"),
                    "expected",
                    Check.Text(state["sha"]),
                    "approval",
                    Check.Text(metadata["approval"]),
                    "action",
                    "amend",
                    "metadata",
                    Check.Map(
                        "fork",
                        Check.Text(metadata["head_repo"]),
                        "branch",
                        Check.Text(metadata["branch"]),
                        "previous",
                        previous,
                        "head",
                        protectedCommit,
                        "pr",
                        10,
                        "seconds",
                        30,
                        "tools",
                        Check.Json("[]"),
                        "verification",
                        "donor-reported-pass"
                    )
                )
                Check.Contains(managed.Coordinate(managed.Event(request), 1).Error, "protected owner path")
                Check.That(
                    Check.Text(managed.State()["sha"]) == Check.Text(state["sha"]),
                    "Protected coordinator amendment gained authority"
                )
            }
            Once(flow, 1)
        }

        private func CorrectedAmendmentsV1(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.ProtectedPolicy()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("staged_whitespace")
            flow.Call([]string{"work", "--run", run}, 1)
            let archive = Prepared(flow, run)
            Recover(flow, run, Correct(flow, run))
            AmendCorrected(flow, run, archive)
        }

        private func DecreeEdits(binary string) {
            for version in[]int32{1, 2} {
                for legacy in[]bool{false, true} {
                    using let test = DecreeFlow(binary, version)
                    test.Initialize()
                    test.Text("Approved owner instructions\n")
                    test.Flow.Approve()
                    if legacy {
                        test.Legacy()
                    }
                    let run = test.Start()
                    test.Flow.Mode("staged_whitespace")
                    test.Flow.Call([]string{"work", "--run", run}, 1)
                    let archive = Prepared(test.Flow, run)
                    let original = File.ReadAllText(Path.Combine(run, "run.json"))
                    let decree = Path.Combine(run, "checkout/DECREE.md")
                    File.WriteAllText(decree, "Corrected instruction edit\n")
                    var commit = Correct(test.Flow, run)
                    if !legacy {
                        Check.Contains(Recover(test.Flow, run, commit, 1).Error, "approved root DECREE.md")
                        let refused = Read(run, "correction.json")
                        Check.That(refused["verification"] == nil, "Protected correction reached verification")
                        Check.That(
                            Check.Text(refused["failure_stage"]) == "candidate_validation",
                            "Protected correction passed candidate validation"
                        )
                        Check.That(
                            File.ReadAllText(Path.Combine(run, "run.json")) == original,
                            "Refused correction rewrote original run"
                        )
                        test.Flow.NoPr()
                        File.WriteAllText(decree, "Approved owner instructions\n")
                        commit = Correct(test.Flow, run)
                    }
                    Recover(test.Flow, run, commit)
                    if let coordinator = test.V2 {
                        test.Flow.Call([]string{"submit", "--run", run})
                        test.Flow.Reload()
                        let request = Check.PostedRequest(test.Flow.State)
                        coordinator.Coordinate(coordinator.Event(request))
                        test.Flow.Call([]string{"submit", "--run", run})
                    }
                    let saved = File.ReadAllText(Path.Combine(run, "run.json"))
                    let correction = File.ReadAllText(Path.Combine(run, "correction.json"))
                    let previous = Check.Text(Read(run)["commit"])
                    File.WriteAllText(decree, "Amended instruction edit\n")
                    commit = Correct(test.Flow, run, "Amendment with instruction edit\n")
                    let args = []string{"amend", "--run", run, "--commit", commit, "--seconds", "30"}
                    if legacy {
                        test.Flow.Call(args)
                        if let coordinator = test.V2 {
                            test.Flow.Reload()
                            let request = Check.PostedRequest(test.Flow.State)
                            coordinator.Coordinate(coordinator.Event(request))
                            test.Flow.Call(args)
                        }
                        test.Flow.Call([]string{"verify-pr", "--repo", "owner/project", "--pr", "10"})
                    } else {
                        Check.Contains(test.Flow.Call(args, 1).Error, "approved root DECREE.md")
                        Check.That(
                            !Directory.Exists(Path.Combine(run, "amendments", commit)),
                            "Protected amendment reached verification"
                        )
                        Check.That(
                            File.ReadAllText(Path.Combine(run, "run.json")) == saved,
                            "Refused amendment rewrote saved run"
                        )
                        Check.That(
                            File.ReadAllText(Path.Combine(run, "correction.json")) == correction,
                            "Refused amendment changed correction evidence"
                        )
                        test.Flow.Reload()
                        Check.That(
                            Check.Text(test.Flow.State["pulls"]?[0]?["head"]?["sha"]) == previous,
                            "Protected amendment published"
                        )
                    }
                    Check.That(
                        File.ReadAllText(Path.Combine(run, "original-evidence/manifest.json")) == archive,
                        "Instruction edit changed original archive"
                    )
                    Once(test.Flow, 1)
                }
            }
        }

        private func CorrectedAmendmentsV2(binary string) {
            using let flow = CoordinationFixture(binary)
            flow.Initialize()
            flow.Flow.ProtectedPolicy()
            flow.Flow.Approve()
            let run = ManagedRun(flow, "staged_whitespace")
            let archive = Prepared(flow.Flow, run)
            Recover(flow.Flow, run, Correct(flow.Flow, run))
            flow.Flow.Call([]string{"submit", "--run", run})
            flow.Flow.Reload()
            let request = Check.PostedRequest(flow.Flow.State)
            flow.Coordinate(flow.Event(request))
            flow.Flow.Call([]string{"submit", "--run", run})
            AmendCorrected(flow.Flow, run, archive, flow)
        }

        private func Structured(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
            let policy = Check.Json(File.ReadAllText(policyPath))
            policy["verification"] = Check.Json("[[\"/bin/sh\",\"-c\",\"test -s result.txt\"]]")
            File.WriteAllText(policyPath, policy.ToJsonString())
            flow.Commit("Correction JSON checks")
            flow.Git("-C", flow.Upstream, "push", Path.Combine(flow.Bin, "fork"), "main")
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("staged_whitespace")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "trailing whitespace")
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            let prepared = Check.Envelope(
                flow.Call([]string{"recover", "--run", run, "--prepare", "--json"}),
                "recover",
                "ok"
            )
            Check.That(
                Check.Text(prepared["data"]?["artifacts"]?["original_evidence"]) == Path.Combine(
                    run,
                    "original-evidence"
                ),
                "Prepared JSON lost original artifact"
            )
            let failedCommit = Correct(flow, run, "")
            let failed = Check.Envelope(
                flow.Call([]string{"recover", "--run", run, "--commit", failedCommit, "--seconds", "30", "--json"}, 1),
                "recover",
                "error",
                "verification_failed"
            )
            Check.That(
                Check.Text(failed["data"]?["run_state"]?["correction"]?["state"]) == "failed",
                "JSON correction lost failed attempt"
            )
            let commit = Correct(flow, run)
            let published = Check.Envelope(
                flow.Call([]string{"recover", "--run", run, "--commit", commit, "--seconds", "30", "--json"}),
                "recover",
                "ok"
            )
            Check.That(
                Check.Text(published["data"]?["commit"]) == commit && Check.Text(
                    published["data"]?["correction"]?["commit"]
                ) == commit,
                "JSON correction lost exact head"
            )
            Check.That(
                File.ReadAllText(Path.Combine(run, "original-evidence/run.json")) == original,
                "JSON correction changed original"
            )
            Once(flow, 1)
        }

        internal func All(binary string, selected string = "") {
            var matched bool
            for name in[]string{
                "DecreeEdits",
                "Structured",
                "CorrectedAmendmentsV1",
                "CorrectedAmendmentsV2",
                "Whitespace",
                "BinaryRename",
                "FirstVerification",
                "OriginalTimeout",
                "WrongTarget",
                "Tools",
                "Refusals",
                "Incomplete",
                "ProtectedAndExact",
                "InterruptedNative",
                "ManagedAbsent",
                "Managed",
                "InterruptedManaged",
                "PublicationResponses",
                "PublicationOutcomes",
                "ChangedCandidate",
                "LegacyAndArchive",
                "AuthorityChanges",
                "ManagedRefusals",
                "InterruptedVerification"
            } {
                if selected != "" && selected != name {
                    continue
                }
                matched = true
                if !CiShard.Include("Correction/" + name) {
                    continue
                }
                switch name {
                    case "DecreeEdits" {
                        DecreeEdits(binary)
                    }
                    case "Structured" {
                        Structured(binary)
                    }
                    case "CorrectedAmendmentsV1" {
                        CorrectedAmendmentsV1(binary)
                    }
                    case "CorrectedAmendmentsV2" {
                        CorrectedAmendmentsV2(binary)
                    }
                    case "Whitespace" {
                        Whitespace(binary)
                    }
                    case "BinaryRename" {
                        BinaryRename(binary)
                    }
                    case "FirstVerification" {
                        FirstVerification(binary)
                    }
                    case "OriginalTimeout" {
                        OriginalTimeout(binary)
                    }
                    case "WrongTarget" {
                        WrongTarget(binary)
                    }
                    case "Tools" {
                        Tools(binary)
                    }
                    case "Refusals" {
                        Refusals(binary)
                    }
                    case "Incomplete" {
                        Incomplete(binary)
                    }
                    case "ProtectedAndExact" {
                        ProtectedAndExact(binary)
                    }
                    case "InterruptedNative" {
                        InterruptedNative(binary)
                    }
                    case "ManagedAbsent" {
                        for mode in[]string{"whitelist", "unrestricted"} {
                            Managed(binary, mode)
                        }
                    }
                    case "Managed" {
                        Managed(binary)
                    }
                    case "PublicationOutcomes" {
                        PublicationOutcomes(binary)
                    }
                    case "PublicationResponses" {
                        PublicationResponses(binary)
                    }
                    case "InterruptedManaged" {
                        InterruptedManaged(binary)
                    }
                    case "ChangedCandidate" {
                        ChangedCandidate(binary)
                    }
                    case "LegacyAndArchive" {
                        LegacyAndArchive(binary)
                    }
                    case "AuthorityChanges" {
                        AuthorityChanges(binary)
                    }
                    case "ManagedRefusals" {
                        ManagedRefusals(binary)
                    }
                    case "InterruptedVerification" {
                        InterruptedVerification(binary)
                    }
                }
                Console.WriteLine("PASS correction " + name)
            }
            Check.That(matched, "Unknown correction selector: " + selected)
        }
    }
}
