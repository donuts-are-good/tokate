package TokateDesktop

import Goo
import Goo.Animations
import Goo.Widgets
import Goo.Widgets.Actions
import Goo.Widgets.Icons
import Goo.Widgets.Layout
import System
import System.Numerics

class Desktop : Cell {
    private let viewport ElementHandle = ElementHandle()
    private let contentViewport ElementHandle = ElementHandle()
    private var narrow bool
    private var chromeHover WindowChromeAction?
    private let art Artwork
    private let twilight Anim[float64]
    private let loadingPulse Anim[float64]
    private var night bool
    private var oilPaint bool = true
    private let app DesktopSession
    private let ui ThemedControls
    private let donor DonationScreen
    private let owner OwnerScreen
    private let saved SavedWorkScreen
    private var pulseElapsed int32 = -1
    private var pulsing bool

    init(assets Artwork) {
        art = assets
        app = DesktopSession(() -> Refresh(), next -> Navigate(next), path -> saved.Remember(path))
        ui = ThemedControls(
            app.Refresh,
            () -> app.Cancel(),
            label -> {
                app.ActionName = label
            }
        )
        donor = DonationScreen(app, ui, path -> saved.Open(path), path -> saved.Remember(path))
        owner = OwnerScreen(app, ui)
        saved = SavedWorkScreen(
            app,
            ui,
            (value, path) -> {
                donor.OpenDonation(value, path)
                donor.StartDonation()
            }
        )
        twilight = Animate(0.0)
        loadingPulse = Animate(1.0)
        viewport.MetricsChanged += metrics -> {
            let next = metrics.BorderBox.Width < 1120
            if Math.Abs(ui.WindowWidth - metrics.BorderBox.Width) > 0.5 || Math.Abs(
                ui.WindowHeight - metrics.BorderBox.Height
            ) > 0.5 {
                ui.WindowWidth = metrics.BorderBox.Width
                ui.WindowHeight = metrics.BorderBox.Height
                narrow = next
                app.Refresh()
            }
        }
        contentViewport.MetricsChanged += metrics -> {
            if Math.Abs(ui.ContentWidth - metrics.BorderBox.Width) > 0.5 {
                ui.ContentWidth = metrics.BorderBox.Width
                app.Refresh()
            }
        }
    }

    func Attach(window Window) {
        app.Window = window
        window.SmoothScrolling = true
        window.WheelScrollScale = 2.0F
        window.OnClosing = () -> {
            if !app.Busy {
                donor.Stop()
                saved.StopSavedUpdates()
                return true
            }
            app.Message = "A command is active. Cancel it before closing, then inspect the saved run."
            app.Refresh()
            return false
        }
        window.PreferencesChanged += preferences -> {
            if preferences.ReducedMotion == true {
                ui.Motion = false
            }
            app.Refresh()
        }
    }

    private func Navigate(next string) {
        if app.Page == "Saved work" && next != app.Page {
            saved.StopSavedUpdates()
        }
        app.Page = next
        app.Report = ""
        app.Message = ""
        if next == "Saved work" {
            saved.Enter()
        }
    }

    private func Refresh() {
        if !app.Busy {
            loadingPulse.Set(1.0)
            pulsing = false
            pulseElapsed = -1
        } else if !app.Streaming && app.Page == app.ActivePage && (!pulsing || pulseElapsed != app.Elapsed) {
            pulsing = true
            pulseElapsed = app.Elapsed
            loadingPulse.To(app.Elapsed % 2 == 0 ? 1.0: 0.35, Cubic.Tween(ui.Motion ? 0.8: 0.0))
        }
        Rebuild()
    }

    private func ToggleTheme() {
        night = !night
        twilight.To(
            night ? 1.0: 0.0,
            Cubic.Tween(ui.Motion && app.Window?.Preferences.ReducedMotion != true ? 1.1: 0.0)
        )
        app.Refresh()
    }

    private func Navigation(label string, index string) Blob {
        let caption = ui.Compact() ? switch label {
            case "Appearance": "Theme"
            case "My project": "Project"
            case "Saved work": "Saved"
            default: label
        }: label
        let button = Button{
            Height: ui.Compact() ? 42: 50,
            FlexGrow: ui.Compact() ? 1: 0,
            FlexBasis: ui.Compact() ? Length(0): Length.Auto,
            MinWidth: 0,
            Padding: Edges{Left: ui.Compact() ? 6: 14, Right: ui.Compact() ? 6: 14},
            BorderRadius: 5,
            FlexDirection: FlexDirection.Row,
            AlignItems: AlignItems.Center,
            Gap: 16,
            JustifyContent: ui.Compact() ? JustifyContent.Center: JustifyContent.FlexStart,
            BackgroundColor: app.Page == label ? ui.Surface(): Color.Transparent,
            BorderWidth: 0,
            BorderColor: Color.Transparent,
            OnClick: () -> app.Navigate(label),
            Focusable: true,
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: label},
            Hover: Style{BackgroundColor: ui.Surface()},
            Focus: ui.FocusStyle(),
            ui.Label(caption, ui.Compact() ? 16: 19),
        }
        let indicator = Container{
            Position: PositionType.Absolute,
            Left: 0,
            BorderRadius: 1,
            BackgroundColor: app.Page == label ? ui.Accent(): Color.Transparent,
        }
        if ui.Compact() {
            indicator.Right = 0
            indicator.Bottom = 0
            indicator.Height = 2
        } else {
            indicator.Top = 6
            indicator.Bottom = 6
            indicator.Width = 2
        }
        button.Children.Insert(0, indicator)
        if !ui.Compact() {
            button.Children.Insert(
                1,
                Text{
                    Content: index,
                    Width: 36,
                    FontFamily: "Cormorant",
                    FontWeight: 500,
                    FontSize: 26,
                    Color: ui.Accent()
                }
            )
        }
        return ui.Keyboard(button)
    }

    private func Sidebar() Blob {
        if ui.Compact() {
            return Container{
                Key: "navigation",
                Height: 46,
                FlexShrink: 0,
                FlexDirection: FlexDirection.Row,
                Padding: Edges{Left: 8, Right: 8, Bottom: 4},
                Gap: 2,
                BackgroundColor: ui.Paper(),
                BorderWidth: Edges{Bottom: 1},
                BorderColor: ui.Line(),
                Navigation("Welcome", "I"),
                Navigation("Donate", "II"),
                Navigation("My project", "III"),
                Navigation("Saved work", "IV"),
                Navigation("Appearance", "V"),
            }
        }
        return Container{
            Key: "navigation",
            Width: narrow ? 202: 226,
            FlexShrink: 0,
            Padding: Edges{Left: 20, Right: 20, Top: 28, Bottom: 24},
            BorderWidth: Edges{Right: 1},
            BorderColor: ui.Line(),
            Gap: 10,
            Container{
                FlexDirection: FlexDirection.Row,
                Gap: 10,
                AlignItems: AlignItems.Center,
                JustifyContent: JustifyContent.Center,
                Padding: Edges{Bottom: 16},
                Container{Width: 25, Height: 36, art.Mark.Render()},
                Text{Content: "tokate", FontFamily: "Newsreader", FontSize: narrow ? 34: 38, Color: ui.Accent()},
            },
            Container{Height: 1, BackgroundColor: ui.Line(), Margin: Edges{Bottom: 14}},
            Navigation("Welcome", "I"),
            Navigation("Donate", "II"),
            Navigation("My project", "III"),
            Navigation("Saved work", "IV"),
            Container{FlexGrow: 1},
            Navigation("Appearance", "V"),
        }
    }

    private func HeroHeight() float64 -> ui.ContentWidth * 0.4

    private func Painting(height float64, background bool = true) Blob ->
    Container{
        FlexGrow: height == 0 ? 1: 0,
        FlexBasis: height == 0 ? Length(0): Length.Auto,
        MinHeight: 0,
        Cell.Mount[FrescoInput, Fresco](
            "fresco",
            FrescoInput{Art: art, Night: ui.Twilight, Height: height, Background: background}
        )
    }

    private func SectionBackground() Blob {
        let background = Container{
            Key: "background",
            Position: PositionType.Absolute,
            Left: 0,
            Right: 0,
            Top: 0,
            Bottom: 0,
            HitTestSelf: false,
        }
        if app.Page == "Welcome" {
            background.ShaderEffect = art.Effect
            background.Children.Add(
                Image{Source: art.Backdrop, Fit: ImageFit.Cover, Width: Percent(100), Height: Percent(100)}
            )
            return background
        }
        let scene Landscape? = switch app.Page {
            case "Donate": art.Donate
            case "My project": art.Project
            case "Saved work": art.Saved
            default: nil
        }
        if let landscape = scene {
            background.ShaderEffect = art.LandscapeEffect
            background.Opacity = 0.65
            background.Children.Add(
                Image{Source: landscape.Daylight, Fit: ImageFit.Cover, Width: Percent(100), Height: Percent(100)}
            )
            background.Children.Add(
                Image{
                    Source: landscape.Moonlight,
                    Fit: ImageFit.Cover,
                    Position: PositionType.Absolute,
                    Left: 0,
                    Right: 0,
                    Top: 0,
                    Bottom: 0,
                    Opacity: ui.Twilight,
                }
            )
        }
        return background
    }

    private func HomeCard(title string, target string) Blob -> ui.Keyboard(
        Button{
            FlexGrow: 1,
            FlexBasis: 0,
            MinWidth: 0,
            MaxWidth: 360,
            Height: ui.ContentWidth < 900 ? 72: 92,
            Padding: Edges{Left: ui.ContentWidth < 900 ? 28: 62, Right: ui.ContentWidth < 900 ? 28: 62},
            AlignItems: AlignItems.Center,
            JustifyContent: JustifyContent.Center,
            BorderRadius: 8,
            BorderWidth: 0,
            BackgroundColor: Color.Transparent,
            OnClick: () -> app.Navigate(target),
            Focusable: true,
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: title},
            Hover: Style{Opacity: 0.92},
            Focus: ui.FocusStyle(),
            Image{
                Source: art.Stone,
                Fit: ImageFit.Fill,
                Position: PositionType.Absolute,
                Left: 0,
                Top: Percent(-21),
                Width: Percent(100),
                Height: Percent(142),
            },
            Text{
                Content: title,
                FontFamily: "Cormorant",
                FontWeight: 500,
                FontSize: ui.ContentWidth < 900 ? 18: 23,
                Color: Color.Parse("#303B2B"),
                TextAlign: TextAlign.Center,
            },
        }
    )

    private func HeroCopy() Blob -> Container{
        Padding: Edges{Top: 24, Bottom: 16},
        AlignItems: AlignItems.Center,
        Gap: 10,
        ui.Heading("Give your inference", Math.Clamp(ui.ContentWidth * 0.06, 36, 55)),
        Text{
            Content: "a purpose.",
            FontFamily: "Cormorant",
            FontWeight: 500,
            FontStyle: FontStyle.Italic,
            FontSize: Math.Clamp(ui.ContentWidth * 0.075, 45, 68),
            Color: ui.Accent(),
            Margin: Edges{Top: -20}
        },
    }

    private func Home() Blob -> Container{
        Height: ui.Short() ? Length.Auto: Percent(100),
        MinHeight: 0,
        Gap: 0,
        Painting(ui.Short() ? 160: 0, false),
        Container{
            Width: Percent(100),
            MaxWidth: 1050,
            AlignSelf: AlignSelf.Center,
            Padding: Edges{Left: 24, Right: 24, Bottom: 32},
            Gap: 24,
            HeroCopy(),
            Container{
                FlexDirection: FlexDirection.Row,
                Gap: ui.ContentWidth < 900 ? 12: 24,
                JustifyContent: JustifyContent.Center,
                HomeCard("Donate AI time", "Donate"),
                HomeCard("Open your project", "My project"),
                HomeCard("Pick up your work", "Saved work"),
            },
        },
    }

    private func Appearance() Blob -> Container{
        Gap: 24,
        ui.Heading("Appearance"),
        Painting(HeroHeight()),
        ui.Check(
            "Oil-paint texture",
            oilPaint,
            value -> {
                oilPaint = value
            }
        ),
        ui.Check(
            "Animate theme changes",
            ui.Motion,
            value -> {
                ui.Motion = value
            }
        ),
    }

    private func DialogButton(title string, content Blob) Button -> Button{
        Height: 44,
        Padding: Edges{Left: 16, Right: 16},
        BorderWidth: 1,
        BorderColor: ui.Line(),
        BorderRadius: 5,
        BackgroundColor: ui.Paper(),
        Focusable: true,
        Focus: ui.FocusStyle(),
        Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: title},
        content,
    }

    private func Dialog() Blob -> Cell.Mount[ModalDialog, ModalDialogHost](
        "confirmation",
        ModalDialog{
            Open: app.Confirmation != nil,
            KeyBindings: WidgetKeyBindings.Editing(app.Window?.PlatformInput),
            Header: ui.Heading(app.ConfirmationTitle, 32),
            Content: Container{
                MinHeight: 0,
                FlexShrink: 1,
                OverflowY: Overflow.Scroll,
                app.ConfirmationContent?.Invoke() ?? ui.Label(app.ConfirmationText),
            },
            AccessibilityName: app.ConfirmationTitle,
            Width: Math.Min(580, ui.WindowWidth - 32),
            Padding: ui.Compact() ? 20: 30,
            Gap: ui.Short() ? 12: 20,
            BackgroundColor: ui.Surface(),
            BorderColor: ui.Line(),
            CancelText: "Go back",
            ConfirmText: app.ConfirmationLabel,
            CancelContent: ui.Label("Go back"),
            ConfirmContent: ui.Label(app.ConfirmationLabel),
            CreateCancel: (options, content) -> DialogButton("Go back", content),
            CreateConfirm: (options, content) -> DialogButton(app.ConfirmationLabel, content),
            CreateRoot: (options, backdrop, panel) -> Container{
                Position: PositionType.Absolute,
                Left: 0,
                Right: 0,
                Top: 0,
                Bottom: 0,
                ZIndex: options.ZIndex,
                AlignItems: AlignItems.Center,
                JustifyContent: JustifyContent.Center,
                OnKeyDown: event -> ui.KeyNavigation(event),
                OnPointerDown: event -> ui.FocusHints(false),
                backdrop,
                panel,
            },
            OnCancel: () -> {
                app.Confirmation = nil
                app.Refresh()
            },
            OnClose: () -> {
                app.Confirmation = nil
                app.Refresh()
            },
            OnConfirm: () -> {
                let action = app.Confirmation
                app.Confirmation = nil
                action?.Invoke()
                app.Refresh()
            },
        }
    )

    override func Build() Blob {
        ui.Twilight = twilight.Value
        ui.LoadingPulse = loadingPulse.Value
        ui.Busy = app.Busy
        ui.Loading = app.Busy && app.Visible && app.Page == app.ActivePage && !app.Streaming
        ui.Stopping = app.Stopping
        ui.ActionName = app.ActionName
        ui.ActivityTitle = app.Title
        if let window = app.Window {
            window.Background = ui.Paper()
        }
        art.Effect.SetParameter(0, Vector4(float32(ui.Twilight), oilPaint ? 1.0F: 0.0F, 0.0F, 0.04F))
        art.Effect.Playing = false
        art.LandscapeEffect.SetParameter(0, Vector4(0.0F, oilPaint ? 1.0F: 0.0F, 0.0F, 0.04F))
        art.LandscapeEffect.Playing = false
        let content = switch app.Page {
            case "Donate": donor.Build()
            case "My project": owner.Build()
            case "Saved work": saved.Build()
            case "Appearance": Appearance()
            default: Home()
        }
        let welcome = app.Page == "Welcome"
        let donating = app.Page == "Donate" && donor.IsDonating
        let live = app.Page == "Donate" && donor.IsLive
        let browsing = switch app.Page {
            case "Donate": donor.IsBrowsing
            case "Saved work": saved.IsBrowsing
            case "My project": owner.IsBrowsing
            default: false
        }
        if browsing && !ui.Short() {
            content.FlexGrow = 1
            content.FlexShrink = 1
            content.FlexBasis = 0
            content.MinHeight = 0
        }
        let body = Container{
            Key: app.Page == "Donate" ? donor.Key: app.Page == "My project" ? owner.Key: app.Page,
            Handle: contentViewport,
            Width: Percent(100),
            Height: !ui.Short() && (welcome || live || browsing) ? Percent(100): Length.Auto,
            FlexShrink: !ui.Short() && (welcome || live || browsing) ? 1: 0,
            MinHeight: 0,
            MaxWidth: welcome ? Percent(100): Length(1050),
            AlignSelf: AlignSelf.Center,
            Gap: 18,
            content,
        }
        if app.Message != "" && !donating && app.Page != "Donate" {
            body.Children.Add(ui.Label(app.Message, 16, true))
        }
        if app.Report != "" && !donating && app.Page != "Donate" {
            body.Children.Add(
                Text{
                    Content: app.Report,
                    FontFamily: "monospace",
                    FontSize: 13,
                    Color: ui.Ink(),
                    MaxHeight: 300,
                    OverflowY: Overflow.Scroll
                }
            )
        }
        let workspace = Container{
            Key: "workspace",
            FlexGrow: 1,
            FlexShrink: 1,
            FlexBasis: 0,
            MinWidth: 0,
            MinHeight: 0,
            SectionBackground(),
            WindowChrome{
                Host: app.Window,
                Height: 42,
                BackgroundColor: welcome ? Color.Transparent: ui.Paper(),
                BorderColor: Color.Transparent,
                ControlColor: ui.Muted(),
                HoverBackgroundColor: ui.Surface(),
                CloseHoverBackgroundColor: ui.ThemeColor("#97492E", "#AA563A"),
                EnableDoubleClick: true,
                CreateControlContent: (options, command) -> MaterialIcons.Create(
                    switch command {
                        case WindowChromeAction.Minimize: "remove"
                        case WindowChromeAction.Maximize: "crop_square"
                        case WindowChromeAction.Restore: "filter_none"
                        default: "close"
                    },
                    18,
                    chromeHover == command ? (
                        command == WindowChromeAction.Close ? Color.Parse("#FFF8EB"): ui.Ink()
                    ): ui.Muted()
                ),
                CreateControl: (options, command, content, action) -> Button{
                    Width: options.ControlWidth,
                    Height: 32,
                    Margin: Edges{Right: 4},
                    BorderRadius: 4,
                    Padding: 0,
                    AlignItems: AlignItems.Center,
                    JustifyContent: JustifyContent.Center,
                    Focus: ui.FocusStyle(),
                    OnPointerEnter: event -> {
                        chromeHover = command
                        app.Refresh()
                    },
                    OnPointerLeave: event -> {
                        chromeHover = nil
                        app.Refresh()
                    },
                    Hover: Style{
                        BackgroundColor: command == WindowChromeAction.Close ? ui.ThemeColor(
                            "#97492E",
                            "#AA563A"
                        ): ui.ThemeColor("#E4D4B8", "#35485F")
                    },
                },
                TrailingContent: IconButton{
                    Icon: MaterialIcons.Create(night ? "light_mode": "dark_mode", 20, ui.Accent()),
                    AccessibilityName: night ? "Switch to daylight": "Switch to moonlight",
                    OnClick: () -> ToggleTheme(),
                    Width: 46,
                    Height: 42,
                    BorderRadius: 0,
                    HoverBackgroundColor: ui.Surface(),
                    ShowFocusHighlight: ui.KeyboardFocus,
                    FocusOutlineColor: ui.Accent(),
                }.Build(),
            }.Build(),
            Container{
                Key: "content-scroll",
                FlexGrow: 1,
                FlexShrink: 1,
                FlexBasis: 0,
                MinWidth: 0,
                MinHeight: 0,
                OverflowX: Overflow.Hidden,
                OverflowY: !ui.Short() && (welcome || live || browsing) ? Overflow.Hidden: Overflow.Scroll,
                Padding: welcome ? 0: ui.Compact() ? 16: 28,
                body,
            },
        }
        workspace.Children[1].Key = "chrome"
        if ui.Compact() {
            workspace.Children.Insert(2, Sidebar())
        }
        let root = Container{
            Width: Percent(100),
            Height: Percent(100),
            FlexDirection: FlexDirection.Row,
            Handle: viewport,
            KeyBindings: WidgetKeyBindings.Editing(app.Window?.PlatformInput),
            OnKeyDown: event -> ui.KeyNavigation(event),
            OnPointerDown: event -> ui.FocusHints(false),
            Overflow: Overflow.Hidden,
            BackgroundColor: ui.Paper(),
            FontFamily: "Newsreader",
            Color: ui.Ink(),
            workspace,
        }
        if !ui.Compact() {
            root.Children.Insert(0, Sidebar())
        }
        if app.Confirmation != nil {
            root.Children.Add(Container{Key: "dialog", Width: 0, Height: 0, Dialog()})
        }
        return root
    }
}
