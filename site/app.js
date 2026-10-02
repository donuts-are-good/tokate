const dialog = document.querySelector("#setup");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const motionButton = document.querySelector("#motion");
const sun = document.querySelector(".sun");
const pupils = document.querySelectorAll(".pupil");
const roles = {
    owner: {
        label: "For project owners",
        title: "A little help for your project.",
        steps: [
            "Choose a small issue with a clear result.",
            "Set your checks and approve a donor.",
            "Review the tested pull request. You decide what merges.",
        ],
        anchor: "i-own-the-repository",
        prompt: "Read https://github.com/obselate/tokate/blob/main/AGENTS.md and help me set up my repository to receive donated compute. I am the repository owner. Inspect my project, help me choose appropriate checks, and guide me through approving an issue for a donor.",
    },
    donor: {
        label: "For compute donors",
        title: "Give a project a little lift.",
        steps: [
            "Install Tokate and sign in with your own accounts.",
            "Get assigned to an approved issue and run the task.",
            "Your AI makes the changes. Tokate checks them and opens a draft PR.",
        ],
        anchor: "i-want-to-donate-compute",
        prompt: "Read https://github.com/obselate/tokate/blob/main/AGENTS.md and help me donate compute to a repository. I am the donor. Confirm my tools, the approved issue, and my assignment. Explain the budget before starting a run.",
    },
};
let selectedRole = "owner";
let trigger;
let paused = reducedMotion.matches;
let gazeTimer;
let blinkTimer;
let blinkEnd;

for (const button of document.querySelectorAll("[data-role]")) {
    button.addEventListener("click", () => {
        selectedRole = button.dataset.role;
        trigger = button;
        const role = roles[selectedRole];
        document.querySelector("#setup-label").textContent = role.label;
        document.querySelector("#setup-title").textContent = role.title;
        document.querySelector("#setup-steps").replaceChildren(
            ...role.steps.map((text) => {
                const item = document.createElement("li");
                item.textContent = text;
                return item;
            }),
        );
        document.querySelector("#full-guide").href =
            `https://github.com/obselate/tokate/blob/main/README.md#${role.anchor}`;
        document.querySelector("#copy-status").textContent = "";
        document.querySelector("#prompt-fallback").hidden = true;
        dialog.showModal();
        document.body.classList.add("modal-open");
    });
}
document
    .querySelector(".close")
    .addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    if (
        event.target === dialog &&
        (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom)
    )
        dialog.close();
});
dialog.addEventListener("close", () => {
    document.body.classList.remove("modal-open");
    trigger?.focus();
});
document.querySelector("#copy-prompt").addEventListener("click", async () => {
    const prompt = roles[selectedRole].prompt;
    try {
        await navigator.clipboard.writeText(prompt);
        document.querySelector("#copy-status").textContent =
            "Copied. Paste it into your coding agent.";
    } catch {
        const fallback = document.querySelector("#prompt-fallback");
        fallback.hidden = false;
        fallback.value = prompt;
        fallback.focus();
        fallback.select();
        document.querySelector("#copy-status").textContent =
            "Select and copy the prompt below.";
    }
});
function animateEyes() {
    clearTimeout(gazeTimer);
    clearTimeout(blinkTimer);
    clearTimeout(blinkEnd);
    sun.classList.remove("blink");
    const stopped = paused || reducedMotion.matches || document.hidden;
    document.body.classList.toggle("paused", stopped);
    motionButton.textContent = reducedMotion.matches
        ? "Reduced motion"
        : paused
          ? "Resume animation"
          : "Pause animation";
    motionButton.setAttribute(
        "aria-pressed",
        String(paused || reducedMotion.matches),
    );
    motionButton.disabled = reducedMotion.matches;
    if (stopped) {
        pupils.forEach((pupil) => (pupil.style.transform = "translateX(0px)"));
        return;
    }
    let direction = 1;
    function gaze() {
        pupils.forEach(
            (pupil) =>
                (pupil.style.transform = `translateX(${direction * 8}px)`),
        );
        direction *= -1;
        gazeTimer = setTimeout(gaze, 3500 + Math.random() * 2500);
    }
    function blink() {
        sun.classList.add("blink");
        blinkEnd = setTimeout(() => sun.classList.remove("blink"), 170);
        blinkTimer = setTimeout(blink, 4800 + Math.random() * 6500);
    }
    gazeTimer = setTimeout(gaze, 2400);
    blinkTimer = setTimeout(blink, 3800);
}
motionButton.addEventListener("click", () => {
    paused = !paused;
    animateEyes();
});
reducedMotion.addEventListener("change", () => {
    paused = reducedMotion.matches;
    animateEyes();
});
document.addEventListener("visibilitychange", animateEyes);
animateEyes();
