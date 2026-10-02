package TokateTests

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Text.Json.Nodes

internal class Fixture {
    internal let Root string
    internal let StatePath string
    internal let State JsonNode
    internal let Env Dictionary[string, string] = Dictionary[string, string]()

    internal init(root string) {
        Root = root
        StatePath = Path.Combine(root, "state.json")
        State = Check.Json(File.ReadAllText(StatePath))
        Env["PATH"] = root + ":/usr/bin:/bin"
        Env["HOME"] = Path.Combine(Path.GetDirectoryName(root) ?? "", "home")
        Env["GIT_CONFIG_NOSYSTEM"] = "1"
        for prefix in[]string{"GIT_AUTHOR_", "GIT_COMMITTER_"} {
            Env[prefix + "NAME"] = "Fixture"
            Env[prefix + "EMAIL"] = "fixture@example.test"
        }
    }

    internal func Save() -> File.WriteAllText(StatePath, State.ToJsonString())

    internal func Answer(value JsonNode) int32 {
        Save()
        Console.WriteLine(value.ToJsonString())
        return 0
    }

    internal func Git(repo string, args[]string, input string? = nil) string {
        let all = List[string]{"-C", Path.Combine(Root, repo)}
        all.AddRange(args)
        return Check.Success(Check.Run("/usr/bin/git", all.ToArray(), Env, input))
    }

    internal func Codex(args[]string) int32 {
        if args[0] == "--version" {
            Console.WriteLine("codex-cli 0.159.3")
            return 0
        }
        if args[0] == "login" {
            Check.That(args.Length == 2 && args[1] == "status", "Unexpected login operation")
            Console.WriteLine("Logged in using ChatGPT")
            return 0
        }
        if args[0] == "sandbox" {
            Check.That(Array.IndexOf(args, "permissions.tokate.network.enabled=false") >= 0, "Network must be disabled")
            if Array.IndexOf(args, "probe") >= 0 {
                return 0
            }
            if Array.IndexOf(args, "/usr/bin/env") >= 0 {
                let command = List[string](args).GetRange(
                    Array.IndexOf(args, "--") + 1,
                    args.Length - Array.IndexOf(args, "--") - 1
                )
                let exe = command[0]
                command.RemoveAt(0)
                let result = Check.Run(exe, command.ToArray(), Env, cwd: args[Array.IndexOf(args, "-C") + 1])
                Console.Write(result.Output)
                Console.Error.Write(result.Error)
                return result.Code
            }
            return 0
        }
        Check.That(args[0] == "exec", "Expected exec")
        Check.That(Environment.GetEnvironmentVariable("GH_TOKEN") == nil, "GitHub credential reached agent")
        Check.That(Environment.GetEnvironmentVariable("OPENAI_API_KEY") == nil, "API credential reached agent")
        for required in[]string{
            "--strict-config",
            "--ignore-user-config",
            "--ignore-rules",
            "approval_policy=\"never\""
        } {
            Check.That(Array.IndexOf(args, required) >= 0, "Missing boundary: " + required)
        }
        var filesystem bool
        for arg in args {
            if arg.Contains(":root") && arg.Contains("deny") && arg.Contains(".git") {
                filesystem = true
            }
        }
        Check.That(filesystem, "Missing filesystem boundary")
        Check.Contains(Console.In.ReadToEnd(), "Acceptance criteria addressed")
        let count = Check.Text(State["exec_count"])
        State["exec_count"] = JsonValue.Create(count == "" ? 1: Int32.Parse(count) + 1)
        Save()
        let mode = Check.Text(State["mode"])
        if mode == "temporary_isolation" {
            let sentinel = Check.Text(State["temporary_sentinel"])
            Check.That(!File.Exists(sentinel), "Host temporary file reached the managed namespace")
            File.WriteAllText(sentinel, "private agent temporary data")
        }
        if mode == "timeout" {
            using let child = Process.Start("/usr/bin/sleep", "120") ?? throw Exception("Cannot start timeout fixture")
            File.WriteAllText(Path.Combine(Root, "child.pid"), child.Id.ToString())
            child.WaitForExit()
        }
        if mode == "revoke" {
            let issue = State["issue"] ?? throw Exception("Missing issue")
            issue["labels"] = JsonArray()
            Save()
        }
        let checkout = args[Array.IndexOf(args, "--cd") + 1]
        if mode == "verification_fail" {
            File.WriteAllText(Path.Combine(checkout, "other.txt"), "False success")
        } else if mode != "empty" {
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Implemented acceptance criteria\n")
        }
        if mode == "workflow" {
            Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
            File.WriteAllText(Path.Combine(checkout, ".github/workflows/verify.yml"), "tampered")
        }
        File.WriteAllText(
            args[Array.IndexOf(args, "--output-last-message") + 1],
            "### Changes\nAdded result.\n### Acceptance criteria addressed\nFixture.\n### Verification\nFixture check passed.\n### Unresolved limitations\nNone.\n"
        )
        Console.WriteLine(
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"cached_input_tokens\":50,\"output_tokens\":10}}"
        )
        return 0
    }

    internal func GitHub(args[]string) int32 {
        if args[0] == "--version" {
            Console.WriteLine("gh version fixture")
            return 0
        }
        let actor = Environment.GetEnvironmentVariable("FIXTURE_ACTOR") ?? "donor"
        if args[0] == "pr" && args[1] == "checks" {
            return Answer(State["checks"] ?? JsonArray())
        }
        Check.That(args[0] == "api", "Expected GitHub API")
        let method = args[Array.IndexOf(args, "--method") + 1]
        let path = args[Array.IndexOf(args, "--method") + 2]
        let body = Array.IndexOf(args, "--input") >= 0 ? Check.Json(Console.In.ReadToEnd()): Check.Json("{}")
        if path == "user" {
            return Answer(Check.Map("login", actor, "id", 123))
        }
        let parts = path.Split('/')
        Check.That(parts[0] == "repos", "Expected repository API")
        let repo = parts[1] + "/" + parts[2]
        let folder = repo == "owner/project" ? "upstream": "fork"
        let tail = String.Join("/", parts, 3, parts.Length - 3)
        if tail == "" {
            if folder == "fork" && Check.Text(State["missing_fork"]) == "true" {
                throw Exception("HTTP 404")
            }
            return Answer(
                Check.Map(
                    "default_branch",
                    "main",
                    "permissions",
                    Check.Map("push", actor == parts[1]),
                    "parent",
                    Check.Map("full_name", "owner/project")
                )
            )
        }
        if tail.StartsWith("commits/") {
            return Answer(Check.Map("sha", Git(folder, []string{"rev-parse", tail.Substring(8)})))
        }
        if tail.StartsWith("contents/") {
            let split = tail.IndexOf("?ref=")
            let file = tail.Substring(9, split - 9)
            let reference = Uri.UnescapeDataString(tail.Substring(split + 5))
            let content = Git(folder, []string{"show", reference + ":" + file})
            return Answer(
                Check.Map("encoding", "base64", "content", Convert.ToBase64String(Encoding.UTF8.GetBytes(content)))
            )
        }
        if tail.StartsWith("issues/") {
            let issue = State["issue"] ?? throw Exception("Missing issue")
            if method != "GET" {
                if tail.EndsWith("/assignees") {
                    let people = issue["assignees"]?.AsArray() ?? JsonArray()
                    let requested = body["assignees"]?.AsArray() ?? JsonArray()
                    if method == "DELETE" {
                        var index = people.Count - 1
                        while index >= 0 {
                            for person in requested {
                                if Check.Text(people[index]?["login"]) == Check.Text(person) {
                                    people.RemoveAt(index)
                                    break
                                }
                            }
                            index--
                        }
                    } else if Check.Text(State["unassignable"]) != "true" {
                        for person in requested {
                            var found bool
                            for existing in people {
                                if Check.Text(existing["login"]) == Check.Text(person) {
                                    found = true
                                }
                            }
                            if !found {
                                people.Add(Check.Map("login", Check.Text(person)))
                            }
                        }
                    }
                } else if tail.EndsWith("/labels") {
                    let labels = JsonArray()
                    for label in body["labels"]?.AsArray() ?? JsonArray() {
                        labels.Add(Check.Map("name", Check.Text(label)))
                    }
                    issue["labels"] = labels
                } else if method == "DELETE" {
                    issue["labels"] = JsonArray()
                }
            }
            return Answer(issue)
        }
        if tail.StartsWith("labels") {
            return Answer(Check.Map("name", "tokate:approved"))
        }
        if tail.StartsWith("git/ref/heads/") {
            var sha string
            try {
                sha = Git(folder, []string{"rev-parse", "--verify", "refs/heads/" + tail.Substring(14)})
            } catch (error Exception) {
                throw Exception("HTTP 404")
            }
            return Answer(Check.Map("object", Check.Map("sha", sha)))
        }
        if tail.StartsWith("git/commits/") {
            return Answer(
                Check.Map("tree", Check.Map("sha", Git(folder, []string{"rev-parse", tail.Substring(12) + "^{tree}"})))
            )
        }
        if tail == "git/trees" {
            Env["GIT_INDEX_FILE"] = Path.Combine(Root, "tree.index")
            Git(folder, []string{"read-tree", Check.Text(body["base_tree"])})
            for item in body["tree"]?.AsArray() ?? JsonArray() {
                let sha = Git(folder, []string{"hash-object", "-w", "--stdin"}, Check.Text(item["content"]))
                Git(
                    folder,
                    []string{"update-index", "--add", "--cacheinfo", "100644," + sha + "," + Check.Text(item["path"])}
                )
            }
            return Answer(Check.Map("sha", Git(folder, []string{"write-tree"})))
        }
        if tail == "git/commits" {
            let command = List[string]{"commit-tree", Check.Text(body["tree"])}
            for parent in body["parents"]?.AsArray() ?? JsonArray() {
                command.Add("-p")
                command.Add(Check.Text(parent))
            }
            return Answer(Check.Map("sha", Git(folder, command.ToArray(), Check.Text(body["message"]))))
        }
        if tail == "git/refs" {
            try {
                Git(folder, []string{"update-ref", Check.Text(body["ref"]), Check.Text(body["sha"]), String('0', 40)})
            } catch (error Exception) {
                throw Exception("Reference already exists")
            }
            return Answer(Check.Map("ref", Check.Text(body["ref"])))
        }
        if tail.StartsWith("git/refs/heads/") {
            Git(folder, []string{"update-ref", "refs/heads/" + tail.Substring(15), Check.Text(body["sha"])})
            return Answer(Check.Json("{}"))
        }
        if tail.StartsWith("pulls?") {
            return Answer(State["pulls"] ?? JsonArray())
        }
        if tail.StartsWith("pulls/") {
            return Answer(State["pulls"]?[0] ?? throw Exception("Missing PR"))
        }
        if tail == "pulls" {
            let branch = Check.Text(body["head"]).Split(':')[1]
            body["number"] = JsonValue.Create(10)
            body["html_url"] = JsonValue.Create("https://github.com/owner/project/pull/10")
            body["state"] = JsonValue.Create("open")
            body["user"] = Check.Map("login", actor)
            body["head"] = Check.Map(
                "sha",
                Git("fork", []string{"rev-parse", branch}),
                "ref",
                branch,
                "repo",
                Check.Map("owner", Check.Map("login", "donor"))
            )
            body["base"] = Check.Map("ref", Check.Text(body["base"]))
            let pulls = JsonArray()
            pulls.Add(body)
            State["pulls"] = pulls
            return Answer(body)
        }
        throw Exception("Unhandled fixture API: " + path)
    }

    internal func Run(name string, args[]string) int32 {
        if name.StartsWith("codex") {
            return Codex(args)
        }
        if name == "git" {
            let command = List[string]()
            for arg in args {
                if arg == "https://github.com/owner/project.git" {
                    command.Add(Path.Combine(Root, "upstream"))
                } else if arg == "https://github.com/donor/project.git" {
                    command.Add(Path.Combine(Root, "fork"))
                } else {
                    command.Add(arg == "protocol.file.allow=never" ? "protocol.file.allow=always": arg)
                }
            }
            let result = Check.Run("/usr/bin/git", command.ToArray(), Env)
            Console.Write(result.Output)
            Console.Error.Write(result.Error)
            return result.Code
        }
        return GitHub(args)
    }
}
