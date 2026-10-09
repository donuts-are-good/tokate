package TokateDesktop

import System
import System.Diagnostics

class Browser {
    shared {
        func Open(url string) {
            if Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.Host == "github.com" {
                Process.Start(ProcessStartInfo{FileName: "xdg-open", UseShellExecute: false, ArgumentList: {url}})
            }
        }
    }
}
