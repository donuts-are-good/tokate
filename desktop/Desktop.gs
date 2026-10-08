package TokateDesktop

import Goo
import Goo.Animations
import Goo.Widgets
import Goo.Widgets.Actions
import Goo.Widgets.Icons
import Goo.Widgets.Inputs
import Goo.Widgets.Layout
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Numerics
import System.Text.Json

partial class Desktop : Cell {
    private let viewport ElementHandle = ElementHandle()
    private let contentViewport ElementHandle = ElementHandle()
    private var contentWidth float64 = 998
    private var narrow bool
    private var keyboardFocus bool
    private var chromeHover WindowChromeAction?
    private var windowWidth float64 = 1280
    private let art Artwork
    private let twilight Anim[float64]
    private let loadingPulse Anim[float64]
    private var host Window?
    private var page string = "Welcome"
    private var night bool
    private var motion bool = true
    private var oilPaint bool = true
    private var busy bool
    private var runner CommandRunner?
    private var activityTimer WindowTimer?
    private var activityTitle string = ""
    private var activityElapsed int32
    private var activityOutput string = ""
    private var activityPage string = ""
    private var activityAction string = ""
    private var activityVisible bool
    private var stopping bool
    private var message string = ""
    private var report string = ""
    private var confirmation Action?
    private var confirmationTitle string = ""
    private var confirmationText string = ""
    private var confirmationLabel string = "Confirm"
    private var confirmationContent Func[Blob]?

    init(assets Artwork) {
        art = assets
        twilight = Animate(0.0)
        loadingPulse = Animate(1.0)
        viewport.MetricsChanged += metrics -> {
            let next = metrics.BorderBox.Width < 1120
            if Math.Abs(windowWidth - metrics.BorderBox.Width) > 0.5 {
                windowWidth = metrics.BorderBox.Width
                narrow = next
                Rebuild()
            }
        }
        contentViewport.MetricsChanged += metrics -> {
            if Math.Abs(contentWidth - metrics.BorderBox.Width) > 0.5 {
                contentWidth = metrics.BorderBox.Width
                Rebuild()
            }
        }
        outputViewport.MetricsChanged += metrics -> {
            let follow = outputRange - outputOffset <= 2
            let changed = metrics.ScrollRange.Y != outputRange
            if metrics.ScrollOffset.Y < Math.Min(outputOffset, metrics.ScrollRange.Y) - 1 {
                followOutput = false
                Rebuild()
            }
            outputRange = metrics.ScrollRange.Y
            outputOffset = metrics.ScrollOffset.Y
            if changed && follow && followOutput {
                if activityLines.Count > 0 {
                    outputViewport.ScrollToItem(activityLines[activityLines.Count - 1].Index.ToString())
                } else {
                    outputViewport.ScrollTo(0, outputRange)
                }
            }
        }
    }

    func Attach(window Window) {
        host = window
        window.SmoothScrolling = true
        window.WheelScrollScale = 2.0F
        window.OnClosing = () -> {
            if !busy {
                approvalTimer?.Dispose()
                approvalRunner?.Stop()
                return true
            }
            message = "A command is active. Cancel it before closing, then inspect the saved run."
            Rebuild()
            return false
        }
        window.PreferencesChanged += preferences -> {
            if preferences.ReducedMotion == true {
                motion = false
            }
            Rebuild()
        }
    }

    private func ThemeColor(daylight string, moonlight string) Color {
        let day = Color.Parse(daylight)
        let dark = Color.Parse(moonlight)
        let t = float32(twilight.Value)
        return Color.FromNormalized(
            day.R + (dark.R - day.R) * t,
            day.G + (dark.G - day.G) * t,
            day.B + (dark.B - day.B) * t,
            1.0F
        )
    }

    private func Paper() Color -> ThemeColor("#F3E7D4", "#23324B")

    private func Surface() Color -> ThemeColor("#FFF8EB", "#2A3B53")

    private func Ink() Color -> ThemeColor("#303B2B", "#EEE5CF")

    private func Muted() Color -> ThemeColor("#625D4E", "#C1C6CB")

    private func Accent() Color -> ThemeColor("#97492E", "#E2BB80")

    private func Line() Color -> ThemeColor("#D7CCB7", "#526076")

    private func Label(content string, size float64 = 18, muted bool = false) Text -> Text{
        Content: content,
        FontFamily: "Newsreader",
        FontSize: size,
        Color: muted ? Muted(): Ink(),
    }

    private func Heading(content string, size float64 = 42) Text -> Text{
        Content: content,
        FontFamily: "Cormorant",
        FontWeight: 500,
        FontSize: size,
        Color: Ink(),
    }

    private func Rule() Blob -> Container{Height: 1, FlexShrink: 0, BackgroundColor: Line()}

    private func Keyboard(button Blob) Blob {
        WidgetKeyBindings.BindActivation(button)
        return button
    }

    private func FocusStyle() Style -> keyboardFocus ? Style{
        OutlineWidth: 2,
        OutlineColor: Accent(),
        OutlineOffset: 2
    }: Style{}

    private func FocusHints(value bool) {
        if keyboardFocus != value {
            keyboardFocus = value
            Rebuild()
        }
    }

    private func KeyNavigation(event KeyEvent) {
        if event.Key == Key.Tab ||
            event.Key == Key.Left ||
            event.Key == Key.Right ||
            event.Key == Key.Up ||
            event.Key == Key.Down {
            FocusHints(true)
        }
    }

    private func Action(
        label string,
        click Action,
        primary bool = false,
        disabled bool = false,
        allowWhileBusy bool = false
    ) Blob {
        let loading = busy && activityVisible && page == activityPage && activityAction == label && !donationRunning
        let unavailable = disabled || (busy && !loading && !allowWhileBusy) || (loading && stopping)
        let button = ActionButton{
            Content: label,
            AccessibilityName: loading ? "Cancel command": label,
            OnClick: () -> {
                if loading {
                    stopping = true
                    runner?.Stop()
                } else {
                    activityAction = label
                    click()
                }
            },
            CreateText: (options) -> Text{
                Content: label,
                FontFamily: "Newsreader",
                FontSize: 18,
                FontWeight: 400,
                Opacity: loading ? 0: 1,
            },
            Disabled: unavailable,
            BackgroundColor: primary ? Ink(): Surface(),
            TextColor: primary ? Paper(): Ink(),
            HoverBackgroundColor: primary ? Accent(): Paper(),
            ActiveBackgroundColor: Accent(),
            DisabledBackgroundColor: Surface(),
            DisabledTextColor: Muted(),
            BorderColor: primary ? Ink(): Line(),
            FocusBorderColor: Accent(),
            ShowFocusHighlight: keyboardFocus,
            FontFamily: "Newsreader",
            FontWeight: 400,
            FontSize: 18,
            Height: 44,
            BorderRadius: 5,
            TransitionMs: motion && !unavailable && !loading ? 180: 0,
        }.Build()
        button.MaxWidth = Percent(100)
        button.MinHeight = 44
        button.Height = Length.Auto
        button.Padding = Edges{Left: 16, Right: 16, Top: 10, Bottom: 10}
        if loading && button is Button {
            button.Accessibility = Accessibility{
                Role: AccessibilityRole.Button,
                Name: "Cancel command",
                Description: activityTitle,
                Busy: true,
            }
            button.Children.Add(
                Container{
                    Position: PositionType.Absolute,
                    Left: 0,
                    Right: 0,
                    Top: 0,
                    Bottom: 0,
                    AlignItems: AlignItems.Center,
                    JustifyContent: JustifyContent.Center,
                    Text{Content: stopping ? "Stopping": "Cancel", FontFamily: "Newsreader", FontSize: 18},
                }
            )
            button.Children.Add(
                Container{
                    Position: PositionType.Absolute,
                    Left: 10,
                    Right: 10,
                    Bottom: 3,
                    Height: 2,
                    BorderRadius: 1,
                    BackgroundColor: primary ? Paper(): Accent(),
                    Opacity: motion ? loadingPulse.Value: 1,
                }
            )
        }
        return button
    }

    private func Entry(
        label string,
        value string,
        change Action[string],
        placeholder string = "",
        width float64 = 400
    ) Blob {
        let field = TextField{
            Label: label,
            Value: value,
            OnChange: change,
            Placeholder: placeholder,
            Width: width,
            FontFamily: "Newsreader",
            FontSize: 18,
            LabelFontSize: 16,
            LabelFontWeight: 400,
            LabelTextTransform: TextTransform.None,
            EntryHeight: 44,
            BackgroundColor: Surface(),
            TextColor: Ink(),
            DisabledBackgroundColor: Surface(),
            DisabledTextColor: Muted(),
            MutedTextColor: Muted(),
            BorderColor: Line(),
            FocusColor: Accent(),
            ShowFocusHighlight: keyboardFocus,
            Disabled: busy,
            TransitionMs: 0,
        }.Build()
        field.MaxWidth = Percent(100)
        field.FlexShrink = 1
        return field
    }

    private func Dropdown(
        label string,
        value string,
        values[]ComboBoxOption,
        change Action[string],
        width float64
    ) Blob -> Container{
        Width: width,
        MaxWidth: Percent(100),
        Gap: 6,
        Label(label, 16, true),
        Cell.Mount[ComboBoxInput, ComboBox](
            nil,
            ComboBoxInput{
                Items: values,
                SelectedId: value,
                Placeholder: value,
                OnSelect: selected -> {
                    change(selected)
                    Rebuild()
                },
                AccessibilityName: label,
                Disabled: busy,
                Width: width,
                RowHeight: 40,
                CreateRoot: (input, root) -> {
                    root.MaxWidth = Percent(100)
                    return root
                },
                CreateTrigger: (input, button) -> {
                    button.Height = 44
                    button.BackgroundColor = Surface()
                    button.BorderColor = Line()
                    button.BorderRadius = 5
                    button.Focus = FocusStyle()
                    button.Hover = Style{BorderColor: Accent()}
                    return button
                },
                CreateRow: (input, item, row) -> {
                    row.BackgroundColor = item.Id == input.SelectedId ? Paper(): Surface()
                    row.Hover = Style{BackgroundColor: Paper()}
                    row.OutlineColor = keyboardFocus ? Accent(): Color.Transparent
                    return row
                },
                CreatePopup: (input, popup) -> {
                    popup.BackgroundColor = Surface()
                    popup.BorderColor = Line()
                    popup.OnKeyDown = event -> KeyNavigation(event)
                    popup.OnPointerDown = event -> FocusHints(false)
                    return popup
                },
            }
        ),
    }

    private func Check(label string, value bool, change Action[bool]) Blob {
        let checkbox = Checkbox{
            Label: label,
            State: value ? AccessibilityChecked.True: AccessibilityChecked.False,
            OnChange: state -> change(state == AccessibilityChecked.True),
            Disabled: busy,
            LabelColor: Ink(),
            LabelFontSize: 17,
            LabelFontWeight: 400,
            BackgroundColor: Surface(),
            CheckedBackgroundColor: Ink(),
            MarkColor: Paper(),
            BorderColor: Line(),
            CheckedBorderColor: Ink(),
        }.Build()
        checkbox.Focus = FocusStyle()
        return checkbox
    }

    private func Row(children[]Blob) Container -> Container{
        FlexDirection: FlexDirection.Row,
        AlignItems: AlignItems.Center,
        Gap: 12,
        FlexWrap: FlexWrap.Wrap,
        Children: children,
    }

    private func Navigate(next string) {
        page = next
        report = ""
        message = ""
        if next == "Saved work" && !savedLoaded && runDirectory == "" && !busy {
            Discover()
        }
    }

    private func Confirm(
        title string,
        text string,
        action Action,
        label string = "Confirm",
        content Func[Blob]? = nil
    ) {
        confirmationTitle = title
        confirmationText = text
        confirmation = action
        confirmationLabel = label
        confirmationContent = content
    }

    private func Execute(
        arguments[]string,
        completed Action[CommandResult],
        tool string = "tokate",
        directory string = "",
        seconds int32 = 120,
        completeOnError bool = false
    ) {
        if busy {
            return
        }
        busy = true
        if runner == nil {
            activityPage = page
            activityVisible = false
        }
        message = ""
        report = ""
        let next = CommandRunner()
        runner = next
        let window = host ?? throw InvalidOperationException("The desktop window is not attached.")
        activityTitle = switch arguments[0] {
            case "claim": "Reserving donation"
            case "work": "Donation running"
            case "prepare": "Preparing donation"
            case "select": "Checking model selection"
            case "status": "Loading saved work"
            case "init": "Preparing project setup"
            case "doctor": "Checking prerequisites"
            case "recover": "Verifying contribution"
            case "submit": "Submitting contribution"
            case "publish": "Publishing draft PR"
            case "checks": "Checking pull request"
            default: "Loading contribution details"
        }
        activityElapsed = 0
        activityOutput = ""
        stopping = false
        if !activityVisible {
            loadingPulse.Set(1.0)
        }
        let elapsed = Stopwatch.StartNew()
        activityTimer = window.SetInterval(
            () -> {
                let seconds = int32(elapsed.Elapsed.TotalSeconds)
                let output = donationRunning ? next.RecentOutput(): ""
                if !donationRunning && page == activityPage && activityElapsed != seconds {
                    loadingPulse.To(seconds % 2 == 0 ? 1.0: 0.35, Cubic.Tween(motion ? 0.8: 0.0))
                }
                if !activityVisible || activityElapsed != seconds || activityOutput != output {
                    activityVisible = true
                    activityElapsed = seconds
                    activityOutput = output
                    if donationRunning {
                        donationElapsed = seconds
                        donationOutput = output
                    }
                    Rebuild()
                }
            },
            250
        )
        let callback = (result CommandResult) -> {
            if donationRunning {
                donationOutput = next.RecentOutput()
                donationElapsed = int32(elapsed.Elapsed.TotalSeconds)
                donationRunning = false
                donationState = stopping ? "Donation stopped": result.Error != "" ||
                    result.ExitCode != 0 ? "Donation needs attention": "Donation finished"
                if result.Error != "" {
                    donationOutput += "\n" + result.Error
                }
            } else if step == 3 && donationPath == "" && result.Error != "" {
                donationState = "Reservation needs attention"
            }
            activityTimer?.Dispose()
            activityTimer = nil
            busy = false
            message = result.Error != "" ? result.Error: TextOf(result.Value, "status") == "pending" ?
            "Pending. Another person or the coordinator needs to act.": result.ExitCode != 0 ?
            "This action needs attention.": ""
            if result.Error == "" || completeOnError {
                completed(result)
            }
            if !busy {
                runner = nil
                loadingPulse.Set(1.0)
            }
            Rebuild()
        }
        go RunCommand(next, window, arguments, tool, directory, seconds, callback)
        Rebuild()
    }

    private func CancelCommand() Blob -> Keyboard(
        Button{
            Padding: Edges{Left: 14, Right: 14, Top: 8, Bottom: 8},
            BorderWidth: 1,
            BorderColor: Line(),
            BorderRadius: 4,
            Disabled: stopping,
            Focusable: true,
            Focus: FocusStyle(),
            Hover: Style{BackgroundColor: Paper()},
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: "Cancel command"},
            OnClick: () -> {
                stopping = true
                runner?.Stop()
            },
            Label(stopping ? "Stopping": "Cancel", 17),
        }
    )

    private func ShowResult(result CommandResult) {
        let data = Field(result.Value, "data")
        let found = TextOf(data, "run")
        if found != "" {
            runDirectory = found
        }
        let failure = Field(result.Value, "error")
        report = failure.ValueKind == JsonValueKind.Object ? failure.ToString(): data.ToString()
        if Field(result.Value, "truncated").ValueKind == JsonValueKind.True {
            report += "\nSome results were omitted by the CLI."
        }
    }

    private func ToggleTheme() {
        night = !night
        twilight.To(night ? 1.0: 0.0, Cubic.Tween(motion && host?.Preferences.ReducedMotion != true ? 1.1: 0.0))
        Rebuild()
    }

    private func Navigation(label string, index string) Blob -> Keyboard(
        Button{
            Height: 50,
            Padding: Edges{Left: 14, Right: 14},
            BorderRadius: 5,
            FlexDirection: FlexDirection.Row,
            AlignItems: AlignItems.Center,
            Gap: 16,
            JustifyContent: JustifyContent.FlexStart,
            BackgroundColor: page == label ? Surface(): Color.Transparent,
            BorderWidth: 0,
            BorderColor: Color.Transparent,
            OnClick: () -> Navigate(label),
            Focusable: true,
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: label},
            Hover: Style{BackgroundColor: Surface()},
            Focus: FocusStyle(),
            Container{
                Position: PositionType.Absolute,
                Left: 0,
                Top: 6,
                Bottom: 6,
                Width: 2,
                BorderRadius: 1,
                BackgroundColor: page == label ? Accent(): Color.Transparent,
            },
            Text{Content: index, Width: 36, FontFamily: "Cormorant", FontWeight: 500, FontSize: 26, Color: Accent()},
            Label(label, 19),
        }
    )

    private func Sidebar() Blob -> Container{
        Width: narrow ? 202: 226,
        FlexShrink: 0,
        Padding: Edges{Left: 20, Right: 20, Top: 28, Bottom: 24},
        BorderWidth: Edges{Right: 1},
        BorderColor: Line(),
        Gap: 10,
        Container{
            FlexDirection: FlexDirection.Row,
            Gap: 10,
            AlignItems: AlignItems.Center,
            JustifyContent: JustifyContent.Center,
            Padding: Edges{Bottom: 16},
            Container{Width: 25, Height: 36, art.Mark.Render()},
            Text{Content: "tokate", FontFamily: "Newsreader", FontSize: narrow ? 34: 38, Color: Accent()},
        },
        Container{Height: 1, BackgroundColor: Line(), Margin: Edges{Bottom: 14}},
        Navigation("Welcome", "I"),
        Navigation("Donate", "II"),
        Navigation("My project", "III"),
        Navigation("Saved work", "IV"),
        Container{FlexGrow: 1},
        Navigation("Appearance", "V"),
    }

    private func HeroHeight() float64 -> contentWidth * 0.4

    private func Painting(height float64, background bool = true) Blob ->
    Container{
        FlexGrow: height == 0 ? 1: 0,
        FlexBasis: height == 0 ? Length(0): Length.Auto,
        MinHeight: 0,
        Cell.Mount[FrescoInput, Fresco](
            "fresco",
            FrescoInput{Art: art, Night: twilight.Value, Height: height, Background: background}
        )
    }

    private func SectionBackground() Blob {
        let background = Container{
            Position: PositionType.Absolute,
            Left: 0,
            Right: 0,
            Top: 0,
            Bottom: 0,
            HitTestSelf: false,
        }
        if page == "Welcome" {
            background.ShaderEffect = art.Effect
            background.Children.Add(
                Image{Source: art.Backdrop, Fit: ImageFit.Cover, Width: Percent(100), Height: Percent(100)}
            )
            return background
        }
        let scene Landscape? = switch page {
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
                    Opacity: twilight.Value,
                }
            )
        }
        return background
    }

    private func HomeCard(title string, target string) Blob -> Keyboard(
        Button{
            FlexGrow: 1,
            FlexBasis: 0,
            MinWidth: 0,
            MaxWidth: 360,
            Height: contentWidth < 900 ? 72: 92,
            Padding: Edges{Left: contentWidth < 900 ? 28: 62, Right: contentWidth < 900 ? 28: 62},
            AlignItems: AlignItems.Center,
            JustifyContent: JustifyContent.Center,
            BorderRadius: 8,
            BorderWidth: 0,
            BackgroundColor: Color.Transparent,
            OnClick: () -> Navigate(target),
            Focusable: true,
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: title},
            Hover: Style{Opacity: 0.92},
            Focus: FocusStyle(),
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
                FontSize: contentWidth < 900 ? 18: 23,
                Color: Color.Parse("#303B2B"),
                TextAlign: TextAlign.Center,
            },
        }
    )

    private func HeroCopy() Blob -> Container{
        Padding: Edges{Top: 24, Bottom: 16},
        AlignItems: AlignItems.Center,
        Gap: 10,
        Heading("Give your inference", Math.Clamp(contentWidth * 0.06, 36, 55)),
        Text{
            Content: "a purpose.",
            FontFamily: "Cormorant",
            FontWeight: 500,
            FontStyle: FontStyle.Italic,
            FontSize: Math.Clamp(contentWidth * 0.075, 45, 68),
            Color: Accent(),
            Margin: Edges{Top: -20}
        },
    }

    private func Home() Blob -> Container{
        Height: Percent(100),
        MinHeight: 0,
        Gap: 0,
        Painting(0, false),
        Container{
            Width: Percent(100),
            MaxWidth: 1050,
            AlignSelf: AlignSelf.Center,
            Padding: Edges{Left: 24, Right: 24, Bottom: 32},
            Gap: 24,
            HeroCopy(),
            Container{
                FlexDirection: FlexDirection.Row,
                Gap: contentWidth < 900 ? 12: 24,
                JustifyContent: JustifyContent.Center,
                HomeCard("Donate AI time", "Donate"),
                HomeCard("Open your project", "My project"),
                HomeCard("Pick up your work", "Saved work"),
            },
        },
    }

    private func Appearance() Blob -> Container{
        Gap: 24,
        Heading("Appearance"),
        Painting(HeroHeight()),
        Check(
            "Oil-paint texture",
            oilPaint,
            value -> {
                oilPaint = value
            }
        ),
        Check(
            "Animate theme changes",
            motion,
            value -> {
                motion = value
            }
        ),
    }

    private func DialogButton(title string, content Blob) Button -> Button{
        Height: 44,
        Padding: Edges{Left: 16, Right: 16},
        BorderWidth: 1,
        BorderColor: Line(),
        BorderRadius: 5,
        BackgroundColor: Paper(),
        Focusable: true,
        Focus: FocusStyle(),
        Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: title},
        content,
    }

    private func Dialog() Blob -> Cell.Mount[ModalDialog, ModalDialogHost](
        "confirmation",
        ModalDialog{
            Open: confirmation != nil,
            KeyBindings: WidgetKeyBindings.Editing(host?.PlatformInput),
            Header: Heading(confirmationTitle, 32),
            Content: confirmationContent?.Invoke() ?? Label(confirmationText),
            AccessibilityName: confirmationTitle,
            Width: 580,
            Padding: 30,
            Gap: 20,
            BackgroundColor: Surface(),
            BorderColor: Line(),
            CancelText: "Go back",
            ConfirmText: confirmationLabel,
            CancelContent: Label("Go back"),
            ConfirmContent: Label(confirmationLabel),
            CreateCancel: (options, content) -> DialogButton("Go back", content),
            CreateConfirm: (options, content) -> DialogButton(confirmationLabel, content),
            CreateRoot: (options, backdrop, panel) -> Container{
                Position: PositionType.Absolute,
                Left: 0,
                Right: 0,
                Top: 0,
                Bottom: 0,
                ZIndex: options.ZIndex,
                AlignItems: AlignItems.Center,
                JustifyContent: JustifyContent.Center,
                OnKeyDown: event -> KeyNavigation(event),
                OnPointerDown: event -> FocusHints(false),
                backdrop,
                panel,
            },
            OnCancel: () -> {
                confirmation = nil
                Rebuild()
            },
            OnClose: () -> {
                confirmation = nil
                Rebuild()
            },
            OnConfirm: () -> {
                let action = confirmation
                confirmation = nil
                action?.Invoke()
                Rebuild()
            },
        }
    )

    override func Build() Blob {
        if let window = host {
            window.Background = Paper()
        }
        art.Effect.SetParameter(0, Vector4(float32(twilight.Value), oilPaint ? 1.0F: 0.0F, 0.0F, 0.04F))
        art.Effect.Playing = false
        art.LandscapeEffect.SetParameter(0, Vector4(0.0F, oilPaint ? 1.0F: 0.0F, 0.0F, 0.04F))
        art.LandscapeEffect.Playing = false
        let content = switch page {
            case "Donate": Donate()
            case "My project": Owner()
            case "Saved work": Saved()
            case "Appearance": Appearance()
            default: Home()
        }
        let welcome = page == "Welcome"
        let donating = page == "Donate" && step == 3
        let live = donating && donationStarted
        let body = Container{
            Key: page == "Donate" ? page + step.ToString(): page == "My project" ? page +
                ownerTab +
                ownerStep.ToString(): page,
            Handle: contentViewport,
            Width: Percent(100),
            Height: welcome || live ? Percent(100): Length.Auto,
            MinHeight: 0,
            MaxWidth: welcome ? Percent(100): Length(1050),
            AlignSelf: AlignSelf.Center,
            Gap: 18,
            content,
        }
        if message != "" && !donating && page != "Donate" {
            body.Children.Add(Label(message, 16, true))
        }
        if report != "" && !donating && page != "Donate" {
            body.Children.Add(
                Text{
                    Content: report,
                    FontFamily: "monospace",
                    FontSize: 13,
                    Color: Ink(),
                    MaxHeight: 300,
                    OverflowY: Overflow.Scroll
                }
            )
        }
        let root = Container{
            Width: Percent(100),
            Height: Percent(100),
            FlexDirection: FlexDirection.Row,
            Handle: viewport,
            KeyBindings: WidgetKeyBindings.Editing(host?.PlatformInput),
            OnKeyDown: event -> KeyNavigation(event),
            OnPointerDown: event -> FocusHints(false),
            Overflow: Overflow.Hidden,
            BackgroundColor: Paper(),
            FontFamily: "Newsreader",
            Color: Ink(),
            Sidebar(),
            Container{
                FlexGrow: 1,
                FlexShrink: 1,
                FlexBasis: 0,
                MinWidth: 0,
                MinHeight: 0,
                SectionBackground(),
                WindowChrome{
                    Host: host,
                    Height: 42,
                    BackgroundColor: welcome ? Color.Transparent: Paper(),
                    BorderColor: Color.Transparent,
                    ControlColor: Muted(),
                    HoverBackgroundColor: Surface(),
                    CloseHoverBackgroundColor: ThemeColor("#97492E", "#AA563A"),
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
                            command == WindowChromeAction.Close ? Color.Parse("#FFF8EB"): Ink()
                        ): Muted()
                    ),
                    CreateControl: (options, command, content, action) -> Button{
                        Width: options.ControlWidth,
                        Height: 32,
                        Margin: Edges{Right: 4},
                        BorderRadius: 4,
                        Padding: 0,
                        AlignItems: AlignItems.Center,
                        JustifyContent: JustifyContent.Center,
                        Focus: FocusStyle(),
                        OnPointerEnter: event -> {
                            chromeHover = command
                            Rebuild()
                        },
                        OnPointerLeave: event -> {
                            chromeHover = nil
                            Rebuild()
                        },
                        Hover: Style{
                            BackgroundColor: command == WindowChromeAction.Close ? ThemeColor(
                                "#97492E",
                                "#AA563A"
                            ): ThemeColor("#E4D4B8", "#35485F")
                        },
                    },
                    TrailingContent: IconButton{
                        Icon: MaterialIcons.Create(night ? "light_mode": "dark_mode", 20, Accent()),
                        AccessibilityName: night ? "Switch to daylight": "Switch to moonlight",
                        OnClick: () -> ToggleTheme(),
                        Width: 46,
                        Height: 42,
                        BorderRadius: 0,
                        HoverBackgroundColor: Surface(),
                        ShowFocusHighlight: keyboardFocus,
                        FocusOutlineColor: Accent(),
                    }.Build(),
                }.Build(),
                Container{
                    FlexGrow: 1,
                    FlexShrink: 1,
                    FlexBasis: 0,
                    MinWidth: 0,
                    MinHeight: 0,
                    OverflowX: Overflow.Hidden,
                    OverflowY: welcome || live ? Overflow.Hidden: Overflow.Scroll,
                    Padding: welcome ? 0: 28,
                    body,
                },
            },
        }
        if confirmation != nil {
            root.Children.Add(Container{Width: 0, Height: 0, Dialog()})
        }
        return root
    }
}
