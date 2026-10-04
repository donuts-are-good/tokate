package Tokate

import System

internal class CliFailure : Exception {
    internal let Code string
    internal let Action[]string
    internal let Summary string
    internal init(code string, message string, action[]string = nil, summary string = "") : base(message) {
        Code = code
        Action = action ?? []string{}
        Summary = summary == "" ? message: summary
    }
}
