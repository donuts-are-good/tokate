package TokateDesktop

class HarnessChoice(id string, name string, icon string) {
    let Id string = id
    let Name string = name
    let Icon string = icon
}

class HarnessChoices {
    shared {
        let Items[]HarnessChoice = []HarnessChoice{
            HarnessChoice("codex", "Codex", "terminal"),
            HarnessChoice("pi", "Pi / local", "memory"),
        }
    }
}
