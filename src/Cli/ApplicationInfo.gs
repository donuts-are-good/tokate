package Tokate

import System
import System.IO
import System.Reflection

internal class ApplicationInfo {
    shared {
        internal func Version() string -> Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "unknown"

        internal func Resource(name string) string {
            let assembly = Assembly.GetExecutingAssembly()
            using let stream = assembly.GetManifestResourceStream("Tokate.templates." + name)
            if stream == nil {
                throw Exception("Missing embedded template " + name)
            }
            using let reader = StreamReader(stream)
            return reader.ReadToEnd()
        }
    }
}
