package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Json.Nodes

internal partial class Fixture {
    internal func Run(name string, args[]string) int32 {
        if name != "gh" {
            State = Check.Json(File.ReadAllText(StatePath))
        }
        for key in[]string{
            "OPENAI_API_KEY",
            "UNRELATED_DONOR_VALUE",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0"
        } {
            Check.That(
                Environment.GetEnvironmentVariable(key) == nil,
                "Unrelated host value reached " + name + ": " + key
            )
        }
        if name.StartsWith("codex") {
            return Codex(args)
        }
        if name == "git" {
            return RunGit(args)
        }
        return GitHub(args)
    }
}
