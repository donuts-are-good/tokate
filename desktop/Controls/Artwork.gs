package TokateDesktop

import Goo
import Goo.Svg
import System
import System.IO

class Artwork : IDisposable {
    let Backdrop ImageSource = ImageSource.Decode(File.ReadAllBytes(Asset("backdrop.png")))
    let Hands ImageSource = ImageSource.Decode(File.ReadAllBytes(Asset("hands-smooth.png")))
    let Sun ImageSource = ImageSource.Decode(File.ReadAllBytes(Asset("sun.png")))
    let Moon ImageSource = ImageSource.Decode(File.ReadAllBytes(Asset("moon.png")))
    let Stone ImageSource = ImageSource.Decode(File.ReadAllBytes(Asset("stone-olive.png")))
    private var donate Landscape?
    private var project Landscape?
    private var saved Landscape?
    prop Donate Landscape {
        get {
            let image = donate ?? Landscape("donate")
            donate = image
            return image
        }
    }
    prop Project Landscape {
        get {
            let image = project ?? Landscape("my-project")
            project = image
            return image
        }
    }
    prop Saved Landscape {
        get {
            let image = saved ?? Landscape("saved-work")
            saved = image
            return image
        }
    }
    let Mark VectorAsset = Svg.Load(Asset("wordmark-sprig.svg"))
    let Program ShaderEffectProgram = ShaderEffectProgram.Load(
        Path.Combine(AppContext.BaseDirectory, "Shaders/fresco.goo-effect")
    )
    let Effect ShaderEffect
    let LandscapeEffect ShaderEffect

    init() {
        Effect = ShaderEffect(Program)
        LandscapeEffect = ShaderEffect(Program)
    }

    func Dispose() {
        Backdrop.Dispose()
        Hands.Dispose()
        Sun.Dispose()
        Moon.Dispose()
        Stone.Dispose()
        donate?.Dispose()
        project?.Dispose()
        saved?.Dispose()
    }
}

class Landscape : IDisposable {
    let Daylight ImageSource
    let Moonlight ImageSource

    init(name string) {
        Daylight = ImageSource.Decode(File.ReadAllBytes(Asset(name + "-daylight.png")))
        Moonlight = ImageSource.Decode(File.ReadAllBytes(Asset(name + "-moonlight.png")))
    }

    func Dispose() {
        Daylight.Dispose()
        Moonlight.Dispose()
    }
}

func Asset(name string) string -> Path.Combine(AppContext.BaseDirectory, "Assets", name)
