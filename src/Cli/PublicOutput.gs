package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text
import System.Text.Json

internal class PublicOutput {
    shared {
        internal var Enabled bool
        internal var Command string = "help"
        internal var RunDirectory string = ""
        internal var FailureCode string = "command_failed"
        internal var ResultData Object? = nil
        internal var Truncated bool
        internal let Actions List[[]string] = List[[]string]()

        internal func Reset(command string = "help") {
            Command = command
            RunDirectory = ""
            FailureCode = "command_failed"
            ResultData = nil
            Truncated = false
            Actions.Clear()
        }

        internal func Prose(value string) string -> Prose(value, ref Truncated)

        internal func Prose(value string, ref truncated bool) string {
            if value.Length <= 2048 {
                return value
            }
            truncated = true
            return value.Substring(0, Char.IsHighSurrogate(value[2047]) ? 2047: 2048)
        }

        internal func Select(value JsonElement, keys string) Dictionary[string, Object?] {
            let result = map[string, Object?]{}
            for key in keys.Split(',') {
                let item = J.Get(value, key)
                if item.ValueKind == JsonValueKind.String ||
                    item.ValueKind == JsonValueKind.Number ||
                    item.ValueKind == JsonValueKind.True ||
                    item.ValueKind == JsonValueKind.False {
                    result[key] = item
                }
            }
            return result
        }

        internal func Message(code string) string {
            switch code {
                case "invalid_arguments" {
                    return "Invalid command arguments. Consult command help."
                }
                case "missing_tools" {
                    return "Required tools are missing or failed diagnostics. Run doctor."
                }
                case "authentication_required" {
                    return "Authentication is required with the appropriate account."
                }
                case "stale_approval" {
                    return "Owner approval is absent or changed. Fresh owner approval is required."
                }
                case "invalid_state" {
                    return "The saved run or command state does not permit this operation. Inspect its artifacts."
                }
                case "verification_failed" {
                    return "Independent verification failed. Inspect the private verification artifact."
                }
                case "inference_failed" {
                    return "Inference did not complete successfully. Inspect private events and report artifacts; fresh owner approval is required for another attempt."
                }
                case "endpoint_unavailable" {
                    return "Selected local endpoint did not provide valid bounded metadata advertising the exact model ID. No inference started."
                }
                case "output_too_large" {
                    return "The complete result cannot fit within 64 KiB. Use focused help or private artifacts for details."
                }
                default {
                    return "Command failed. Inspect relevant state and private artifacts before any explicit next action."
                }
            }
        }

        internal func Tools(tools List[ToolCheck]) {
            let rows = List[Object]()
            for tool in tools {
                rows.Add(
                    map[string, Object?]{
                        "name": tool.Name,
                        "status": tool.Status,
                        "path": tool.Path,
                        "hint": tool.Hint,
                        "detail": tool.Detail
                    }
                )
            }
            ResultData = map[string, Object?]{"tools": rows, "tool_count": tools.Count, "inference": false}
        }

        private func Rows(value JsonElement, keys string, arguments bool = false) List[Object] {
            let rows = List[Object]()
            if value.ValueKind != JsonValueKind.Array {
                return rows
            }
            let count = value.GetArrayLength()
            if count > 64 {
                Truncated = true
            }
            for i in 0 ... Math.Min(64, count) {
                let item = value[i]
                let row = Select(item, keys)
                if arguments {
                    let command = J.Get(item, "command")
                    if command.ValueKind == JsonValueKind.Array {
                        var valid = true
                        for word in command.EnumerateArray() {
                            if word.ValueKind != JsonValueKind.String {
                                valid = false
                            }
                        }
                        if valid {
                            row["command"] = command
                        }
                    }
                }
                rows.Add(row)
            }
            return rows
        }

        private func KnownReason(reason string) bool -> Array.IndexOf(
            []string{
                "missing_tools",
                "authentication_required",
                "stale_approval",
                "invalid_state",
                "verification_failed",
                "inference_failed",
                "endpoint_unavailable",
                "command_failed"
            },
            reason
        ) >= 0

        internal func Policy(value JsonElement) Object {
            let result = Select(
                value,
                "version,max_seconds,allow_network,reservation_seconds,approval_scope,eligibility,target_branch,pr_text,close_message"
            )
            result["close_message"] = Policy.CloseMessage(value)
            let mode = J.Text(value, "model_policy")
            result["model_policy"] = mode == "" ? "whitelist": mode
            let models = map[string, Object?]{}
            let effortCounts = map[string, Object?]{}
            let source = J.Get(value, "models")
            var count int32
            if source.ValueKind == JsonValueKind.Object {
                for model in source.EnumerateObject() {
                    count++
                    if count <= 64 {
                        let efforts = J.Items(model.Value)
                        let retained = List[Object]()
                        for i in 0 ... Math.Min(64, efforts.Count) {
                            retained.Add(efforts[i])
                        }
                        models[model.Name] = retained
                        effortCounts[model.Name] = efforts.Count
                        Truncated = Truncated || efforts.Count > 64
                    }
                }
            }
            Truncated = Truncated || count > 64
            result["models"] = models
            result["model_count"] = count
            result["model_effort_counts"] = effortCounts
            for key in[]string{"verification", "required_checks", "protected_paths"} {
                let items = J.Items(J.Get(value, key))
                let rows = List[Object]()
                for i in 0 ... Math.Min(64, items.Count) {
                    rows.Add(items[i])
                }
                result[key] = rows
                result[key + "_count"] = items.Count
                Truncated = Truncated || items.Count > 64
            }
            let tools = J.Get(value, "allowed_tools")
            if tools.ValueKind == JsonValueKind.Array {
                result["allowed_tools"] = Rows(tools, "harness,provider")
                result["allowed_tools_count"] = J.Items(tools).Count
            }
            return result
        }

        internal func RunSummary(directory string) Dictionary[string, Object?] {
            let run = Data.Load(directory)
            let value = run.Element()
            let result = Select(
                value,
                "version,id,repo,issue,donor,donor_id,head_repo,approval,base,base_branch,policy_hash,model,effort,seconds,verification_reserve,network,branch,state,state_sha,publication_uuid,source,commit,pr,pr_url,recovered,recovery_seconds,elapsed_seconds,codex_version,output_truncated,error_truncated,preparation_version,preparation_complete,checkout_prepared,attempt"
            )
            if run.Number("version") == 1 || run.Text("source") == "tokate" {
                result["coding_seconds"] = run.Number("seconds") - run.Number("verification_reserve")
                result["verification_reserve"] = run.Number("verification_reserve")
            }
            result["run"] = directory
            result["storage"] = RunStorage.Summary(directory, run)
            let verification = J.Get(value, "verification")
            result["verification"] = Rows(verification, "state,exit_code,output_truncated,error_truncated", true)
            result["verification_count"] = J.Items(verification).Count
            if J.Get(value, "reconciliation").ValueKind == JsonValueKind.Object {
                let local = Select(J.Get(value, "reconciliation"), "phase,previous,upstream,start,target,candidate")
                local["local"] = true
                local["verified"] = false
                result["reconciliation"] = local
            }
            if V1Continuation.Has(run) {
                result["predecessor"] = J.Get(value, "continuation")
                result["continuation_phase"] = run.Text("continuation_phase")
            }
            let usage = map[string, Object?]{}
            for key in[]string{"input_tokens", "cached_input_tokens", "output_tokens"} {
                let item = J.Get(J.Get(value, "usage"), key)
                var count int64
                if item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out count) && count >= 0 {
                    usage[key] = count
                }
            }
            if usage.Count > 0 {
                result["usage"] = usage
            }
            let tools = J.Get(value, "tools")
            if tools.ValueKind == JsonValueKind.Array {
                result["tools"] = Rows(tools, "harness,provider,model,effort,version")
                result["tool_count"] = J.Items(tools).Count
            }
            let amendments = J.Get(value, "amendments")
            if amendments.ValueKind == JsonValueKind.Array {
                result["amendments"] = Rows(amendments, "id,previous,head")
                result["amendment_count"] = J.Items(amendments).Count
            }
            let correctionPath = Path.Combine(directory, "correction.json")
            if File.Exists(correctionPath) {
                let correction = Data.Read(correctionPath)
                var uuid Guid
                let location = Guid.TryParse(correction.Text("uuid"), out uuid) ?
                Path.Combine(directory, "correction-" + correction.Text("uuid")): directory
                result["correction"] = ChangeSummary(correction, location)
            }
            if run.Text("state") == "failed" {
                let reason = (
                    run.Text("failure_reason") == "incomplete_turn" || run.Text(
                        "failure_reason"
                    ) == "inference_interrupted"
                ) ? "inference_failed": run.Text("failure_reason")
                let code = Recovery.Eligible(run) ? "verification_failed": (
                    KnownReason(reason) ? reason: "command_failed"
                )
                result["failure_reason"] = code
                result["error"] = map[string, Object?]{"code": code, "message": Message(code)}
            }
            result["artifacts"] = Artifacts(directory)
            if Encoding.UTF8.GetByteCount(J.Write(result)) > 65536 {
                throw CliFailure("output_too_large", Message("output_too_large"))
            }
            return result
        }

        internal func Artifacts(directory string) Dictionary[string, Object?] {
            let artifacts = map[string, Object?]{}
            for name in[]string{
                "run.json",
                "events.jsonl",
                "stderr.log",
                "report.md",
                "verification.json",
                "candidate.patch",
                "changes.patch",
                "pr-body.md",
                "publication.json",
                "checks.json",
                "record.json",
                "correction.json"
            } {
                let path = Path.Combine(directory, name)
                if File.Exists(path) {
                    artifacts[name] = path
                }
            }
            for name in[]string{
                "original-evidence",
                "amendments",
                "coding",
                "checkout",
                "coding.staging",
                "checkout.staging"
            } {
                let path = Path.Combine(directory, name)
                if Directory.Exists(path) {
                    artifacts[name.Replace('-', '_')] = path
                }
            }
            return artifacts
        }

        internal func ChangeSummary(change Data, directory string) Object {
            let value = change.Element()
            let result = Select(
                value,
                "id,uuid,previous,commit,tree,patch_sha256,seconds,state,pr,elapsed_seconds,verification_seconds"
            )
            let tools = J.Get(value, "tools")
            result["tools"] = Rows(tools, "harness,provider,model,effort,version")
            result["tool_count"] = J.Items(tools).Count
            let checks = J.Get(value, "verification")
            result["verification"] = Rows(checks, "state,exit_code,output_truncated,error_truncated", true)
            result["verification_count"] = J.Items(checks).Count
            let reason = change.Text("failure_reason")
            let failed = change.Text("state") == "failed" || reason != ""
            if failed || change.Fields.ContainsKey("error") || change.Fields.ContainsKey("publication_error") {
                let code = KnownReason(reason) ? reason: (
                    reason == "publication_interrupted" ? "command_failed": "invalid_state"
                )
                result["failure_reason"] = code
                result["error"] = map[string, Object?]{"code": code, "message": Message(code)}
            }
            result["artifacts"] = Artifacts(directory)
            return result
        }

        internal func Coordination(value JsonElement, sha string) Object {
            let result = Select(value, "version,repo,issue,approval_id,revoked")
            result["identity"] = J.Get(value, "identity")
            result["sha"] = sha
            let approval = J.Get(value, "approval")
            let summary = Select(
                approval,
                "repo,repo_id,issue,donor,approval_scope,eligibility,base,base_branch,authority_branch,policy_hash,template_hash"
            )
            if Decree.HasSnapshot(approval) {
                summary["decree"] = Select(J.Get(approval, "decree"), "present,sha256")
            }
            result["approval"] = summary
            result["reservation"] = Select(
                J.Get(value, "reservation"),
                "reservation,lease,donor,actor,created,expires,status,attempt"
            )
            result["contribution"] = Select(
                J.Get(CoordinationState.Current(value), "outcome"),
                "pr,url,head,reservation"
            )
            result["outcome_count"] = J.Items(J.Get(value, "outcomes")).Count
            return result
        }

        internal func Checks(run Data, rows JsonElement, status string, facts Dictionary[string, Object?]) {
            let result = Select(run.Element(), "repo,pr,pr_url,commit")
            for fact in facts {
                result[fact.Key] = fact.Value
            }
            result["checks_status"] = status
            result["checks"] = Rows(rows, "name,state,bucket,link,workflow")
            result["check_count"] = J.Items(rows).Count
            ResultData = result
        }

        internal func Next(options Args?, code string) {
            if options != nil && options.Command == "repair" && code == "" {
                Actions.Add(
                    []string{"tokate", "verify-pr", "--repo", options.Get("repo"), "--pr", options.Get("pr"), "--json"}
                )
                Actions.Add(
                    []string{"tokate", "checks", "--repo", options.Get("repo"), "--pr", options.Get("pr"), "--json"}
                )
            }
            if RunDirectory != "" {
                try {
                    let run = Data.Load(RunDirectory)
                    if code != "" && ResultData is Dictionary[string, Object?]fields {
                        fields["run_state"] = RunSummary(RunDirectory)
                    } else if ResultData == nil {
                        ResultData = RunSummary(RunDirectory)
                    }
                    if options != nil && Command == "amend" && ResultData is Dictionary[string, Object?]fields {
                        let location = Path.Combine(RunDirectory, "amendments", options.Get("commit"))
                        if File.Exists(Path.Combine(location, "run.json")) {
                            fields["amendment"] = ChangeSummary(Data.Load(location), location)
                        }
                    }
                    Actions.Add([]string{"tokate", "status", "--run", RunDirectory, "--json"})
                    if Command == "reconcile" {
                        let intent = J.Get(run.Element(), "reconciliation")
                        if code != "" &&
                            code != "stale_approval" &&
                            (J.Text(intent, "phase") == "fetching" || J.Text(intent, "phase") == "merging") {
                            Actions.Add([]string{"tokate", "reconcile", "--run", RunDirectory, "--resume", "--json"})
                        }
                        return
                    }
                    if run.Text("state") == "preparing" && run.Number("preparation_version") == 1 &&
                        code != "stale_approval" {
                        Actions.Add([]string{"tokate", "prepare", "--run", RunDirectory, "--json"})
                    }
                    if code == "" && run.Text("state") == "claimed" &&
                        (run.Number("version") == 1 || run.Text("source") == "tokate") {
                        Actions.Add([]string{"tokate", "work", "--run", RunDirectory, "--json"})
                    }
                    if code != "stale_approval" && code != "invalid_state" {
                        let correction = Path.Combine(RunDirectory, "correction.json")
                        let original = Path.Combine(RunDirectory, "original-evidence")
                        if Recovery.Eligible(run) && !File.Exists(correction) && !Directory.Exists(original) {
                            Actions.Add([]string{"tokate", "recover", "--run", RunDirectory, "--json"})
                        } else if run.Text("state") == "generated" && run.Number("version") == 1 {
                            Actions.Add([]string{"tokate", "publish", "--run", RunDirectory, "--json"})
                        } else if run.Number("pr") > 0 {
                            Actions.Add([]string{"tokate", "checks", "--run", RunDirectory, "--json"})
                        } else if run.Text("state") == "generated" && run.Number("version") == 2 {
                            Actions.Add([]string{"tokate", "submit", "--run", RunDirectory, "--json"})
                        }
                    }
                } catch (error Exception) { }
            }
            if code == "invalid_arguments" {
                var known bool
                for command in Cli.Commands {
                    known = known || command.Name == Command
                }
                Actions.Add(known ? []string{"tokate", "help", Command, "--json"}: []string{"tokate", "help", "--json"})
            } else if code == "missing_tools" {
                if Command != "doctor" {
                    let diagnostic = Startup.NeedsCatalog(Command, options) ? "--managed": (
                        Command == "external" ||
                            Command == "repair" ||
                            Command == "amend" ||
                            Command == "recover" ||
                            Command == "submit" ||
                            Command == "publish" ? "--external": "--owner"
                    )
                    Actions.Add([]string{"tokate", "doctor", diagnostic, "--json"})
                }
            }
            if options != nil && code == "" && Command == "checks" && RunDirectory == "" {
                Actions.Add(
                    []string{"tokate", "checks", "--repo", options.Get("repo"), "--pr", options.Get("pr"), "--json"}
                )
            }
        }

        internal func Emit(exitCode int32, code string = "", message string = "") int32 {
            var resultCode = exitCode
            let failure Object? = exitCode == 0 ||
                exitCode == 8 ? nil: map[string, Object?]{
                "code": code == "" ? "command_failed": code,
                "message": Prose(message == "" ? Message(code): message)
            }
            let envelope = map[string, Object?]{
                "schema_version": 1,
                "command": Command,
                "status": exitCode == 8 ? "pending": (exitCode == 0 ? "ok": "error"),
                "exit_code": exitCode,
                "data": ResultData ?? map[string, Object?]{},
                "error": failure,
                "next_actions": Actions,
                "truncated": Truncated
            }
            var text = J.Write(envelope)
            if Encoding.UTF8.GetByteCount(text) + 1 > 65536 {
                envelope["command"] = Command.Length > 2048 ? "unknown": Command
                envelope["status"] = "error"
                envelope["exit_code"] = 1
                envelope["data"] = map[string, Object?]{}
                envelope["error"] = map[string, Object?]{
                    "code": "output_too_large",
                    "message": Message("output_too_large")
                }
                envelope["next_actions"] = []Object{}
                envelope["truncated"] = true
                text = J.Write(envelope)
                resultCode = 1
            }
            Console.WriteLine(text)
            return resultCode
        }
    }
}
