package TokateDesktop

import Goo
import Goo.Widgets
import Goo.Widgets.Actions
import Goo.Widgets.Icons
import Goo.Widgets.Inputs
import System

partial class ThemedControls {
    private let refresh Action
    private let cancel Action
    private let activate Action[string]
    var Busy bool
    var Loading bool
    var Stopping bool
    var ActionName string = ""
    var ActivityTitle string = ""
    var ContentWidth float64 = 998
    var WindowWidth float64 = 1280
    var WindowHeight float64 = 860
    var KeyboardFocus bool
    var Motion bool = true
    var Twilight float64
    var LoadingPulse float64 = 1.0

    init(refresh Action, cancel Action, activate Action[string]) {
        this.refresh = refresh
        this.cancel = cancel
        this.activate = activate
    }

    func ThemeColor(daylight string, moonlight string) Color {
        let day = Color.Parse(daylight)
        let dark = Color.Parse(moonlight)
        let t = float32(Twilight)
        return Color.FromNormalized(
            day.R + (dark.R - day.R) * t,
            day.G + (dark.G - day.G) * t,
            day.B + (dark.B - day.B) * t,
            1.0F
        )
    }

    func Paper() Color -> ThemeColor("#F3E7D4", "#23324B")

    func Surface() Color -> ThemeColor("#FFF8EB", "#2A3B53")

    func Ink() Color -> ThemeColor("#303B2B", "#EEE5CF")

    func Muted() Color -> ThemeColor("#625D4E", "#C1C6CB")

    func Accent() Color -> ThemeColor("#97492E", "#E2BB80")

    func Line() Color -> ThemeColor("#D7CCB7", "#526076")

    func Label(content string, size float64 = 18, muted bool = false) Text -> Text{
        Content: content,
        FontFamily: "Newsreader",
        FontSize: size,
        Color: muted ? Muted(): Ink(),
    }

    func Heading(content string, size float64 = 42) Text -> Text{
        Content: content,
        FontFamily: "Cormorant",
        FontWeight: 500,
        FontSize: size,
        Color: Ink(),
    }

    func Rule() Blob -> Container{Height: 1, FlexShrink: 0, BackgroundColor: Line()}

    func Keyboard(button Blob) Blob {
        WidgetKeyBindings.BindActivation(button)
        return RevealFocus(button)
    }

    func RevealFocus(control Blob) Blob {
        let handle = control.Handle ?? ElementHandle()
        let focused = control.OnFocus
        control.Handle = handle
        control.OnFocus = event -> {
            focused?.Invoke(event)
            handle.ScrollIntoView()
        }
        return control
    }

    func FocusStyle() Style -> KeyboardFocus ? Style{OutlineWidth: 2, OutlineColor: Accent(), OutlineOffset: 2}: Style{}

    func FocusHints(value bool) {
        if KeyboardFocus != value {
            KeyboardFocus = value
            refresh()
        }
    }

    func KeyNavigation(event KeyEvent) {
        if event.Key == Key.Tab ||
            event.Key == Key.Left ||
            event.Key == Key.Right ||
            event.Key == Key.Up ||
            event.Key == Key.Down {
            FocusHints(true)
        }
    }

    func Action(
        label string,
        click Action,
        primary bool = false,
        disabled bool = false,
        allowWhileBusy bool = false
    ) Blob {
        let loading = Loading && ActionName == label
        let unavailable = disabled || (Busy && !loading && !allowWhileBusy) || (loading && Stopping)
        let button = ActionButton{
            Content: label,
            AccessibilityName: loading ? "Cancel command": label,
            OnClick: () -> {
                if loading {
                    cancel()
                } else {
                    activate(label)
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
            ShowFocusHighlight: KeyboardFocus,
            FontFamily: "Newsreader",
            FontWeight: 400,
            FontSize: 18,
            Height: 44,
            BorderRadius: 5,
            TransitionMs: Motion && !unavailable && !loading ? 180: 0,
        }.Build()
        button.MaxWidth = Percent(100)
        button.MinHeight = 44
        button.Height = Length.Auto
        button.Padding = Edges{Left: 16, Right: 16, Top: 10, Bottom: 10}
        if loading && button is Button {
            button.Accessibility = Accessibility{
                Role: AccessibilityRole.Button,
                Name: "Cancel command",
                Description: ActivityTitle,
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
                    Text{Content: Stopping ? "Stopping": "Cancel", FontFamily: "Newsreader", FontSize: 18},
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
                    Opacity: Motion ? LoadingPulse: 1,
                }
            )
        }
        return Keyboard(button)
    }

    func Entry(
        label string,
        value string,
        change Action[string],
        placeholder string = "",
        width float64 = 400,
        submit Action? = nil
    ) Blob {
        let field = TextField{
            Label: label,
            Value: value,
            OnChange: change,
            OnSubmit: _ -> submit?.Invoke(),
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
            ShowFocusHighlight: KeyboardFocus,
            Disabled: Busy,
            TransitionMs: 0,
        }.Build()
        field.MaxWidth = Percent(100)
        field.FlexShrink = 1
        return RevealFocus(field)
    }

    func Dropdown(
        label string,
        value string,
        values[]ComboBoxOption,
        change Action[string],
        width float64
    ) Blob -> RevealFocus(
        Container{
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
                        refresh()
                    },
                    AccessibilityName: label,
                    Disabled: Busy,
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
                        row.OutlineColor = KeyboardFocus ? Accent(): Color.Transparent
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
    )

    func Check(label string, value bool, change Action[bool]) Blob {
        let checkbox = Checkbox{
            Label: label,
            State: value ? AccessibilityChecked.True: AccessibilityChecked.False,
            OnChange: state -> change(state == AccessibilityChecked.True),
            Disabled: Busy,
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
        return RevealFocus(checkbox)
    }

    func Row(children[]Blob) Container -> Container{
        FlexDirection: FlexDirection.Row,
        AlignItems: AlignItems.Center,
        Gap: 12,
        FlexWrap: FlexWrap.Wrap,
        Children: children,
    }

    func CancelCommand() Blob -> Keyboard(
        Button{
            Padding: Edges{Left: 14, Right: 14, Top: 8, Bottom: 8},
            BorderWidth: 1,
            BorderColor: Line(),
            BorderRadius: 4,
            Disabled: Stopping,
            Focusable: true,
            Focus: FocusStyle(),
            Hover: Style{BackgroundColor: Paper()},
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: "Cancel command"},
            OnClick: () -> {
                cancel()
            },
            Label(Stopping ? "Stopping": "Cancel", 17),
        }
    )

    func Short() bool -> WindowHeight < 600

    func Compact() bool -> WindowWidth < 900 || Short()

    func Panel() Container -> Container{
        Padding: ContentWidth < 650 ? 20: 28,
        Gap: 18,
        BackgroundColor: Surface(),
        BorderWidth: 1,
        BorderColor: Line(),
        BorderRadius: 8,
    }

    func ChoiceCard(title string, detail string, icon string, selected bool, choose Action) Blob -> Keyboard(
        Button{
            FlexGrow: 1,
            FlexBasis: 0,
            MinWidth: 190,
            MinHeight: 82,
            Padding: 20,
            Gap: 10,
            AlignSelf: AlignSelf.Stretch,
            AlignItems: AlignItems.FlexStart,
            BackgroundColor: selected ? Paper(): Surface(),
            BorderWidth: selected ? 2: 1,
            BorderColor: selected ? Accent(): Line(),
            BorderRadius: 6,
            Disabled: Busy,
            Focusable: true,
            Focus: FocusStyle(),
            Hover: Style{BorderColor: Accent()},
            Accessibility: Accessibility{Role: AccessibilityRole.Button, Name: title, Description: detail},
            OnClick: choose,
            Container{
                Width: Percent(100),
                FlexDirection: FlexDirection.Row,
                AlignItems: AlignItems.Center,
                Gap: 12,
                MaterialIcons.Create(icon, 24, Accent()),
                Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, Heading(title, 27)},
                MaterialIcons.Create("check_circle", 18, selected ? Accent(): Color.Transparent),
            },
        }
    )

    func SummaryTile(title string, value string, icon string) Blob -> Container{
        FlexGrow: 1,
        FlexBasis: 0,
        MinWidth: 190,
        Padding: 20,
        Gap: 12,
        BackgroundColor: Paper(),
        BorderRadius: 6,
        Row([]Blob{MaterialIcons.Create(icon, 22, Accent()), Label(title, 16, true)}),
        Heading(value, 29),
    }

    func ReviewDetail(label string, value string) Blob -> Container{
        FlexDirection: FlexDirection.Row,
        AlignItems: AlignItems.FlexStart,
        Gap: 16,
        Container{Width: 120, FlexShrink: 0, Label(label, 17, true)},
        Container{FlexGrow: 1, FlexBasis: 0, MinWidth: 0, Label(value, 19)},
    }

    func StatusBadge(value string) Blob -> Container{
        Padding: Edges{Left: 12, Right: 12, Top: 7, Bottom: 7},
        BorderRadius: 4,
        BackgroundColor: Paper(),
        Accessibility: Accessibility{Role: AccessibilityRole.Status, Name: value},
        Label(value, 17),
    }
}
