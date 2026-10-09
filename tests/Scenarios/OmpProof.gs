package TokateTests

import System
import System.Text.Json.Nodes

internal class OmpProof {
    shared {
        internal func Boundary(checkout string, root string, runtime string, control string) {
            let result = JsonArray()
            let args = Tokate.SdkBoundary.Args(checkout, root, runtime, control, false)
            args.InsertRange(args.Count - 1, []string{"--setenv", "PI_CONFIG_DIR", "/tmp/tokate-agent"})
            for arg in args {
                result.Add(JsonValue.Create(arg) as JsonNode)
            }
            Console.WriteLine(result.ToJsonString())
        }
    }
}
