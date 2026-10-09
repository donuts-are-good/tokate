package TokateDesktop

import Goo
import System
import System.IO
import System.Runtime.InteropServices

func StopOnSignal(window Window, signal PosixSignal) PosixSignalRegistration ->
PosixSignalRegistration.Create(
    signal,
    context -> {
        context.Cancel = true
        CommandRunner.Shutdown()
        window.TryPost(
            () -> {
                window.OnClosing = nil
                window.RequestClose()
            }
        )
    }
)

func Main() {
    Window.ConfigureApplication("Tokate", "0.2.102", "dev.tokate.desktop")
    using let body = FontSource("Newsreader", 400, false, File.ReadAllBytes(Asset("newsreader.ttf")))
    using let heading = FontSource("Cormorant", 500, false, File.ReadAllBytes(Asset("cormorant.ttf")))
    using let italic = FontSource("Cormorant", 500, true, File.ReadAllBytes(Asset("cormorant-italic.ttf")))
    body.Register()
    heading.Register()
    italic.Register()
    using let art = Artwork()
    let root = Desktop(art)
    let window = Window{
        Title: "Tokate",
        Width: 1280,
        Height: 860,
        MinWidth: 480,
        MinHeight: 270,
        Decorated: false,
        Resizable: true,
        ResizeBand: 6.0F,
        Root: root,
        Background: Color.Parse("#F3E7D4"),
    }
    root.Attach(window)
    try {
        window.Open()
        using let terminate PosixSignalRegistration? = OperatingSystem.IsLinux() ? StopOnSignal(
            window,
            PosixSignal.SIGTERM
        ): nil
        using let hangup PosixSignalRegistration? = OperatingSystem.IsLinux() ? StopOnSignal(
            window,
            PosixSignal.SIGHUP
        ): nil
        using let interrupt PosixSignalRegistration? = OperatingSystem.IsLinux() ? StopOnSignal(
            window,
            PosixSignal.SIGINT
        ): nil
        window.Run()
    } finally {
        CommandRunner.Shutdown()
    }
}
