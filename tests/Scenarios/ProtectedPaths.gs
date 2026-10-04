package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import Tokate

internal class ProtectedPathChecks {
    shared {
        private func Git(temp Temp, checkout string, args ...string) string {
            let all = List[string]{"-C", checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"}
            all.AddRange(args)
            return Check.Success(Check.Run("/usr/bin/git", all.ToArray(), temp.Env))
        }

        private func Refused(checkout string, policy JsonElement, base string, head string = "") {
            var refused bool
            try {
                ProtectedPaths.Local(checkout, policy, JsonElement(), base, head)
            } catch (error Exception) {
                Check.Contains(error.Message, "protected owner")
                refused = true
            }
            Check.That(refused, "Protected raw Git path was accepted")
        }

        internal func All() {
            for path in[]string{" protected", "\uFEFFprotected", "scripts/quoted\" ", "scripts/checks/line\n\".sh"} {
                using let temp = Temp()
                let checkout = Path.Combine(temp.Root, "checkout")
                let file = Path.Combine(checkout, path)
                Directory.CreateDirectory(Path.GetDirectoryName(file) ?? checkout)
                File.WriteAllText(file, "original\n")
                Git(temp, checkout, "init", "--quiet", "--template=")
                Git(temp, checkout, "add", "-A")
                Git(temp, checkout, "commit", "--quiet", "-m", "Base")
                let base = Git(temp, checkout, "rev-parse", "HEAD")
                let policy = J.Parse(
                    J.Write(J.Map("protected_paths", []string{path.Contains('\n') ? "scripts/checks/": path}))
                )
                File.AppendAllText(file, "changed\n")
                Git(temp, checkout, "add", "-A")
                Refused(checkout, policy, base)
                Git(temp, checkout, "commit", "--quiet", "-m", "Changed")
                Refused(checkout, policy, base, Git(temp, checkout, "rev-parse", "HEAD"))
            }
            Console.WriteLine("PASS staged and committed protected whitespace, BOM, quoted and newline Git names")
        }
    }
}
