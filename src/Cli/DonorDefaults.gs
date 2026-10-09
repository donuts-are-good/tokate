package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class DonorDefaults {
    shared {
        internal let Harnesses[]string = []string{"codex", "pi", "claude", "omp", "hermes"}

        internal func NormalizePair(args Args) {
            if args.Command == "defaults" && args.Subject == "set" && args.Get("harness") == "" && args.Get(
                "provider"
            ) == "" {
                var saved = Read(args.Get("profile"), allowMissing: true)
                if saved.ValueKind == JsonValueKind.Undefined && args.Get("profile") != "" {
                    saved = Read()
                }
                for key in[]string{"harness", "provider", "endpoint", "pi-root", "node", "harness-path"} {
                    if args.Get(key) == "" && J.Text(saved, key) != "" {
                        args.Values["--" + key] = J.Text(saved, key)
                    }
                }
            }
            if args.Get("harness") == "" && args.Get("provider") == "" {
                args.Values["--harness"] = "codex"
            }
            for pair in[][]string{[]string{"codex", "openai"}, []string{"pi", "local-chat-completions"}} {
                if args.Get("harness") == pair[0] && args.Get("provider") == "" {
                    args.Values["--provider"] = pair[1]
                } else if args.Get("harness") == "" && args.Get("provider") == pair[1] {
                    args.Values["--harness"] = pair[0]
                }
            }
        }

        internal func Name(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z") {
                throw Exception("Invalid profile name: use 1 to 64 letters, digits, dots, underscores or hyphens")
            }
            return value
        }

        internal func Location(profile string = "", storage string = "") string {
            let directory = storage == "" ? LocalPaths.StateDirectory(): storage
            let path = profile == "" ? Path.Combine(directory, "donor-defaults.json"):
            Path.Combine(directory, "donor-profiles", Name(profile) + ".json")
            var current = path
            while current != "" {
                if FileInfo(current).LinkTarget != nil {
                    throw Exception("Tokate donor defaults must not use symbolic links")
                }
                current = Path.GetDirectoryName(current) ?? ""
            }
            return path
        }

        internal func Read(profile string = "", allowMissing bool = false) JsonElement {
            var value JsonElement
            for directory in LocalPaths.StateDirectories() {
                let path = Location(profile, directory)
                if File.Exists(path) {
                    value = RequestData.FileData(path, 16 * 1024)
                    break
                }
            }
            if value.ValueKind == JsonValueKind.Undefined {
                if profile != "" && !allowMissing {
                    throw Exception(
                        "Named donor profile is missing; use defaults set --profile NAME. No inference started."
                    )
                }
                return JsonElement{}
            }
            RequestData.Keys(value, "harness,provider,model,effort,endpoint,pi-root,node,harness-path")
            for field in value.EnumerateObject() {
                if field.Value.ValueKind != JsonValueKind.String {
                    throw Exception("Donor profile fields must be strings")
                }
            }
            let partial = J.Get(value, "model").ValueKind == JsonValueKind.Undefined && J.Get(value, "effort")
                .ValueKind == JsonValueKind.Undefined
            RequestData.Token(J.Text(value, "harness"))
            if !partial {
                RequestData.Token(J.Text(value, "provider"))
            }
            if partial {
                if Array.IndexOf(Harnesses, J.Text(value, "harness")) < 0 ||
                    Provider(J.Text(value, "harness")) != J.Text(value, "provider") {
                    throw Exception("Unsupported harness default")
                }
                if J.Text(value, "harness-path") != "" {
                    LocalPaths.RuntimePath(J.Text(value, "harness-path"))
                }
                if J.Text(value, "harness") == "pi" {
                    if J.Text(value, "endpoint") != "" {
                        PiBoundary.Endpoint(J.Text(value, "endpoint"))
                    }
                    for key in[]string{"pi-root", "node"} {
                        if J.Text(value, key) != "" {
                            LocalPaths.RuntimePath(J.Text(value, key))
                        }
                    }
                } else {
                    RequestData.Keys(value, "harness,provider,harness-path")
                }
                return value
            }
            RequestData.Token(J.Text(value, "effort"))
            if J.Text(value, "harness") == "pi" {
                if J.Text(value, "provider") != "local-chat-completions" {
                    throw Exception("Pi profiles require local-chat-completions")
                }
                RequestData.ModelIdentifier(J.Text(value, "model"))
                PiBoundary.Endpoint(J.Text(value, "endpoint"))
                for key in[]string{"pi-root", "node"} {
                    if J.Get(value, key).ValueKind != JsonValueKind.Undefined {
                        LocalPaths.RuntimePath(J.Text(value, key))
                    }
                }
            } else {
                RequestData.Token(J.Text(value, "model"))
                RequestData.Keys(value, "harness,provider,model,effort,harness-path")
            }
            if J.Text(value, "harness-path") != "" {
                LocalPaths.RuntimePath(J.Text(value, "harness-path"))
            }
            return value
        }

        internal func Provider(harness string) string -> switch harness {
            case "codex": "openai"
            case "pi": "local-chat-completions"
            default: ""
        }

        private func Write(value JsonElement, profile string = "") {
            let path = Location(profile)
            Directory.CreateDirectory(
                Path.GetDirectoryName(path) ?? "",
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            File.SetUnixFileMode(
                Path.GetDirectoryName(path) ?? "",
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            let temporary = path + "." + Guid.NewGuid().ToString("N")
            try {
                {
                    using let file = FileStream(
                        temporary,
                        FileStreamOptions{
                            Mode: FileMode.CreateNew,
                            Access: FileAccess.Write,
                            Share: FileShare.None,
                            UnixCreateMode: UnixFileMode.UserRead | UnixFileMode.UserWrite
                        }
                    )
                    using let writer = StreamWriter(file)
                    writer.Write(J.Write(value))
                }
                File.Move(temporary, path, true)
            } finally {
                File.Delete(temporary)
            }
        }

        private func Summary(value JsonElement) Object? -> value.ValueKind == JsonValueKind.Undefined ? nil:
        J.Select(value, "harness,provider,model,effort")

        internal func Run(args Args) JsonElement {
            let profile = args.Get("profile")
            if args.Subject == "list" {
                let profiles = SortedDictionary[string, Object?](StringComparer.Ordinal)
                var scanned int32
                for storage in LocalPaths.StateDirectories() {
                    let directory = Path.GetDirectoryName(Location("list", storage)) ?? ""
                    if Directory.Exists(directory) {
                        for path in Directory.EnumerateFiles(directory, "*.json") {
                            scanned++
                            if scanned > 128 {
                                throw Exception("Donor profile list exceeds 128 entries")
                            }
                            let name = Name(Path.GetFileNameWithoutExtension(path))
                            if !profiles.ContainsKey(name) {
                                profiles.Add(name, Summary(Read(name)))
                            }
                        }
                    }
                }
                return J.Parse(
                    J.Write(
                        map[string, Object?]{
                            "default": Summary(Read()),
                            "profiles": Dictionary[string, Object?](profiles)
                        }
                    )
                )
            }
            if args.Subject == "read" {
                return J.Parse(J.Write(map[string, Object?]{"profile": profile, "default": Summary(Read(profile))}))
            }
            if args.Subject == "remove" {
                let paths = List[string]()
                for storage in LocalPaths.StateDirectories() {
                    paths.Add(Location(profile, storage))
                }
                var existed bool
                for candidate in paths {
                    existed = existed || File.Exists(candidate)
                    File.Delete(candidate)
                }
                return J.Parse(J.Write(map[string, Object?]{"profile": profile, "removed": existed}))
            }
            if args.Subject == "use" {
                let selected = Read(args.Need("profile"))
                Write(selected)
                return J.Parse(J.Write(map[string, Object?]{"profile": profile, "default": Summary(selected)}))
            }
            if args.Get("model") == "" && args.Get("effort") == "" {
                let harness = args.Need("harness")
                let provider = Provider(harness)
                if Array.IndexOf(Harnesses, harness) < 0 ||
                    (args.Get("provider") != "" && args.Get("provider") != provider) {
                    throw Exception("Unsupported harness default")
                }
                let previous = Read(profile, allowMissing: true)
                let choice = J.Text(previous, "harness") == harness && J.Text(previous, "provider") == provider ?
                J.Select(previous, "harness,provider,model,effort,endpoint,pi-root,node,harness-path"):
                map[string, Object?]{"harness": harness}
                if provider != "" {
                    choice["provider"] = provider
                }
                for key in[]string{"harness-path", "pi-root", "node", "endpoint"} {
                    if args.Get(key) != "" {
                        choice[key] = key == "endpoint" ? PiBoundary.Endpoint(args.Get(key)):
                        LocalPaths.RuntimePath(args.Get(key))
                    }
                }
                let selected = RequestData.Parse(J.Write(choice), 16 * 1024)
                Write(selected, profile)
                return J.Parse(J.Write(map[string, Object?]{"profile": profile, "default": Summary(selected)}))
            }
            let choice = map[string, Object?]{}
            for key in[]string{"harness", "provider", "model", "effort"} {
                choice[key] = key == "model" && args.Get("harness") == "pi" ?
                RequestData.ModelIdentifier(args.Need(key)): RequestData.Token(args.Need(key))
            }
            if args.Get("harness") == "pi" {
                if args.Get("provider") != "local-chat-completions" {
                    throw Exception("Pi profiles require local-chat-completions")
                }
                choice["endpoint"] = PiBoundary.Endpoint(args.Need("endpoint"))
                for key in[]string{"pi-root", "node"} {
                    if args.Get(key) != "" {
                        choice[key] = LocalPaths.RuntimePath(args.Get(key))
                    }
                }
            }
            if args.Get("harness-path") != "" {
                choice["harness-path"] = LocalPaths.RuntimePath(args.Need("harness-path"))
            }
            let value = RequestData.Parse(J.Write(choice), 16 * 1024)
            Write(value, profile)
            return J.Parse(J.Write(map[string, Object?]{"profile": profile, "default": Summary(value)}))
        }
    }
}
