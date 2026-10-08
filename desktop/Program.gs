package TokateDesktop

import Goo
import System
import System.IO

func Main() {
    Window.ConfigureApplication("Tokate", "0.2.101", "dev.tokate.desktop")
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
        MinWidth: 800,
        MinHeight: 600,
        Decorated: false,
        Resizable: true,
        ResizeBand: 6.0F,
        Root: root,
        Background: Color.Parse("#F3E7D4"),
    }
    root.Attach(window)
    window.Run()
}
