package TokateTests

import System
import System.Security.Cryptography
import System.Text

internal class CiShard {
    shared {
        internal func Spec() string {
            let value = Environment.GetEnvironmentVariable("TOKATE_CI_SHARD") ?? ""
            if value == "" {
                return ""
            }
            let parts = value.Split('/')
            if parts.Length != 2 {
                throw Exception("Invalid CI shard")
            }
            let index = Int32.Parse(parts[0])
            let count = Int32.Parse(parts[1])
            if index < 0 || count < 1 || index >= count || count > 64 {
                throw Exception("Invalid CI shard")
            }
            return index.ToString() + "/" + count.ToString()
        }

        internal func Include(name string) bool {
            let spec = Spec()
            if spec == "" {
                return true
            }
            let parts = spec.Split('/')
            let index = UInt32.Parse(parts[0])
            let count = UInt32.Parse(parts[1])
            let digest = SHA256.HashData(Encoding.UTF8.GetBytes(name))
            return BitConverter.ToUInt32(digest, 0) % count == index
        }
    }
}
