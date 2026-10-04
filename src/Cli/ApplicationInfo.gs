package Tokate

import System
import System.IO
import System.Reflection

internal class ApplicationInfo {
    shared {
        internal func Version() string -> Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "unknown"

        internal func Resource(name string) string {
            using let stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Tokate.templates." + name) ??
                throw Exception("Missing embedded template " + name)
            using let reader = StreamReader(stream)
            return reader.ReadToEnd()
        }
    }
}
