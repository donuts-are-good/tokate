package TokateTests

import System
import System.IO
import System.Runtime.InteropServices
import System.Text.Json.Nodes

internal class ReleaseTools {
    shared {
        internal func Runtime() string -> RuntimeInformation.RuntimeIdentifier.StartsWith("linux-musl") ?
        "linux-musl-x64": "linux-x64"

        internal func ShellFixture(name string, args[]string, root string) int32 {
            if name == "id" {
                Check.That(args.Length == 1 && args[0] == "-u", "Unexpected account identity lookup")
                Console.WriteLine("12345")
                return 0
            }
            Check.That(
                args.Length == 2 && args[0] == "passwd" && args[1] == "12345",
                "Shell detection must query only the current account"
            )
            File.AppendAllText(Path.Combine(root, "shell-lookups"), "lookup\n")
            let shell = File.ReadAllText(Path.Combine(root, "account-shell"))
            if shell == "" {
                return 2
            }
            Console.WriteLine("fixture:x:12345:12345::/unused:" + (shell == "empty" ? "": shell))
            return 0
        }

        internal func PlatformFixture(name string, args[]string, root string) int32 {
            let state = Check.Json(File.ReadAllText(Path.Combine(root, "platform.json")))
            if name == "uname" {
                Check.That(args.Length == 1 && (args[0] == "-s" || args[0] == "-m"), "Unexpected uname arguments")
                Console.WriteLine(Check.Text(state[args[0] == "-s" ? "os": "arch"]))
                return 0
            }
            Check.That(args.Length == 1 && args[0] == "GNU_LIBC_VERSION", "Unexpected getconf arguments")
            let libc = Check.Text(state["libc"])
            if libc == "" {
                return 1
            }
            Console.WriteLine(libc)
            return 0
        }

        internal func Fixture(args[]string, root string) int32 {
            if args.Length == 1 && args[0] == "--version" {
                Console.WriteLine("curl fixture")
                return 0
            }
            let statePath = Path.Combine(root, "state.json")
            let state = Check.Json(File.ReadAllText(statePath))
            if Check.Text(state["coordinator_download"]) == "true" {
                return ReleaseDownload(args, root, state)
            }
            Check.That(args[0] == "-q", "curl must ignore user configuration")
            Check.That(Array.IndexOf(args, "--proto") >= 0 && Array.IndexOf(args, "=https") >= 0, "HTTPS required")
            if Check.Text(state["clean"]) == "true" {
                Check.That(Environment.GetEnvironmentVariable("GH_TOKEN") == nil, "GitHub credential inherited")
                Check.That(Environment.GetEnvironmentVariable("OPENAI_API_KEY") == nil, "API credential inherited")
            }
            if Check.Text(state["mode"]) == "download-fail" {
                return 22
            }
            let url = args[args.Length - 1]
            let tag = Check.Text(state["tag"])
            if url.EndsWith("/latest") {
                Console.Write("https://github.com/obselate/tokate/releases/tag/" + tag)
                return 0
            }
            let output = args[Array.IndexOf(args, "--output") + 1]
            let archive = Path.Combine(root, "release.tar.gz")
            if url.EndsWith(".sha256") {
                let hash = Check.Text(state["mode"]) == "checksum-fail" ? String('0', 64): Check.Hash(archive)
                File.WriteAllText(output, hash + "  tokate-" + tag.Substring(1) + "-" + Runtime() + ".tar.gz\n")
            } else {
                Check.That(
                    url == "https://github.com/obselate/tokate/releases/download/" + tag + "/tokate-" + tag.Substring(
                        1
                    ) +
                        "-" +
                        Runtime() +
                        ".tar.gz",
                    "Unexpected release URL"
                )
                File.Copy(archive, output, true)
            }
            return 0
        }

        internal func ReleaseDownload(args[]string, root string, state JsonNode) int32 {
            Check.That(
                Environment.GetEnvironmentVariable("GH_TOKEN") == nil && Environment.GetEnvironmentVariable(
                    "GITHUB_TOKEN"
                ) == nil,
                "Coordination credentials reached release download"
            )
            let url = args[args.Length - 1]
            let output = args[Array.IndexOf(args, "--output") + 1]
            if url.EndsWith("/41") {
                File.Copy(Path.Combine(root, "release.tar.gz"), output)
            } else {
                Check.That(url.EndsWith("/42"), "Unexpected immutable release asset URL")
                File.WriteAllText(
                    output,
                    Check.Hash(Path.Combine(root, "release.tar.gz")) + "  tokate-" + Check.Text(
                        state["release_version"]
                    ) +
                        "-linux-x64.tar.gz\n"
                )
            }
            return 0
        }
    }
}
