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
    internal let Root string
    internal let StatePath string
    internal var State JsonNode
    internal let Env Dictionary[string, string] = Dictionary[string, string]()
    internal var Include bool
    internal var Verb string = ""
    internal var Conditional string = ""
    internal var ApiPath string = ""

    internal init(root string) {
        Root = root
        StatePath = Path.Combine(root, "state.json")
        State = JsonObject()
        Env["PATH"] = root + ":/usr/bin:/bin"
        Env["HOME"] = Path.Combine(Path.GetDirectoryName(root) ?? "", "home")
        Env["GIT_CONFIG_NOSYSTEM"] = "1"
        for prefix in[]string{"GIT_AUTHOR_", "GIT_COMMITTER_"} {
            Env[prefix + "NAME"] = "Fixture"
            Env[prefix + "EMAIL"] = "fixture@example.test"
        }
    }

    internal func Save() -> File.WriteAllText(StatePath, State.ToJsonString())
}
