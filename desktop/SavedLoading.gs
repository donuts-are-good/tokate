package TokateDesktop

import Goo
import System
import System.Collections.Generic
import System.Text.Json

class SavedPageLoader {
    let Readers[]CommandRunner = []CommandRunner{CommandRunner(), CommandRunner(), CommandRunner(), CommandRunner()}

    func Stop() {
        for reader in Readers {
            reader.Stop()
        }
    }
}

func ReadSavedPage(
    loader SavedPageLoader,
    host Window,
    sources[]SavedContribution,
    changed Action[SavedContribution],
    finished Action
) {
    let count = Math.Min(loader.Readers.Length, sources.Length)
    scope {
        for index in 0 ... count {
            let batch = List[SavedContribution]()
            for item in 0 ... sources.Length {
                if item % count == index {
                    batch.Add(sources[item])
                }
            }
            go ReadSavedContributions(loader.Readers[index], host, batch.ToArray(), changed)
        }
    }
    host.TryPost(finished)
}

func ReadSavedContributions(
    reader CommandRunner,
    host Window,
    sources[]SavedContribution,
    changed Action[SavedContribution]
) {
    for source in sources {
        var item = source
        if item.Data.ValueKind != JsonValueKind.Object {
            let status = reader.Run([]string{"status", "--run", item.Path})
            if status.Error.StartsWith("Command cancelled") {
                return
            }
            let data = Field(status.Value, "data")
            item = SavedContribution{
                Path: item.Path,
                Data: data,
                Actions: Field(status.Value, "next_actions"),
                Error: status.Error != "" ? status.Error: status.ExitCode != 0 ?
                TextOf(Field(status.Value, "error"), "message"): "",
            }
            if TextOf(data, "repo") == "" || Number(data, "issue") < 1 {
                item.Error = item.Error == "" ? "Saved contribution could not be read.": item.Error
            }
            let local = item
            host.TryPost(() -> changed(local))
        }
        let updated = SavedContribution{
            Path: item.Path,
            Data: item.Data,
            Actions: item.Actions,
            Title: item.Title,
            Remote: item.Remote,
            RemoteError: item.RemoteError,
            Error: item.Error,
            Refreshed: true,
        }
        if item.Error == "" {
            let issue = reader.Run(
                []string{"api", "repos/" + TextOf(item.Data, "repo") + "/issues/" + TextOf(item.Data, "issue")},
                "gh",
                seconds: 30
            )
            if issue.Error.StartsWith("Command cancelled") {
                return
            }
            updated.RemoteError = issue.Error != "" || issue.ExitCode != 0
            if !updated.RemoteError {
                updated.Title = TextOf(issue.Value, "title")
            }
            if Number(item.Data, "pr") > 0 {
                let pull = reader.Run(
                    []string{
                        "pr",
                        "view",
                        TextOf(item.Data, "pr"),
                        "--repo",
                        TextOf(item.Data, "repo"),
                        "--json",
                        "state,reviewDecision,statusCheckRollup,url"
                    },
                    "gh",
                    seconds: 30
                )
                if pull.Error.StartsWith("Command cancelled") {
                    return
                }
                updated.RemoteError = updated.RemoteError || pull.Error != "" || pull.ExitCode != 0
                if pull.Error == "" && pull.ExitCode == 0 {
                    updated.Remote = pull.Value
                }
            }
        }
        host.TryPost(() -> changed(updated))
    }
}
