package TokateTests

import System
import System.Collections.Generic
import System.IO

internal class Temp : IDisposable {
    internal let Root string = Path.Combine(
        Environment.GetEnvironmentVariable("TOKATE_TEST_ROOT") ?? "/var/tmp",
        "tokate-e2e-" + Guid.NewGuid().ToString("N")
    )
    internal let Env Dictionary[string, string] = Dictionary[string, string]()

    internal init() {
        Directory.CreateDirectory(Root)
        Directory.CreateDirectory(Path.Combine(Root, "bin"))
        Directory.CreateDirectory(Path.Combine(Root, "home"))
        Env["PATH"] = Path.Combine(Root, "bin") + ":/usr/bin:/bin"
        Env["HOME"] = Path.Combine(Root, "home")
        Env["SHELL"] = "/bin/bash"
        Env["LANG"] = "C.UTF-8"
    }

    internal func Tool(name string) {
        let target = Path.Combine(Root, "bin", name)
        File.Copy(Environment.ProcessPath ?? throw Exception("Missing test executable"), target)
        File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
    }

    public func Dispose() -> Directory.Delete(Root, true)
}
