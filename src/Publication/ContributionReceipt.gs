package Tokate

import System.Collections.Generic
import System.Text.Json

internal class ContributionReceipt {
    shared {
        internal func Coordinated(
            repo string,
            issue int32,
            approval string,
            expected string,
            reservation string,
            donor string,
            head string
        ) Dictionary[string, Object?] -> map[string, Object?]{
            "version": 2,
            "repo": repo,
            "issue": issue,
            "approval": approval,
            "expected": expected,
            "reservation": reservation,
            "donor": donor,
            "head": head
        }

        internal func FromState(state JsonElement) JsonElement {
            let current = CoordinationState.Current(state)
            let original = J.Get(state, "contribution")
            let fields = Coordinated(
                J.Text(state, "repo"),
                J.Number(state, "issue"),
                J.Text(state, "approval_id"),
                J.Text(current, "expected"),
                J.Text(J.Get(state, "reservation"), "reservation"),
                J.Text(original, "donor"),
                J.Text(J.Get(current, "outcome"), "head")
            )
            let correction = J.Get(J.Get(original, "metadata"), "correction")
            let handoff = J.Get(J.Get(original, "metadata"), "handoff")
            if handoff.ValueKind != JsonValueKind.Undefined {
                fields["handoff"] = handoff
            }
            if J.Count(J.Get(state, "amendments")) == 0 && RequestData.Incomplete(J.Get(original, "metadata")) {
                fields["incomplete"] = true
            }
            AttemptContinuation.Keep(fields, J.Get(original, "metadata"))
            if correction.ValueKind != JsonValueKind.Undefined {
                fields["correction"] = correction
            }
            if J.Count(J.Get(state, "amendments")) > 0 {
                let amended = map[string, Object?]{
                    "id": J.Text(current, "request"),
                    "previous": J.Text(current, "previous"),
                    "seconds": J.Number(current, "seconds"),
                    "tools": J.Get(current, "tools")
                }
                if J.Text(current, "sync") != "" {
                    amended["sync"] = J.Text(current, "sync")
                }
                fields["amendment"] = PublicSummary.Attach(amended, J.Get(current, "summary"))
            }
            Synchronization.Keep(fields, Synchronization.History(current))
            return J.Parse(J.Write(fields))
        }
    }
}
