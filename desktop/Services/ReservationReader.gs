package TokateDesktop

import System
import System.IO
import System.Text.Json

func ReadReservation(runner CommandClient, run JsonElement, directory string, completed Action[bool, string]) {
    var ready = false
    var error = ""
    try {
        let path = Path.Combine(directory, "run.json")
        if FileInfo(path).Length > 1048576 {
            throw Exception("Saved claim is too large.")
        }
        using let document = JsonDocument.Parse(File.ReadAllText(path))
        let request = TextOf(Field(document.RootElement, "claim_request"), "uuid")
        if !Guid.TryParse(request, out var uuid) {
            throw Exception("Saved claim identity is missing.")
        }
        let result = runner.Run(
            []string{"coordination", "--repo", TextOf(run, "repo"), "--issue", TextOf(run, "issue")}
        )
        if result.Error != "" || result.ExitCode != 0 {
            throw Exception("Approval check unavailable. Checking again shortly.")
        }
        let state = Field(result.Value, "data")
        let reservation = Field(state, "reservation")
        var expires int64
        ready = TextOf(state, "approval_id") == TextOf(run, "approval") && Field(
            state,
            "revoked"
        ).ValueKind == JsonValueKind.False &&
            TextOf(reservation, "lease") == request &&
            TextOf(reservation, "attempt") == request &&
            TextOf(reservation, "actor") == TextOf(run, "donor_id") &&
            TextOf(reservation, "status") == "active" &&
            Field(reservation, "expires").TryGetInt64(out expires) &&
            expires > DateTimeOffset
            .UtcNow
            .ToUnixTimeSeconds()
    } catch (failure Exception) {
        error = failure.Message
    }
    completed(ready, error)
}
