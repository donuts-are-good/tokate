package TokateTests

import System
import System.IO

internal class RepositoryFaults {
    shared {
        internal func Reject(
            flow NativeFixture,
            run string,
            args[]string,
            repositoryError string = "Donor access authority"
        ) {
            let original = File.ReadAllText(Path.Combine(run, "run.json"))
            for fault in[]string{
                "fork_owner_id",
                "fork_full_name",
                "fork_flag",
                "fork_parent",
                "fork_parent_id",
                "fork_id",
                "fork_push",
                "repo_id",
                "repo_full_name"
            } {
                flow.Reload()
                let before = flow.State[fault]?.DeepClone()
                var value string = "999"
                var message string = "identity changed"
                switch fault {
                    case "fork_owner_id" {
                        message = "numerically owned"
                    }
                    case "fork_full_name" {
                        value = "\"donor/other\""
                        message = "numerically owned"
                    }
                    case "fork_flag" {
                        value = "false"
                        message = "not a fork"
                    }
                    case "fork_parent" {
                        value = "\"owner/other\""
                        message = "not a fork"
                    }
                    case "fork_parent_id" {
                        message = "not a fork"
                    }
                    case "fork_push" {
                        value = "false"
                        message = "numerically owned"
                    }
                    case "repo_full_name" {
                        value = "\"owner/other\""
                    }
                    case "repo_id" {
                        message = repositoryError
                    }
                }
                flow.State[fault] = Check.Json(value)
                flow.Save()
                Check.Contains(flow.Call(args, 1).Error, message)
                Check.That(
                    File.ReadAllText(Path.Combine(run, "run.json")) == original,
                    "Fork refusal changed saved run"
                )
                flow.Reload()
                if before == nil {
                    flow.State.AsObject().Remove(fault)
                } else {
                    flow.State[fault] = before
                }
                flow.Save()
            }
        }
    }
}
