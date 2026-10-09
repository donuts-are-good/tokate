package Tokate

import System
import System.IO
import System.Text.Json

internal class ReservationRequest {
    shared {
        internal func Inspect(directory string) JsonElement {
            let run = Data.Load(directory)
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, run) {
                throw CliFailure("authentication_required", "Active GitHub account differs from the saved donor")
            }
            let state = CoordinationState.Load(run.Text("repo"), run.Number("issue"))
            let request = J.Get(run.Element(), "reservation_request")
            var actions[]string
            if request.ValueKind != JsonValueKind.Undefined {
                RequestData.Request(request)
                if !LeaseLifecycle.Transition(J.Text(request, "action")) {
                    throw Exception("Invalid saved reservation request")
                }
                actions = []string{J.Text(request, "action")}
            } else {
                if J.Text(J.Get(state.Value(), "identity"), "id") != run.Text("id") {
                    throw CliFailure("stale_approval", "Saved contribution ownership was replaced")
                }
                LeaseLifecycle.Owner(state, J.Get(viewer, "id"))
                actions = []string{
                    J.Text(J.Get(state.Value(), "reservation"), "status") == "paused" ? "resume": "pause",
                    "renew",
                    "release"
                }
            }
            return J.Parse(
                J.Write(
                    map[string, Object?]{
                        "status": J.Text(J.Get(state.Value(), "reservation"), "status"),
                        "pending_request": request.ValueKind != JsonValueKind.Undefined,
                        "actions": actions
                    }
                )
            )
        }

        private func Result(directory string, run Data, state CoordinationState, request JsonElement) int32 {
            let outcome = RequestData.Recorded(state.Value(), J.Get(run.Element(), "donor_id"), request)
            let pending = outcome.ValueKind == JsonValueKind.Undefined
            PublicOutput.ResultData = map[string, Object?]{
                "run_directory": directory,
                "operation": J.Text(request, "action"),
                "pending": pending,
                "state_sha": state.Sha,
                "reservation": J.Get(state.Value(), "reservation"),
                "outcome": pending ? nil: outcome as Object
            }
            if pending {
                PublicOutput.Actions.Add(
                    []string{
                        "tokate",
                        "request",
                        "--run",
                        directory,
                        "--operation",
                        J.Text(request, "action"),
                        "--json"
                    }
                )
                Terminal.Message("Reservation request pending. Saved work: " + directory)
                return 8
            }
            run.Fields.Remove("reservation_request")
            run.Save(directory)
            Terminal.Message("Reservation " + J.Text(request, "action") + " accepted. Saved work: " + directory)
            return 0
        }

        internal func Run(args Args) int32 {
            let directory = Path.GetFullPath(args.Need("run"))
            using let lease = RunStorage.Lease(directory)
            let run = Data.Load(directory)
            PublicOutput.RunDirectory = directory
            let action = args.Need("operation")
            if !LeaseLifecycle.Transition(action) || run.Number("version") != 2 || run.Text("id") == "" {
                throw Exception("Choose pause, resume, renew or release for a prepared version 2 run")
            }
            let viewer = GitHub.Api("user")
            if !RepositoryIdentity.SameDonor(viewer, run) {
                throw CliFailure("authentication_required", "Active GitHub account differs from the saved donor")
            }
            let repo = run.Text("repo")
            let issue = run.Number("issue")
            var state = CoordinationState.Load(repo, issue)
            var request = J.Get(run.Element(), "reservation_request")
            if request.ValueKind != JsonValueKind.Undefined {
                RequestData.Request(request)
                let outcome = RequestData.Recorded(state.Value(), J.Get(viewer, "id"), request)
                if outcome.ValueKind == JsonValueKind.Undefined && J.Text(request, "action") != action {
                    throw Exception(
                        "A different reservation request is pending; inspect its outcome before another action"
                    )
                }
                if outcome.ValueKind != JsonValueKind.Undefined {
                    let result = Result(directory, run, state, request)
                    if J.Text(request, "action") == action {
                        return result
                    }
                    request = JsonElement{}
                }
            }
            let value = state.Value()
            if J.Text(J.Get(value, "identity"), "id") != run.Text("id") {
                throw CliFailure("stale_approval", "Saved contribution ownership was replaced")
            }
            LeaseLifecycle.Owner(state, J.Get(viewer, "id"))
            if request.ValueKind == JsonValueKind.Undefined {
                if action != "release" {
                    state.Check(repo, issue, run.Text("donor"), J.Get(viewer, "id"))
                    if J.Text(value, "approval_id") != run.Text("approval") {
                        throw CliFailure("stale_approval", "Saved contribution approval changed")
                    }
                }
                let status = J.Text(J.Get(value, "reservation"), "status")
                if (action == "pause" && status != "active") || (action == "resume" && status != "paused") {
                    throw Exception("Reservation state does not permit this operation")
                }
                request = J.Parse(
                    J.Write(
                        map[string, Object?]{
                            "uuid": Guid.NewGuid().ToString("D"),
                            "expected": state.Sha,
                            "approval": J.Text(value, "approval_id"),
                            "action": action,
                            "metadata": map[string, Object?]{}
                        }
                    )
                )
                run.Fields["reservation_request"] = request
                run.Save(directory)
            }
            var id Guid
            if !Guid.TryParseExact(J.Text(request, "uuid"), "D", out id) || !LeaseLifecycle.Transition(
                J.Text(request, "action")
            ) {
                throw Exception("Invalid saved reservation request")
            }
            let journal = "reservation-" + id.ToString("D") + ".posting.json"
            RunStorage.ControlFile(directory, journal)
            Submission.Request(repo, issue, request, Path.Combine(directory, journal), J.Get(viewer, "id"))
            state = CoordinationState.Load(repo, issue)
            return Result(directory, run, state, request)
        }
    }
}
