package TokateDesktop

import Goo
import System

data struct FrescoInput {
    var Art Artwork
    var Night float64
    var Height float64
    var Background bool
}

open class Fresco : Cell[FrescoInput] {
    private let viewport ElementHandle = ElementHandle()
    private var width float64 = 800
    private var height float64 = 320

    init() {
        viewport.MetricsChanged += metrics -> {
            if Math.Abs(width - metrics.BorderBox.Width) > 0.5 || Math.Abs(height - metrics.BorderBox.Height) > 0.5 {
                width = metrics.BorderBox.Width
                height = metrics.BorderBox.Height
                Rebuild()
            }
        }
    }

    protected override func Build(input FrescoInput) Blob {
        let scale = Math.Max(1, width) * 1.03 / 600
        let availableHeight = input.Height > 0 ? input.Height: height
        let orbScale = Math.Min(scale, Math.Max(1, availableHeight) / 270)
        let compositionWidth = 600 * scale
        let compositionHeight = 400 * scale
        return Container{
            Handle: viewport,
            Height: input.Height > 0 ? Length(input.Height): Percent(100),
            FlexShrink: 0,
            Overflow: input.Background ? Overflow.Hidden: Overflow.Visible,
            ShaderEffect: input.Art.Effect,
            Image{
                Source: input.Art.Backdrop,
                Opacity: input.Background ? 1: 0,
                Fit: ImageFit.Cover,
                Position: PositionType.Absolute,
                Left: 0,
                Right: 0,
                Top: 0,
                Bottom: 0
            },
            Container{
                Position: PositionType.Absolute,
                Left: (width - compositionWidth) / 2,
                Top: 0,
                Width: compositionWidth,
                Height: compositionHeight,
                Image{
                    Source: input.Art.Sun,
                    Opacity: 1 - input.Night,
                    Width: 190 * orbScale,
                    Height: 190 * orbScale,
                    Fit: ImageFit.Contain,
                    Position: PositionType.Absolute,
                    Left: (compositionWidth - 190 * orbScale) / 2,
                    Top: availableHeight - 210 * orbScale
                },
                Image{
                    Source: input.Art.Moon,
                    Opacity: input.Night,
                    Width: 190 * orbScale,
                    Height: 190 * orbScale,
                    Fit: ImageFit.Contain,
                    Position: PositionType.Absolute,
                    Left: (compositionWidth - 190 * orbScale) / 2,
                    Top: availableHeight - 210 * orbScale
                },
                Image{
                    Source: input.Art.Hands,
                    Width: compositionWidth,
                    Height: compositionHeight,
                    Fit: ImageFit.Contain,
                    Position: PositionType.Absolute,
                    Left: 0,
                    Top: availableHeight - 254 * scale
                },
            },
        }
    }
}
