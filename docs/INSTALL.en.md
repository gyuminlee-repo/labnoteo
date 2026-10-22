# Installation guide

[← Back to README](../README.en.md) · [Command reference](./REFERENCE.en.md) · [한국어](./INSTALL.md)

Follow these steps top to bottom. Steps 1–5 are enough to start taking notes; steps 6–8 are only
needed for the GitHub automation.

> The Korean [`INSTALL.md`](./INSTALL.md) covers the same path with a verification checkpoint after
> each step and more troubleshooting. Use it if you read Korean.

## Prerequisites (for automation)

Install **git** and create a **GitHub account** first. On Windows, install
[Git for Windows](https://git-scm.com/download/win); it also enables Claude Code's Bash tool.
Verify with `git --version`.

## 1. Install Obsidian

Download it from [obsidian.md/download](https://obsidian.md/download) (Windows/macOS/Linux). This
plugin needs Obsidian `1.5.0` or later; the latest stable release is recommended.

## 2. Create a vault

A single folder is your vault. This folder later becomes your Git repository, so put it somewhere
you control.

## 3. Turn on community plugins

Settings → Community plugins → **Turn on community plugins**. This turns off Restricted Mode.

## 4. Install Labnote Assistant via BRAT

It is not in the community directory yet, so a helper plugin fetches it from the GitHub releases.

1. In **Browse**, search for `BRAT`, install **Obsidian42 - BRAT** (by TfTHacker), and enable it.
2. Run **`BRAT: Plugins: Add a beta plugin for testing (with or without version)`** from the
   command palette — searching `beta plugin` finds it (older BRAT shows it as
   `BRAT: Add a beta plugin for testing`).
3. Enter `sblabkribb/labnoteo`, leave the version at **Latest version** with **Enable after
   installing the plugin** checked, and click **Add Plugin**.
4. If needed, refresh Settings → Community plugins and confirm **Labnote Assistant** is enabled.

<details>
<summary><b>Manual install</b> (no auto-update)</summary>

1. Download `main.js`, `manifest.json`, and `styles.css` from a
   [release](https://github.com/sblabkribb/labnoteo/releases).
2. Create `.obsidian/plugins/labnoteo/` inside your vault and copy the three files into it.
3. Enable **Labnote Assistant** in Settings → Community plugins.

Obsidian reads the release's `versions.json` from the repository, so there is no need to copy it
into a vault.
</details>

## 5. Verify

Run **`Create experiment`** from the command palette; a note opens. That is all you need for
note-taking. Run **`Open user guide`** for the researcher quick start, and see the
[command reference](./REFERENCE.en.md) for what each command does.

## 6. (Automation) Run `Setup research automation`

It writes `.labnoteo/`, `.github/`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `QUICKSTART.md`, and
`wiki-staging/` into the vault. See
[Research automation](../README.en.md#research-automation) for what each asset does and how updates
are applied.

## 7. (Automation) Connect an AI agent (Copilot)

Do this after step 6 so `AGENTS.md` exists, and before step 8 to let the agent make the first
commit. The simplest path on Windows is opencode, which Copilot downloads and manages for you. See
the **[Copilot agents guide](./COPILOT.md)** (Korean). Skip it if you only use manual git.

## 8. (Automation) Create the repository and push

Do this after step 6 so `.gitignore` exists first.

1. Create an **empty private** repository at [github.com/new](https://github.com/new) — do **not**
   add a README, `.gitignore`, or license, or the first push will be rejected. Copy its HTTPS URL.
2. **Path A (recommended):** tell the connected agent, e.g. *"Initialize this folder as a git repo,
   set the hook, then commit everything and push to `<URL>`."* It follows `AGENTS.md` (sets
   `core.hooksPath`, no `--no-verify`).
3. **Path B (manual git):**

   ```sh
   git init
   git config core.hooksPath .labnoteo/hooks   # enable the pre-commit hook BEFORE the first commit
   # macOS/Linux only: chmod +x .labnoteo/hooks/pre-commit
   git add .
   git commit -m "chore: initial vault"
   git remote add origin https://github.com/<user>/<repo>.git
   git branch -M main
   git push -u origin main
   ```

Both paths may pop up a GitHub sign-in (Git Credential Manager) on the first push — that is normal.

### Why this order

`.gitignore` (step 6) must precede the first push (step 8): once oversized raw data lands in Git
history, nothing short of a history rewrite takes it back. The hook must be enabled before the
first commit for the same reason, and the agent (step 7) connects after `AGENTS.md` exists but
before the first commit so it can make that commit.

## 9. (Optional) Configure an LLM provider

To draft methods and summarize results *inside* Obsidian, pick `Ollama` or an OpenAI-compatible
provider in Settings → **Labnote Assistant** → **AI provider** and fill in the endpoint and model.
The default `Disabled` leaves the AI commands inactive. This layer is separate from the Copilot
agent of step 7; see the [Copilot guide](./COPILOT.md#copilot-llm-설정) (Korean) for how the layers
differ.

---

Once installed, `QUICKSTART.md` (researchers, opened with `Open user guide`) covers day-to-day
usage, `.labnoteo/SETUP.md` (admins) covers repository management, and the
[printout scan guide](./SCAN.md) (Korean) covers printing worksheets and filing scans.
