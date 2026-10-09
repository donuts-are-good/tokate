package Tokate

import System
import System.Collections.Generic
import System.Text.Json

internal class LeaseLifecycle {
    shared {
        internal func Supported(value JsonElement) bool -> J.Get(value, "identity").ValueKind == JsonValueKind.Object

        internal func Transition(action string) bool -> action == "renew" ||
            action == "pause" ||
            action == "resume" ||
            action == "release"

        internal func Owner(state CoordinationState, actor JsonElement, active bool = false) {
            let value = state.Value()
            let reservation = J.Get(value, "reservation")
            RepositoryIdentity.PositiveId(actor)
            if RepositoryIdentity.PositiveId(J.Get(reservation, "actor")) != RepositoryIdentity.PositiveId(actor) ||
                CoordinationState.Unix(reservation, "expires") <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() || J.Text(
                reservation,
                "status"
            ) == "released" {
                throw CliFailure("stale_approval", "Lease expired, released or belongs to another numeric donor")
            }
            let identity = J.Get(value, "identity")
            var id Guid
            var lease Guid
            if !Guid.TryParseExact(J.Text(reservation, "lease"), "D", out lease) || lease.ToString("D") != J.Text(
                reservation,
                "lease"
            ) ||
                !Guid.TryParseExact(J.Text(identity, "id"), "D", out id) || id.ToString("D") != J.Text(identity, "id") {
                throw Exception("Incomplete lease or contribution identity")
            }
            if J.Text(identity, "id") != J.Text(reservation, "reservation") || RepositoryIdentity.PositiveId(
                J.Get(identity, "actor")
            ) != RepositoryIdentity.PositiveId(actor) {
                throw Exception("Lease differs from the contribution identity")
            }
            let status = J.Text(reservation, "status")
            if status == "active" {
                var attempt Guid
                if !Guid.TryParseExact(J.Text(reservation, "attempt"), "D", out attempt) || attempt.ToString(
                    "D"
                ) != J.Text(reservation, "attempt") {
                    throw Exception("Active lease needs a canonical attempt identity")
                }
            } else if status == "paused" {
                if J.Text(reservation, "attempt") != "" {
                    throw Exception("Paused lease cannot retain an active attempt")
                }
            } else {
                throw Exception("Unsupported lease lifecycle state")
            }
            if active && status != "active" {
                throw CliFailure("stale_approval", "No active coding attempt; resume grants a fresh fence only")
            }
        }

        internal func Fence(state CoordinationState, attempt string) {
            if attempt != J.Text(J.Get(state.Value(), "reservation"), "attempt") {
                throw CliFailure("stale_approval", "Publication attempt fence was invalidated or replaced")
            }
        }

        internal func Apply(
            state CoordinationState,
            request JsonElement,
            actor JsonElement,
            donor string,
            policy JsonElement
        ) Object {
            let value = state.Value()
            let reservation = J.Get(value, "reservation")
            let identity = J.Get(value, "identity")
            let action = J.Text(request, "action")
            let uuid = J.Text(request, "uuid")
            let now = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            let duration = J.Get(policy, "reservation_seconds").ValueKind == JsonValueKind.Undefined ? 86400: J.Number(
                policy,
                "reservation_seconds"
            )
            if action == "claim" {
                if reservation.ValueKind == JsonValueKind.Object && J.Text(reservation, "status") != "released" &&
                    CoordinationState.Unix(reservation, "expires") > now {
                    throw Exception("An unexpired reservation already owns this contribution")
                }
                if reservation.ValueKind == JsonValueKind.Object && !Supported(value) {
                    throw Exception("Legacy lease reacquisition is unsupported; fresh owner approval is required")
                }
                let same = Supported(value) && RepositoryIdentity.PositiveId(
                    J.Get(identity, "actor")
                ) == RepositoryIdentity.PositiveId(actor)
                let id = same ? J.Text(identity, "id"): uuid
                if !same {
                    let next = map[string, Object?]{"id": id, "actor": actor}
                    if Supported(value) {
                        next["predecessor"] = map[string, Object?]{
                            "revision": state.Sha,
                            "id": J.Text(identity, "id"),
                            "actor": J.Get(identity, "actor")
                        }
                    }
                    state.Fields["identity"] = next
                    state.Fields["contribution"] = nil
                    state.Fields["amendments"] = []Object{}
                    state.Fields["publication_revision"] = nil
                } else {
                    Pin(state)
                }
                let outcome = map[string, Object?]{
                    "reservation": id,
                    "lease": uuid,
                    "donor": donor,
                    "actor": actor,
                    "created": now,
                    "expires": now + duration,
                    "status": "active",
                    "attempt": uuid
                }
                state.Fields["reservation"] = outcome
                return outcome
            }
            if !Supported(value) {
                throw Exception("Legacy lease transitions are unsupported; fresh owner approval is required")
            }
            Owner(state, actor)
            let status = J.Text(reservation, "status")
            if (action == "pause" && status != "active") || (action == "resume" && status != "paused") {
                throw Exception("Lifecycle transition does not match the current lease state")
            }
            Pin(state)
            let fields = map[string, Object?]{}
            for field in reservation.EnumerateObject() {
                fields[field.Name] = field.Value.Clone()
            }
            fields["donor"] = donor
            if action == "release" {
                fields["status"] = "released"
                fields["attempt"] = ""
                fields["expires"] = now
            } else {
                fields["expires"] = Math.Max(CoordinationState.Unix(reservation, "expires"), now + duration)
                if action == "pause" {
                    fields["expires"] = now + duration
                    fields["status"] = "paused"
                    fields["attempt"] = ""
                } else if action == "resume" {
                    fields["status"] = "active"
                    fields["attempt"] = uuid
                }
            }
            state.Fields["reservation"] = fields
            return fields
        }

        private func Pin(state CoordinationState) {
            let value = state.Value()
            if J.Get(value, "contribution").ValueKind == JsonValueKind.Object && J.Text(
                value,
                "publication_revision"
            ) == "" {
                state.Fields["publication_revision"] = state.Sha
            }
        }
    }
}
