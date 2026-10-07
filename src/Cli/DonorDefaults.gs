package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class DonorDefaults {
    shared {
        internal func Name(value string) string {
            if !Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z") {
                throw Exception("Invalid profile name: use 1 to 64 letters, digits, dots, underscores or hyphens")
            }
            return value
        }

        internal func Location(profile string = "") string {
            let directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".local",
                "state",
                "tokate"
            )
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

        internal func Read(profile string = "") JsonElement {
            let path = Location(profile)
            if !File.Exists(path) {
                if profile != "" {
                    throw Exception(
                        "Named donor profile is missing; use defaults set --profile NAME. No inference started."
                    )
                }
                return JsonElement{}
            }
            let value = RequestData.FileData(path, 16 * 1024)
            RequestData.Keys(value, "harness,provider,model,effort,endpoint,pi-root,node")
            for field in value.EnumerateObject() {
                if field.Value.ValueKind != JsonValueKind.String {
                    throw Exception("Donor profile fields must be strings")
                }
            }
            for key in[]string{"harness", "provider", "effort"} {
                RequestData.Token(J.Text(value, key))
            }
            if J.Text(value, "harness") == "pi" {
                if J.Text(value, "provider") != "local-chat-completions" || J.Text(value, "effort") != "absent" {
                    throw Exception("Pi profiles require local-chat-completions and absent effort")
                }
                RequestData.ModelIdentifier(J.Text(value, "model"))
                PiBoundary.Endpoint(J.Text(value, "endpoint"))
                for key in[]string{"pi-root", "node"} {
                    if J.Get(value, key).ValueKind != JsonValueKind.Undefined {
                        RuntimePath(J.Text(value, key))
                    }
                }
            } else {
                RequestData.Token(J.Text(value, "model"))
                RequestData.Keys(value, "harness,provider,model,effort")
            }
            return value
        }

        private func RuntimePath(value string) string {
            if value.Length > 4096 || !Path.IsPathFullyQualified(value) {
                throw Exception("Profile runtime overrides require bounded absolute paths")
            }
            for character in value {
                if Char.IsControl(character) {
                    throw Exception("Invalid profile runtime path")
                }
            }
            return Path.GetFullPath(value)
        }

        private func Summary(value JsonElement) Object? -> value.ValueKind == JsonValueKind.Undefined ? nil:
        PublicOutput.Select(value, "harness,provider,model,effort")

        internal func Run(args Args) JsonElement {
            let profile = args.Get("profile")
            if args.Subject == "list" {
                let profiles = SortedDictionary[string, Object?](StringComparer.Ordinal)
                let directory = Path.GetDirectoryName(Location("list")) ?? ""
                if Directory.Exists(directory) {
                    for path in Directory.EnumerateFiles(directory, "*.json") {
                        if profiles.Count >= 128 {
                            throw Exception("Donor profile list exceeds 128 entries")
                        }
                        let name = Name(Path.GetFileNameWithoutExtension(path))
                        profiles.Add(name, Summary(Read(name)))
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
            let path = Location(profile)
            if args.Subject == "remove" {
                let existed = File.Exists(path)
                File.Delete(path)
                return J.Parse(J.Write(map[string, Object?]{"profile": profile, "removed": existed}))
            }
            let choice = map[string, Object?]{}
            for key in[]string{"harness", "provider", "model", "effort"} {
                choice[key] = key == "model" && args.Get("harness") == "pi" ?
                RequestData.ModelIdentifier(args.Need(key)): RequestData.Token(args.Need(key))
            }
            if args.Get("harness") == "pi" {
                if args.Get("provider") != "local-chat-completions" || args.Get("effort") != "absent" {
                    throw Exception("Pi profiles require local-chat-completions and absent effort")
                }
                choice["endpoint"] = PiBoundary.Endpoint(args.Need("endpoint"))
                for key in[]string{"pi-root", "node"} {
                    if args.Get(key) != "" {
                        choice[key] = RuntimePath(args.Get(key))
                    }
                }
            }
            let value = RequestData.Parse(J.Write(choice), 16 * 1024)
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
            return J.Parse(J.Write(map[string, Object?]{"profile": profile, "default": Summary(value)}))
        }
    }
}
