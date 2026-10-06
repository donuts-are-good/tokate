package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Json

internal class Data {
    internal let Fields Dictionary[string, Object?] = Dictionary[string, Object?]()
    internal func Text(key string) string -> J.Text(Field(key), key)

    internal func Number(key string) int32 -> J.Number(Field(key), key)

    internal func Flag(key string) bool -> J.Bool(Field(key), key)

    private func Field(key string) JsonElement {
        var value Object?
        return Fields.TryGetValue(key, out value) ? J.Parse(J.Write(J.Map(key, value))): JsonElement{}
    }

    internal func Element() JsonElement -> J.Parse(J.Write(Fields))

    internal func Save(directory string) {
        Preparation.ControlPaths(directory)
        Write(Path.Combine(directory, "run.json"))
    }

    internal func Write(path string) {
        File.WriteAllText(path + ".tmp", J.Write(Fields) + "\n")
        File.Move(path + ".tmp", path, true)
    }
    shared {
        internal func Load(directory string) Data {
            Preparation.ControlPaths(directory)
            return Read(Path.Combine(directory, "run.json"))
        }

        internal func Read(path string) Data {
            let result = Data()
            for field in J.Parse(File.ReadAllText(path)).EnumerateObject() {
                result.Fields[field.Name] = field.Value.Clone()
            }
            return result
        }

        internal func Hash(text string) string -> Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))
            .ToLowerInvariant()
    }
}
