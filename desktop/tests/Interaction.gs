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

func FindText(node AccessibilityNode?, text string) bool {
    guard let item = node else {
        return false
    }
    if item.Role == AccessibilityRole.Text && (item.Name.Contains(text) || item.Value.Contains(text)) {
        return true
    }
    for child in item.Children {
        if FindText(child, text) {
            return true
        }
    }
    return false
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

func AwaitControl(
    host TestHost,
    adapter TestAccessibility,
    role AccessibilityRole,
    name string,
    value string = "",
    enabled bool = false
) {
    let clock = Stopwatch.StartNew()
    while clock.Elapsed.TotalSeconds < 10 {
        Settle(host)
        if let node = Find(adapter.Root, role, name) {
            if (value == "" || node.Value == value) && (!enabled || !node.Disabled) {
                return
            }
        }
    }
    throw Exception("Timed out waiting for " + name + " / " + value)
}

func ScrollOutput(host TestHost, window Window, adapter TestAccessibility, end bool) {
    let view = Find(adapter.Root, AccessibilityRole.Generic, "Donation output") ?? throw Exception("Missing output")
    Require(
        window.PerformAccessibilityAction(view.Id, AccessibilityActionRequest(AccessibilityAction.Focus)),
        "Cannot focus activity"
    )
    Press(window, end ? Key.End: Key.Home)
    Settle(host)
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
            "if [ \"$2\" = user ]; then for i in $$(seq 1 200); do [ -e '" +
                fixture +
                "/release-lookup' ] && break; sleep .05; done; printf '%s' '{\"login\":\"fixture\"}'; else printf '%s' '{\"number\":278,\"title\":\"Improve the desktop\",\"state\":\"open\",\"labels\":[{\"name\":\"tokate:approved\"}]}'; fi\n"
        )
        Script(
            fixture,
            "tokate",
            "case \"$1\" in\npolicy) data='{\"policy\":{\"version\":2,\"allow_unlimited\":true,\"max_seconds\":3600}}';;\ndefaults) data='{\"profiles\":{},\"default\":{\"harness\":\"codex\",\"model\":\"obsolete-default\",\"effort\":\"low\"}}';;\nselect) data='{\"harness\":\"codex\",\"model\":\"gpt-6.1-sol\",\"effort\":\"high\"}';;\n*) exit 1;;\nesac\nprintf '{\"schema_version\":1,\"command\":\"%s\",\"status\":\"success\",\"exit_code\":0,\"data\":%s}' \"$1\" \"$$data\"\n"
        )
        Directory.CreateDirectory(Path.Combine(fixture, "run"))
        let request = Guid.NewGuid().ToString("D")
        File.WriteAllText(
            Path.Combine(fixture, "run", "run.json"),
            "{\"claim_request\":{\"uuid\":\"" + request + "\"}}"
        )
        let commandPath = Path.Combine(fixture, "tokate")
        let claim = "claim) printf '%s\\n' \"$$@\" > '" +
            fixture +
            "/claim-args'; printf 'Waiting for coordinator\\n' >&2; for i in $$(seq 1 200); do [ -e '" +
            fixture +
            "/release-claim' ] && break; sleep .05; done; data='{\"run\":\"" +
            fixture +
            "/run\"}';;\n"
        let status = "status) data='{\"run\":\"" +
            fixture +
            "/run\",\"state\":\"claim_pending\",\"approval\":\"approval-fixture\",\"donor_id\":7,\"repo\":\"owner/repo\",\"issue\":278,\"model\":\"gpt-6.1-sol\",\"effort\":\"high\",\"seconds\":1800,\"verification_reserve\":1800,\"unlimited\":true,\"coding_seconds\":null}';;\n"
        let coordination = "coordination) touch '" +
            fixture +
            "/approval-checked'; claim=unrelated; [ -e '" +
            fixture +
            "/approve' ] && claim='" +
            request +
            "'; data='{\"approval_id\":\"approval-fixture\",\"revoked\":false,\"reservation\":{\"lease\":\"'\"$$claim\"'\",\"attempt\":\"'\"$$claim\"'\",\"actor\":7,\"status\":\"active\",\"expires\":4102444800}}';;\n"
        let work = "work) touch '" +
            fixture +
            "/work-started'; trap 'touch \"" +
            fixture +
            "/cancelled\"; exit 0' INT; printf 'Preparing checkout\\n' >&2; for j in $$(seq 1 50); do printf 'Output line %s\\n' \"$$j\" >&2; done; for i in $$(seq 1 200); do sleep .05; done;;\n"
        var script = File.ReadAllText(commandPath).Replace(
            "*) exit 1;;",
            claim + status + coordination + work + "*) exit 1;;"
        )
        script = script.Replace("\"data\":%s}", "\"data\":%s,\"next_actions\":[[\"tokate\",\"work\"]]}")
        File.WriteAllText(commandPath, script)
        Script(
            fixture,
            "codex",
            "[ \"$$HOME\" = \"$$CODEX_HOME\" ] && [ \"$$PWD\" = \"$$HOME\" ] && [ \"$1 $2 $3\" = 'debug models --bundled' ] || exit 1\nprintf '%s' '{\"models\":[{\"slug\":\"gpt-6.1-sol\",\"display_name\":\"GPT-6.1-Sol\",\"supported_reasoning_levels\":[{\"effort\":\"high\"},{\"effort\":\"ultra\"}]},{\"slug\":\"gpt-6-luna\",\"display_name\":\"GPT-6-Luna\",\"supported_reasoning_levels\":[{\"effort\":\"high\"},{\"effort\":\"max\"}]}]}'\n"
        )
        Environment.SetEnvironmentVariable("PATH", fixture + ":" + previous)
        let githubPath = Path.Combine(fixture, "gh")
        let github = File.ReadAllText(githubPath)
        File.WriteAllText(githubPath, github.Replace("{\"name\":\"tokate:approved\"}", ""))
        Require(window.PlatformInput.CommitText("https://github.com/owner/repo/issues/278"), "Cannot enter issue URL")
        Settle(host)
        guard let lookup = Find(adapter.Root, AccessibilityRole.Button, "Find approved issues") else {
            throw Exception("Missing lookup button")
        }
        guard let heading = Find(adapter.Root, AccessibilityRole.Text, "Choose an issue") else {
            throw Exception("Missing issue heading")
        }
        let lookupBounds = lookup.Bounds
        let headingBounds = heading.Bounds
        Activate(window, adapter, "Find approved issues")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Cancel command")
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Cancel command")?.Bounds == lookupBounds,
            "Loading changed the action button bounds"
        )
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "Choose an issue")?.Bounds == headingBounds,
            "Loading shifted the page"
        )
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "Command output") == nil &&
                Find(adapter.Root, AccessibilityRole.Generic, "Donation output") == nil,
            "Loading displayed a donation output panel"
        )
        File.WriteAllText(Path.Combine(fixture, "release-lookup"), "release")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Issue #278 needs owner approval.")
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Model") == nil,
            "Unapproved issue reached model selection"
        )
        File.WriteAllText(githubPath, github)
        Activate(window, adapter, "Find approved issues")
        AwaitControl(host, adapter, AccessibilityRole.ComboBox, "Model", "GPT-6.1-Sol")
        Require(Find(adapter.Root, AccessibilityRole.Text, "Set your limits") != nil, "Step II heading missing")
        Require(Find(adapter.Root, AccessibilityRole.Text, "II") != nil, "Step II numeral missing")
        Require(
            Find(adapter.Root, AccessibilityRole.ComboBox, "Reasoning effort")?.Value == "High",
            "Default effort is not High"
        )
        for width in[]int32{800, 1024, 1280, 1920, 800} {
            host.Resize(width, 600, width, 600)
            Settle(host)
            for name in[]string{"Model", "Reasoning effort", "Coding minutes", "Verification minutes"} {
                var found = Find(adapter.Root, AccessibilityRole.ComboBox, name)
                found ??= Find(adapter.Root, AccessibilityRole.TextInput, name)
                guard let control = found else {
                    throw Exception("Missing donation control: " + name)
                }
                Require(
                    control.Bounds.X >= 202 && control.Bounds.X + control.Bounds.Width <= width + 1,
                    "Donation control escaped the window: " + name
                )
            }
        }
        host.Resize(1440, 900, 1440, 900)
        Settle(host)
        guard let tools = Find(adapter.Root, AccessibilityRole.Group, "Coding tool settings") else {
            throw Exception("Missing tool card")
        }
        guard let limits = Find(adapter.Root, AccessibilityRole.Group, "Time limit settings") else {
            throw Exception("Missing limit card")
        }
        Require(Math.Abs(tools.Bounds.Height - limits.Bounds.Height) < 1, "Donation cards have different heights")
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Back")?.Bounds.Y >= tools.Bounds.Y + tools.Bounds.Height,
            "Navigation is inside a settings card"
        )
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "60 min")?.Disabled == true,
            "Preset exceeds the owner time limit"
        )
        Activate(window, adapter, "15 min")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.TextInput, "Coding minutes")?.Value == "15",
            "Preset was not applied"
        )
        Activate(window, adapter, "30 min")
        Settle(host)
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
        Activate(window, adapter, "Change details")
        Settle(host)
        Activate(window, adapter, "Unlimited coding time", AccessibilityRole.Checkbox)
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.TextInput, "Coding minutes") == nil,
            "Unlimited still requests coding minutes"
        )
        Require(
            Find(adapter.Root, AccessibilityRole.TextInput, "Verification minutes") != nil,
            "Unlimited lost its verification limit"
        )
        Activate(window, adapter, "Check selection & review")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Review")
        Activate(window, adapter, "Reserve contribution")
        Settle(host)
        Activate(window, adapter, "Send request")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Reserving donation")
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "Command output") == nil &&
                Find(adapter.Root, AccessibilityRole.Generic, "Donation output") == nil,
            "Reservation displayed a donation output panel"
        )
        Activate(window, adapter, "Welcome")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "a purpose.") != nil,
            "Navigation is blocked during reservation"
        )
        Require(
            Find(adapter.Root, AccessibilityRole.Text, "Reserving donation") == nil,
            "Reservation activity leaked to another view"
        )
        Activate(window, adapter, "Switch to moonlight")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Switch to daylight") != nil,
            "Theme control is blocked during reservation"
        )
        let claimed = File.ReadAllText(Path.Combine(fixture, "claim-args"))
        Require(
            claimed.Contains("--unlimited\n") && !claimed.Contains("--seconds\n") && claimed.Contains(
                "--verification-reserve\n1800\n"
            ),
            "Unlimited claim arguments do not match the CLI"
        )
        Activate(window, adapter, "Donate")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Start donation")?.Disabled == true,
            "Start enabled before reservation completed"
        )
        File.WriteAllText(Path.Combine(fixture, "release-claim"), "release")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Waiting for approval")
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Start donation")?.Disabled == true,
            "Start enabled before approval"
        )
        let observed = Stopwatch.StartNew()
        while !File.Exists(Path.Combine(fixture, "approval-checked")) && observed.Elapsed.TotalSeconds < 8 {
            Settle(host)
        }
        Require(File.Exists(Path.Combine(fixture, "approval-checked")), "Approval was not checked")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.Button, "Start donation")?.Disabled == true,
            "An unrelated reservation enabled Start"
        )
        Require(!File.Exists(Path.Combine(fixture, "work-started")), "Inference started without consent")
        File.WriteAllText(Path.Combine(fixture, "approve"), "approved")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Start donation", enabled: true)
        Activate(window, adapter, "Start donation")
        Settle(host)
        Require(FindText(adapter.Root, "Unlimited"), "Donation lost the unlimited coding choice")
        Activate(window, adapter, "Start this donation")
        AwaitControl(host, adapter, AccessibilityRole.Status, "Donation running")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Command output")
        window.RequestClose()
        Settle(host)
        Require(window.IsOpen, "Closing the window terminated active work")
        Require(FindText(adapter.Root, "A command is active"), "Blocked close did not explain how to stop safely")
        let transcript = Stopwatch.StartNew()
        while !FindText(adapter.Root, "Output line 50") && transcript.Elapsed.TotalSeconds < 5 {
            Settle(host)
        }
        Require(FindText(adapter.Root, "Output line 50"), "The output panel did not follow new activity")
        ScrollOutput(host, window, adapter, false)
        Require(FindText(adapter.Root, "Preparing checkout"), "The output panel lost earlier activity")
        Activate(window, adapter, "Follow live")
        Settle(host)
        Require(FindText(adapter.Root, "Output line 50"), "Cannot return to the latest activity")
        AwaitControl(host, adapter, AccessibilityRole.Text, "Elapsed 00:00:01")
        guard let footer = Find(adapter.Root, AccessibilityRole.Text, "Elapsed 00:00:01") else {
            throw Exception("Missing elapsed footer")
        }
        Require(footer.Bounds.Y + footer.Bounds.Height <= window.Height, "Elapsed footer overflowed the window")
        Activate(window, adapter, "My project")
        Settle(host)
        Require(Find(adapter.Root, AccessibilityRole.Text, "My project") != nil, "Navigation is blocked during work")
        Require(
            Find(adapter.Root, AccessibilityRole.Status, "Donation running") == nil &&
                Find(adapter.Root, AccessibilityRole.Text, "Command output") == nil,
            "Donation output leaked to another view"
        )
        Activate(window, adapter, "Donate")
        AwaitControl(host, adapter, AccessibilityRole.Status, "Donation running")
        ScrollOutput(host, window, adapter, false)
        Require(FindText(adapter.Root, "Preparing checkout"), "Donation output was lost after navigation")
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
        File.WriteAllText(commandPath, File.ReadAllText(commandPath).Replace("claim_pending", "claimed"))
        Activate(window, adapter, "View saved work")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Start donation", enabled: true)
        Activate(window, adapter, "Start donation")
        Settle(host)
        Require(FindText(adapter.Root, "Unlimited"), "Saved work did not confirm its Unlimited budget")
        Activate(window, adapter, "Go back")
        Settle(host)
        Require(Find(adapter.Root, AccessibilityRole.Text, "Donation") != nil, "Saved work did not open Donate")
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
    let x = float32(field.Bounds.X + field.Bounds.Width / 2)
    let y = float32(field.Bounds.Y + field.Bounds.Height / 2)
    window.PlatformInput.PointerPress(1, PointerDevice.Mouse, x, y, PointerButton.Primary, KeyModifiers{}, 1)
    window.PlatformInput.PointerRelease(1, PointerDevice.Mouse, x, y, PointerButton.Primary, KeyModifiers{}, 0)
    Settle(host)
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

func TestCommandLifecycle() {
    let marker = Path.Combine(Path.GetTempPath(), "tokate-child-" + Guid.NewGuid().ToString("N"))
    var child = 0
    try {
        let clock = Stopwatch.StartNew()
        let result = CommandRunner().Run(
            []string{
                "-c",
                "sleep 30 </dev/null >/dev/null 2>&1 & printf '%s' \"$$!\" > \"$1\"; trap 'exit 0' INT; while :; do sleep .05; done",
                "fixture",
                marker,
            },
            "/bin/sh",
            seconds: 1
        )
        Require(result.Error.Contains("timed out"), "Lifecycle probe did not time out")
        child = int32.Parse(File.ReadAllText(marker))
        var alive = false
        try {
            using let process = Process.GetProcessById(child)
            alive = !process.HasExited
        } catch (error ArgumentException) { }
        Require(!alive, "Cancellation left a child process running")
        Require(clock.Elapsed.TotalSeconds < 8, "Cancellation did not finish promptly")
    } finally {
        if child > 0 {
            try {
                using let process = Process.GetProcessById(child)
                if !process.HasExited {
                    process.Kill(true)
                }
            } catch (error ArgumentException) { }
        }
        File.Delete(marker)
    }
}

func Main(args[]string) {
    if Array.IndexOf(args, "--lifecycle") >= 0 {
        TestCommandLifecycle()
        Console.WriteLine("PASS: command descendants and timeout cleanup")
        return
    }
    TestDesktop()
    WorkspaceFlow()
    TestCommandLifecycle()
    let literal = CommandRunner().Run([]string{"%s", "{\"value\":\"$(literal); *\"}"}, "/usr/bin/printf")
    Require(
        literal.Error == "" && TextOf(literal.Value, "value") == "$(literal); *",
        "Command arguments were not literal"
    )
    let unlimitedResult = CommandRunner().Run([]string{"-c", "sleep .2; printf '{}'"}, "/bin/sh", seconds: 0)
    Require(unlimitedResult.Error == "" && unlimitedResult.ExitCode == 0, "Unlimited command expired")
    let large = CommandRunner().Run([]string{"-c", "1048577", "/dev/zero"}, "/usr/bin/head")
    Require(large.Error.Contains("display limit"), "Oversized command output was not rejected")
    let noisyRunner = CommandRunner()
    let noisy = noisyRunner.Run(
        []string{"-c", "head -c 1048577 /dev/zero >&2; printf finished >&2; printf '{}'"},
        "/bin/sh"
    )
    Require(
        noisy.Error == "" && noisy.ExitCode == 0 && noisyRunner.RecentOutput().EndsWith("finished"),
        "Long-running diagnostic output was lost or failed the command"
    )
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
        "PASS: responsive layout, donation controls, saved contribution states, owner setup preservation, confirmation boundaries and cancellation"
    )
}
