package Tokate

import System.Collections.Generic
import System.Text.Json

internal class ContributionReceipt {
    shared {
        internal func Native(run Data, head string, version int32 = 1) Dictionary[string, Object?] {
            let receipt = J.Map("version", version)
            receipt["repo"] = run.Text("repo")
            receipt["issue"] = run.Number("issue")
            receipt["donor"] = run.Text("donor")
            receipt["approval"] = run.Text("approval")
            receipt["head"] = head
            if version == 1 {
                receipt["model"] = run.Text("model")
                receipt["effort"] = run.Text("effort")
                receipt["seconds"] = run.Number("seconds")
                receipt["network"] = run.Flag("network")
                receipt["policy"] = run.Text("policy_hash")
            }
            return receipt
        }

        internal func Coordinated(
            repo string,
            issue int32,
            approval string,
            expected string,
            reservation string,
            donor string,
            head string
        ) Dictionary[string, Object?] {
            let receipt = J.Map("version", 2)
            receipt["repo"] = repo
            receipt["issue"] = issue
            receipt["approval"] = approval
            receipt["expected"] = expected
            receipt["reservation"] = reservation
            receipt["donor"] = donor
            receipt["head"] = head
            return receipt
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
            if correction.ValueKind != JsonValueKind.Undefined {
                fields["correction"] = correction
            }
            if J.Items(J.Get(state, "amendments")).Count > 0 {
                let amended = J.Map(
                    "id",
                    J.Text(current, "request"),
                    "previous",
                    J.Text(current, "previous"),
                    "seconds",
                    J.Number(current, "seconds"),
                    "tools",
                    J.Get(current, "tools")
                )
                if J.Text(current, "sync") != "" {
                    amended["sync"] = J.Text(current, "sync")
                }
                fields["amendment"] = amended
            }
            Synchronization.Keep(fields, Synchronization.History(current))
            return J.Parse(J.Write(fields))
        }
    }
}
