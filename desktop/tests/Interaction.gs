package TokateDesktop

import Goo
import System
import System.Diagnostics
import System.IO

open class TestHost : EmbeddedWindowHost {
    var Clipboard string = ""
    protected override func RequestFrame() { }

    protected override func LoadVulkanLibrary() bool -> false

    protected override func GetVulkanGetInstanceProcAddr() nint -> nint(0)

    protected override func UnloadVulkanLibrary() { }

    protected override func GetVulkanInstanceExtensions()[]string -> []string{}

    protected override func CreateVulkanSurface(instance nint, out surface uint64) bool {
        surface = 0
        return false
    }

    protected override func DestroyVulkanSurface(instance nint, surface uint64) { }

    protected override func GetClipboardText() string -> Clipboard

    protected override func SetClipboardText(value string) {
        Clipboard = value
    }
}

class TestAccessibility : AccessibilityAdapter {
    var Root AccessibilityNode?
    func Update(tree AccessibilityTree) {
        Root = tree.Root
    }
}

func Require(value bool, message string) {
    if !value {
        throw InvalidOperationException(message)
    }
}

func Find(node AccessibilityNode?, role AccessibilityRole, name string = "") AccessibilityNode? {
    guard let item = node else {
        return nil
    }
    if item.Role == role && (name == "" || item.Name == name || item.Value == name) {
        return item
    }
    for child in item.Children {
        if let found = Find(child, role, name) {
            return found
        }
    }
    return nil
}

func Settle(host TestHost) {
    for i in 0 ... 7 {
        host.RenderFrame(0.016)
    }
}

func Press(window Window, key Key, ctrl bool = false) {
    window.PlatformInput.KeyPress(key, KeyModifiers{Ctrl: ctrl})
    window.PlatformInput.KeyRelease(key, KeyModifiers{Ctrl: ctrl})
}

func Activate(
    window Window,
    adapter TestAccessibility,
    name string,
    role AccessibilityRole = AccessibilityRole.Button
) {
    let node = Find(adapter.Root, role, name) ?? throw Exception("Missing control: " + name)
    Require(
        window.PerformAccessibilityAction(node.Id, AccessibilityActionRequest(AccessibilityAction.Activate)),
        "Cannot activate " + name
    )
}

func AwaitControl(host TestHost, adapter TestAccessibility, role AccessibilityRole, name string, value string = "") {
    let clock = Stopwatch.StartNew()
    while clock.Elapsed.TotalSeconds < 10 {
        Settle(host)
        if let node = Find(adapter.Root, role, name) {
            if value == "" || node.Value == value {
                return
            }
        }
    }
    throw Exception("Timed out waiting for " + name + " / " + value)
}

func Script(directory string, name string, body string) {
    let path = Path.Combine(directory, name)
    File.WriteAllText(path, "#!/bin/sh\n" + body)
    File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
}

func DonateFlow(host TestHost, window Window, adapter TestAccessibility) {
    let fixture = Path.Combine(Path.GetTempPath(), "tokate-gui-flow-" + Guid.NewGuid().ToString("N"))
    let previous = Environment.GetEnvironmentVariable("PATH")
    Directory.CreateDirectory(fixture, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
    try {
        Script(
            fixture,
            "gh",
            "if [ \"$2\" = user ]; then printf '%s' '{\"login\":\"fixture\"}'; else printf '%s' '{\"number\":278,\"title\":\"Improve the desktop\",\"state\":\"open\",\"labels\":[{\"name\":\"tokate:approved\"}]}'; fi\n"
        )
        Script(
            fixture,
            "tokate",
            "case \"$1\" in\npolicy) data='{\"policy\":{}}';;\ndefaults) data='{\"profiles\":{},\"default\":{\"harness\":\"codex\",\"model\":\"obsolete-default\",\"effort\":\"low\"}}';;\nselect) data='{\"harness\":\"codex\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}';;\n*) exit 1;;\nesac\nprintf '{\"schema_version\":1,\"command\":\"%s\",\"status\":\"success\",\"exit_code\":0,\"data\":%s}' \"$1\" \"$$data\"\n"
        )
        let commandPath = Path.Combine(fixture, "tokate")
        let claim = "claim) printf 'Waiting for coordinator\\n' >&2; for i in $$(seq 1 200); do [ -e '" +
            fixture +
            "/release-claim' ] && break; sleep .05; done; data='{\"run\":\"" +
            fixture +
            "/run\"}';;\n"
        let status = "status) data='{\"run\":\"" +
            fixture +
            "/run\",\"state\":\"claimed\",\"repo\":\"owner/repo\",\"issue\":278,\"model\":\"gpt-6.1-sol\",\"effort\":\"high\",\"seconds\":60}';;\n"
        let work = "work) trap 'touch \"" +
            fixture +
            "/cancelled\"; exit 0' INT; printf 'Preparing checkout\\n' >&2; for i in $$(seq 1 200); do sleep .05; done;;\n"
        var script = File.ReadAllText(commandPath).Replace("*) exit 1;;", claim + status + work + "*) exit 1;;")
        script = script.Replace("\"data\":%s}", "\"data\":%s,\"next_actions\":[[\"tokate\",\"work\"]]}")
        File.WriteAllText(commandPath, script)
        Script(
            fixture,
            "codex",
            "[ \"$$HOME\" = \"$$CODEX_HOME\" ] && [ \"$$PWD\" = \"$$HOME\" ] && [ \"$1 $2 $3\" = 'debug models --bundled' ] || exit 1\nprintf '%s' '{\"models\":[{\"slug\":\"gpt-6.1-sol\",\"display_name\":\"GPT-6.1-Sol\",\"supported_reasoning_levels\":[{\"effort\":\"high\"},{\"effort\":\"ultra\"}]},{\"slug\":\"gpt-6-luna\",\"display_name\":\"GPT-6-Luna\",\"supported_reasoning_levels\":[{\"effort\":\"high\"},{\"effort\":\"max\"}]}]}'\n"
        )
        Environment.SetEnvironmentVariable("PATH", fixture + ":" + previous)
        Require(window.PlatformInput.CommitText("https://github.com/owner/repo/issues/278"), "Cannot enter issue URL")
        Activate(window, adapter, "Find approved issues")
        AwaitControl(host, adapter, AccessibilityRole.ComboBox, "Model", "GPT-6.1-Sol")
        Require(Find(adapter.Root, AccessibilityRole.Text, "Set your limits") != nil, "Step II heading missing")
        Require(Find(adapter.Root, AccessibilityRole.Text, "II") != nil, "Step II numeral missing")
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Reasoning effort")?.Value == "High",
            "Default effort is not High"
        )
        Activate(window, adapter, "Model", AccessibilityRole.ComboBox)
        Settle(host)
        Press(window, Key.End)
        Press(window, Key.Enter)
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Model")?.Value == "GPT-6-Luna",
            "Model dropdown did not commit"
        )
        Activate(window, adapter, "Reasoning effort", AccessibilityRole.ComboBox)
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.ListItem, "Ultra") == nil,
            "Unsupported effort leaked between models"
        )
        Press(window, Key.End)
        Press(window, Key.Enter)
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Reasoning effort")?.Value == "Max",
            "Effort dropdown did not commit"
        )
        Activate(window, adapter, "Pi / local")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Model") == nil &&
                Find(adapter.Root, AccessibilityRole.TextInput, "Model") != nil,
            "Local model is not editable"
        )
        Activate(window, adapter, "Codex")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Model")?.Value == "GPT-6.1-Sol",
            "Codex did not restore Sol"
        )
        Activate(window, adapter, "Check selection & review")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Review")
        Require(Find(adapter.Root, AccessibilityRole.Text, "III") != nil, "Step III numeral missing")
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "Command completed.") == nil,
            "Routine completion text remains"
        )
        Activate(window, adapter, "Reserve contribution")
        Settle(host)
        Activate(window, adapter, "Confirm")
        AwaitControl(host, adapter, AccessibilityRole.Status, "Reserving donation")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Command output", "Waiting for coordinator")
        Activate(window, adapter, "Welcome")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "a purpose.") != nil,
            "Navigation is blocked during reservation"
        )
        Require(
            Find(adapter.Root, AccessibilityRole.Status, "Reserving donation") != nil,
            "Activity disappeared after navigation"
        )
        Activate(window, adapter, "Switch to moonlight")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Switch to daylight") != nil,
            "Theme control is blocked during reservation"
        )
        File.WriteAllText(Path.Combine(fixture, "release-claim"), "release")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Start donation")
        Activate(window, adapter, "Start donation")
        Settle(host)
        Activate(window, adapter, "Confirm")
        AwaitControl(host, adapter, AccessibilityRole.Status, "Donation running")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Command output", "Preparing checkout")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Elapsed 00:00:01")
        Activate(window, adapter, "My project")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "Make room for good work.") != nil,
            "Navigation is blocked during work"
        )
        Activate(window, adapter, "Cancel command")
        let cancelled = Stopwatch.StartNew()
        while cancelled
            .Elapsed
            .TotalSeconds < 10 &&
            Find(adapter.Root, AccessibilityRole.Status, "Donation running") != nil {
            Settle(host)
        }
        Require(
            Find(adapter.Root, AccessibilityRole.Status, "Donation running") == nil,
            "Running state survived cancellation"
        )
        Require(File.Exists(Path.Combine(fixture, "cancelled")), "Cancel did not interrupt the worker gracefully")
    } finally {
        Environment.SetEnvironmentVariable("PATH", previous)
        Directory.Delete(fixture, true)
    }
}

func TestDesktop() {
    using let body = FontSource("Newsreader", 400, false, File.ReadAllBytes(Asset("newsreader.ttf")))
    using let heading = FontSource("Cormorant", 500, false, File.ReadAllBytes(Asset("cormorant.ttf")))
    body.Register()
    heading.Register()
    using let art = Artwork()
    using let host = TestHost()
    let adapter = TestAccessibility()
    let desktop = Desktop(art)
    let window = Window{Root: desktop, AccessibilityAdapter: adapter}
    desktop.Attach(window)
    host.Resize(1280, 860, 1280, 860)
    window.Attach(host)
    host.SetFocused(true)
    Settle(host)
    for width in[]int32{800, 1024, 1280, 1920, 800} {
        host.Resize(width, 600, width, 600)
        Settle(host)
        let title = Find(adapter.Root, AccessibilityRole.Text, "a purpose.") ?? throw Exception("Missing headline")
        for name in[]string{"Donate AI time", "Open your project", "Pick up your work"} {
            let action = Find(adapter.Root, AccessibilityRole.Button, name) ?? throw Exception("Missing home action")
            Require(
                action.Bounds.X >= 202 && action.Bounds.X + action.Bounds.Width <= width + 1,
                "Home action escaped the content width"
            )
            Require(action.Bounds.Y >= title.Bounds.Y + title.Bounds.Height, "Home action overlaps the headline")
            Require(action.Bounds.Y + action.Bounds.Height <= 600, "Home action overflows the window height")
        }
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Make a contribution") == nil,
            "Duplicate contribution action"
        )
    }
    let donate = Find(adapter.Root, AccessibilityRole.Button, "Donate") ?? throw Exception("Missing navigation")
    Require(
        window.PerformAccessibilityAction(donate.Id, AccessibilityActionRequest(AccessibilityAction.Activate)),
        "Cannot navigate"
    )
    Settle(host)
    let field = Find(adapter.Root, AccessibilityRole.TextInput) ?? throw Exception("Missing repository input")
    Require(
        window.PerformAccessibilityAction(field.Id, AccessibilityActionRequest(AccessibilityAction.Focus)),
        "Cannot focus input"
    )
    Require(window.PlatformInput.CommitText("owner/repoz"), "Cannot enter repository")
    Press(window, Key.Backspace)
    Require(window.PlatformInput.Editor?.Text == "owner/repo", "Backspace did not remove the last character")
    Press(window, Key.Left)
    Press(window, Key.Delete)
    Require(window.PlatformInput.Editor?.Text == "owner/rep", "Delete or cursor movement failed")
    Press(window, Key.A, true)
    host.Clipboard = "other/project"
    Press(window, Key.V, true)
    Require(window.PlatformInput.Editor?.Text == "other/project", "Select-all and paste failed")
    Press(window, Key.A, true)
    Press(window, Key.Backspace)
    Require(window.PlatformInput.Editor?.Text == "", "Backspace did not remove selected text")
    Settle(host)
    Require(Find(adapter.Root, AccessibilityRole.TextInput)?.Value == "", "The empty input was not retained")
    DonateFlow(host, window, adapter)
}

func Main() {
    TestDesktop()
    let literal = CommandRunner().Run([]string{"%s", "{\"value\":\"$(literal); *\"}"}, "/usr/bin/printf")
    Require(
        literal.Error == "" && TextOf(literal.Value, "value") == "$(literal); *",
        "Command arguments were not literal"
    )
    let large = CommandRunner().Run([]string{"-c", "1048577", "/dev/zero"}, "/usr/bin/head")
    Require(large.Error.Contains("display limit"), "Oversized command output was not rejected")
    let marker = Path.Combine(Path.GetTempPath(), "tokate-gui-cancel-" + Guid.NewGuid().ToString("N"))
    try {
        let interrupted = CommandRunner().Run(
            []string{
                "-c",
                "trap 'printf interrupted > \"$1\"; exit 0' INT; while :; do sleep 0.05; done",
                "fixture",
                marker
            },
            "/bin/sh",
            seconds: 1
        )
        Require(
            interrupted.Error.Contains("timed out") && File.Exists(marker),
            "Timeout did not allow graceful interruption"
        )
    } finally {
        File.Delete(marker)
    }
    Console.WriteLine(
        "PASS: responsive home, field editing, donation progress, navigation during work, output limits and graceful interruption"
    )
}
