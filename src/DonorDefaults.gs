package Tokate

import System
import System.IO
import System.Text.Json

internal class DonorDefaults {
    shared {
        internal func Location() string {
            let path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".local",
                "state",
                "tokate",
                "donor-defaults.json"
            )
            var current = path
            while current != "" {
                if FileInfo(current).LinkTarget != nil {
                    throw Exception("Tokate donor defaults must not use symbolic links")
                }
                current = Path.GetDirectoryName(current) ?? ""
            }
            return path
        }

        internal func Read() JsonElement {
            let path = Location()
            if !File.Exists(path) {
                return JsonElement{}
            }
            let value = RequestData.FileData(path, 1024)
            RequestData.Keys(value, "harness,provider,model,effort")
            for key in[]string{"harness", "provider", "model", "effort"} {
                RequestData.Token(J.Text(value, key))
            }
            return value
        }

        internal func Run(args Args) JsonElement {
            if args.Subject == "read" {
                let saved = Read()
                return J.Parse(J.Write(J.Map("default", saved.ValueKind == JsonValueKind.Undefined ? nil: saved)))
            }
            let path = Location()
            if args.Subject == "remove" {
                let existed = File.Exists(path)
                File.Delete(path)
                return J.Parse(J.Write(J.Map("removed", existed)))
            }
            let choice = J.Map()
            for key in[]string{"harness", "provider", "model", "effort"} {
                choice[key] = RequestData.Token(args.Need(key))
            }
            Directory.CreateDirectory(
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
                    writer.WriteLine(J.Write(choice))
                }
                File.Move(temporary, path, true)
            } finally {
                File.Delete(temporary)
            }
            return J.Parse(J.Write(J.Map("default", choice)))
        }
    }
}
