package TokateDesktop

import Goo
import System
import System.IO

func Edit(window Window, host TestHost, adapter TestAccessibility, name string, value string) {
    let field = Find(adapter.Root, AccessibilityRole.TextInput, name) ?? throw Exception("Missing field: " + name)
    Require(
        window.PerformAccessibilityAction(field.Id, AccessibilityActionRequest(AccessibilityAction.Focus)),
        "Cannot focus " + name
    )
    Press(window, Key.A, true)
    window.PlatformInput.CommitText(value)
    Settle(host)
}

func Choose(host TestHost, window Window, adapter TestAccessibility, name string) {
    Activate(window, adapter, name)
    Settle(host)
}

func WorkspaceFlow() {
    let fixture = Path.Combine(Path.GetTempPath(), "tokate-workspace-" + Guid.NewGuid().ToString("N"))
    let previousPath = Environment.GetEnvironmentVariable("PATH")
    let previousState = Environment.GetEnvironmentVariable("XDG_STATE_HOME")
    Directory.CreateDirectory(fixture)
    let bin = Path.Combine(fixture, "bin")
    Directory.CreateDirectory(bin)
    let storage = Path.Combine(fixture, "tokate", "runs")
    for name in[]string{"broken", "claimed", "failed", "amend", "merged"} {
        Directory.CreateDirectory(Path.Combine(storage, name))
    }
    Script(
        bin,
        "tokate",
        "case \"$$1\" in\nstatus)\n  case \"$$2\" in\n  --run)\n    name=$${3##*/}\n    case \"$$name\" in\n    claimed) state=claimed; issue=41; pr=0; reason='';;\n    failed) state=failed; issue=42; pr=0; reason=inference_failed;;\n    amend) state=published; issue=43; pr=3; reason='';;\n    merged) state=published; issue=44; pr=4; reason='';;\n    *) exit 1;;\n    esac\n    data=\"{\\\"run\\\":\\\"$$3\\\",\\\"repo\\\":\\\"owner/repo\\\",\\\"issue\\\":$$issue,\\\"state\\\":\\\"$$state\\\",\\\"pr\\\":$$pr,\\\"model\\\":\\\"gpt-6.1-sol\\\",\\\"effort\\\":\\\"high\\\",\\\"failure_reason\\\":\\\"$$reason\\\"}\"\n    ;;\n  *) data='{\"work\":[],\"access_status\":\"observed\"}';;\n  esac;;\npolicy) data='{\"policy\":{\"version\":2,\"model_policy\":\"unrestricted\",\"eligibility\":\"trusted\",\"allowed_tools\":[{\"harness\":\"codex\"}],\"verification\":[[\"dotnet\",\"test\"]],\"required_checks\":[\"build\"],\"max_seconds\":3600}}';;\naccess) data='{\"access_sha\":\"existing\",\"members\":[],\"pending\":[]}';;\ninit)\n  printf '%s\\n' \"$$@\" > FIXTURE/owner-args\n  printf 'Proposed complete file:\\nfixture policy\\n' >&2\n  case \" $$* \" in *' --yes '*) touch FIXTURE/applied;; esac\n  data='{\"applied\":false}';;\napprove) touch FIXTURE/approved; data='{}';;\n*) data='{}';;\nesac\nprintf '{\"schema_version\":1,\"command\":\"%s\",\"exit_code\":0,\"status\":\"ok\",\"data\":%s,\"next_actions\":[[\"tokate\",\"work\"]]}' \"$$1\" \"$$data\"\n"
            .Replace("FIXTURE", fixture)
    )
    Script(
        bin,
        "gh",
        "if [ \"$$1\" = pr ]; then\n  if [ \"$$3\" = 4 ]; then printf '%s' '{\"state\":\"MERGED\"}'; else printf '%s' '{\"state\":\"OPEN\",\"reviewDecision\":\"CHANGES_REQUESTED\"}'; fi\nelif [ \"$$2\" = repos/owner/repo ]; then\n  printf '%s' '{\"permissions\":{\"push\":true},\"default_branch\":\"main\"}'\nelif [ \"$$2\" = 'repos/owner/repo/issues?state=open&sort=updated&per_page=30' ]; then\n  printf '%s' '[{\"number\":42,\"title\":\"Improve rendering\",\"labels\":[]}]'\nelse\n  printf '%s' '{\"title\":\"Improve rendering\"}'\nfi\n"
    )
    Environment.SetEnvironmentVariable("PATH", bin + ":" + previousPath)
    Environment.SetEnvironmentVariable("XDG_STATE_HOME", fixture)
    try {
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
        host.Resize(1440, 1000, 1440, 1000)
        window.Attach(host)
        host.SetFocused(true)
        Settle(host)
        Choose(host, window, adapter, "Saved work")
        Settle(host)
        AwaitControl(host, adapter, AccessibilityRole.Status, "Needs amendment")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Refresh contributions", enabled: true)
        Require(
            Find(adapter.Root, AccessibilityRole.Status, "Claimed, not started") != nil,
            "Missing not-started state"
        )
        Require(Find(adapter.Root, AccessibilityRole.Status, "Initial donation failed") != nil, "Missing failed state")
        Require(!FindText(adapter.Root, "owner/repo #44"), "Merged contribution remains active")
        Require(!FindText(adapter.Root, "LOCAL RUN DIRECTORIES"), "Saved work still exposes a folder list")
        Choose(host, window, adapter, "My project")
        Edit(window, host, adapter, "GitHub repository", "owner/repo")
        Choose(host, window, adapter, "Open project")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Approve issue #42", enabled: true)
        Choose(host, window, adapter, "Approve issue #42")
        Settle(host)
        Require(!File.Exists(Path.Combine(fixture, "approved")), "Approval ran before confirmation")
        Choose(host, window, adapter, "Go back")
        Choose(host, window, adapter, "Setup")
        Settle(host)
        Require(FindText(adapter.Root, "dotnet test"), "Existing verification command was lost")
        Edit(window, host, adapter, "Command", "dotnet build")
        Choose(host, window, adapter, "Add command")
        Choose(host, window, adapter, "Set permissions")
        Settle(host)
        Require(
            Find(adapter.Root, AccessibilityRole.TextInput, "Model whitelist") == nil,
            "Raw policy JSON editor remains"
        )
        Choose(host, window, adapter, "Review setup")
        Edit(window, host, adapter, "Local checkout", fixture)
        Choose(host, window, adapter, "Preview setup")
        AwaitControl(host, adapter, AccessibilityRole.Button, "Apply preview", enabled: true)
        let args = File.ReadAllText(Path.Combine(fixture, "owner-args"))
        Require(
            args.Contains("[[\"dotnet\",\"test\"],[\"/bin/sh\",\"-c\",\"dotnet build\"]]"),
            "Editing verification replaced the existing command"
        )
        Require(
            !args.Contains("--models") && !args.Contains("--allowed-tools"),
            "Unchanged policy restrictions were replaced"
        )
        Require(!File.Exists(Path.Combine(fixture, "applied")), "Preview applied configuration")
        Choose(host, window, adapter, "Apply preview")
        Settle(host)
        Choose(host, window, adapter, "Go back")
        Require(!File.Exists(Path.Combine(fixture, "applied")), "Cancel applied configuration")
    } finally {
        Environment.SetEnvironmentVariable("PATH", previousPath)
        Environment.SetEnvironmentVariable("XDG_STATE_HOME", previousState)
        Directory.Delete(fixture, true)
    }
}
