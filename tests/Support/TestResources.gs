package TokateTests

import System
import System.IO
import System.Reflection

internal class TestResources {
    shared {
        internal func Template(name string) string {
            using let stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(
                "TokateTests.templates." + name
            )
            if stream == nil {
                throw Exception("Missing fixture template")
            }
            using let reader = StreamReader(stream)
            return reader.ReadToEnd()
        }
    }
}
