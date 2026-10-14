# Labnote Assistant for Obsidian (labnoteo)

**Version 0.93.0**

[한국어](README.md)

A Markdown-based lab notebook for Obsidian for synthetic biology experiments on a biofoundry, with sample tracking, workflow checklists, unit operations, and optional LLM assistance.

This repository is the Obsidian port of the Labnote Assistant. It shares its platform-neutral parsing and domain logic with a companion VS Code extension, but is fully self-contained here.

## Features

- **Sample tracking**: A dedicated Samples sidebar view. Define, insert, and edit samples (DNA, RNA, Plasmid, and custom types) — including a sidebar search box and a **storage-location** field — and move them between local (note) and global scope. You can also **right-click in a note and choose *Add sample*** to create one and insert its reference.
- **Workflow checklists**: A Workflows sidebar view to create and manage numbered workflow notes and keep the table of contents in sync.
- **Unit operations**: Insert hardware/software unit operations from a bundled catalog, with automatic heading normalization and TOC updates.
- **Sample suggestions & CSV export**: Inline suggestions and highlighting for sample references while editing, plus CSV export of note tables (Excel-compatible UTF-8 with BOM).
- **Experiment status, discussion flag, issue markers**: Track each experiment's lifecycle (`planned` → `in-progress` → … → `completed`/`failed`) in frontmatter, and flag a note for team discussion either whole (*Toggle discussion flag*) or at a specific line (`@issue;<ID>;<topic>` marker). The next push opens a GitHub Issue.
- **LLM assistance (optional)**: Draft methods, summarize results, and extract samples via Ollama or OpenAI. The *Ask assistant* command lets the model call Labnote's own tools to reach a goal, confirming before any write. Its final answer is shown in a dialog and goes into the note only when you press `Insert into note`. The same tools are available to external MCP clients.
- **Research automation (optional)**: One command scaffolds GitHub Actions, zero-dependency scripts, and AI-agent rules (`AGENTS.md`) into your vault to validate notes, open Experiment ↔ Issue links, and draft a Living-Manuscript Wiki — all opt-in and human-reviewed. See [Research automation](#research-automation).

## Requirements

- Obsidian `1.5.0` or later (latest version recommended).
- For the GitHub automation: [git](https://git-scm.com/downloads) and a GitHub account. (Not needed if you only take notes.)
- Node.js `22+` for development.

## Installation

Follow these steps top to bottom. Steps 1–5 are enough to start taking notes; steps 6–8 are only needed for the GitHub automation.

**Prerequisites (for automation)** — install **git** and create a **GitHub account** first. On Windows, install [Git for Windows](https://git-scm.com/download/win); it also enables Claude Code's Bash tool. Verify with `git --version`.

1. **Install Obsidian** from [obsidian.md/download](https://obsidian.md/download) (Windows/macOS/Linux).
2. **Create a vault** — a single folder is your vault. This folder later becomes your Git repository, so put it somewhere you control.
3. **Turn on community plugins** — Settings → Community plugins → **Turn on community plugins** (this turns off Restricted Mode).
4. **Install Labnote Assistant via BRAT** (it is not in the community directory yet):
   1. In **Browse**, search for `BRAT`, install **Obsidian42 - BRAT** (by TfTHacker), and enable it.
   2. Run **`BRAT: Plugins: Add a beta plugin for testing (with or without version)`** from the command palette — searching `beta plugin` finds it (older BRAT shows it as `BRAT: Add a beta plugin for testing`).
   3. Enter `sblabkribb/labnoteo`, leave the version at **Latest version** with **Enable after installing the plugin** checked, and click **Add Plugin**.
   4. If needed, refresh Settings → Community plugins and confirm **Labnote Assistant** is enabled.
5. **Verify** — run **`Create experiment`** from the command palette; a note opens. That is all you need for note-taking. Run **`Open user guide`** for the researcher quick start.
6. **(Automation) Run `Setup research automation`** — it writes `.labnoteo/`, `.github/`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `QUICKSTART.md`, and `wiki-staging/` into the vault.
7. **(Automation) Connect an AI agent (Copilot)** — after step 6 so `AGENTS.md` exists. The simplest path on Windows is opencode, which Copilot downloads and manages for you. Do this before step 8 to let the agent make the first commit. See the **[Copilot agents guide](docs/COPILOT.md)** (Korean). Skip it if you only use manual git.
8. **(Automation) Create the repository and push** — after step 6 so `.gitignore` exists first:
   1. Create an **empty private** repository at [github.com/new](https://github.com/new) — do **not** add a README, `.gitignore`, or license, or the first push will be rejected. Copy its HTTPS URL.
   2. **Path A (recommended):** tell the connected agent, e.g. *"Initialize this folder as a git repo, set the hook, then commit everything and push to `<URL>`."* It follows `AGENTS.md` (sets `core.hooksPath`, no `--no-verify`).
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

**Why this order** — `.gitignore` (step 6) must precede the first push (step 8): once oversized raw data lands in Git history, nothing short of a history rewrite takes it back. The hook must be enabled before the first commit for the same reason, and the agent (step 7) connects after `AGENTS.md` exists but before the first commit so it can make that commit.

<details>
<summary><b>Manual install</b> (no auto-update)</summary>

1. Download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/sblabkribb/labnoteo/releases).
2. Create `.obsidian/plugins/labnoteo/` inside your vault and copy the three files into it.
3. Enable **Labnote Assistant** in Settings → Community plugins.

Obsidian reads the release's `versions.json` from the repository, so there is no need to copy it into a vault.
</details>

## Commands

| Command | Description |
|---|---|
| Insert date | Insert the current date |
| Insert date and time | Insert the current timestamp |
| Create experiment | Create a new `.labnote.md` experiment note |
| Change experiment status | Update the active experiment's `status` frontmatter via a picker |
| Toggle discussion flag | Turn the active experiment's `discuss` flag on/off, so the next push opens a GitHub Issue (requires Setup research automation) |
| Insert issue marker | Drop an `@issue;<ID>;<topic>` marker at the cursor (selection becomes the topic); each marker opens its own Issue (requires Setup research automation). If text follows the selection or the cursor is mid-line, the line is kept as is and the marker goes at its end; on a heading it goes on the line below, and inside a table it is not inserted |
| Create workflow | Create a numbered workflow note |
| Renumber workflows | Renumber an experiment folder's workflows from 001 without gaps, and list any workflow missing from the checklist. The `<note name>.labnote_tableN.csv` files made by `Export tables to CSV` move to the new number too (a CSV whose new name is taken stays put, with a notice) |
| Sync workflow checklist with folder | List moved-in or copied workflows in the README checklist and, after asking, remove entries whose file is gone. Entries whose label no longer matches the file name are shown as `old label → new label` and fixed after asking. Also on the README and experiment-folder right-click menus |
| Insert unit operation | Insert a unit operation from the catalog |
| Export tables to CSV | Export note tables to `<note name>.labnote_tableN.csv` next to the note. Rows are fitted to the header (extra cells dropped, missing ones left empty) and `<br>` in a cell becomes a line break. CSVs of tables the note no longer has are listed and moved to the trash after asking |
| Setup research automation | Scaffold GitHub Actions + scripts into the current vault (see [Research automation](#research-automation)) |
| AI: Draft Method section | Draft an experimental method with the configured LLM. Run inside a unit operation, it fills that unit operation's `#### Method` (asking first if it already has content); elsewhere it goes after the cursor's line |
| AI: Summarize results | Summarize results with the configured LLM, inserted after the cursor's line. With the cursor in the front matter or above the first heading, it is appended at the end of the note (the last section) |
| AI: Extract sample definitions | Extract samples from note text with the configured LLM. Unknown types are skipped, and an id that is not `<Type>-<number>` is replaced by a new one (the original is kept as the alias when there is none) |
| AI: Ask assistant (uses tools) | State a goal and let the model reach it with Labnote's tools (it also reads the start of the current note). The final answer opens in a dialog with `Insert into note`, `Copy`, and `Close` — nothing is added to the note on its own |
| Toggle MCP server | Start/stop the local MCP server (see [Copilot guide](docs/COPILOT.md)) |
| Open workflow view / Open sample view | Reveal the sidebar views |
| Open user guide | Open the researcher quick start (`QUICKSTART.md`), creating it in the vault if missing (no Setup research automation needed). Also a button at the top of the settings tab |

> Renaming a workflow file in the file explorer automatically reorders the README checklist to match the new number prefix; deleting one removes its checklist entry (samples are kept — only that note's usage record is dropped), and its leftover `.labnote_tableN.csv` files are moved to the trash after asking. If a rename breaks the `###_….labnote.md` format, you are warned and offered a fixed name; once the format is back (by accepting the offer or fixing it by hand), the checklist follows the file again. A workflow moved into another experiment folder is not listed automatically — you get a notice; run `Sync workflow checklist with folder` there. A renamed note takes its `_tableN.csv` files along, an entry whose label matched the old file name follows the new name, and so do the note's `title` and `## [ID name]` heading if they matched it (labels and titles you edited by hand are kept). `Sync workflow checklist with folder` finds note titles/headings and labels that no longer match their file names and fixes them after asking. A "Make a copy" duplicate (`….labnote 1.md`) asks for the copy's own alias in a box prefilled with the original's, then gives it the next number and updates its file name, note `title`, and `## [ID name]` heading together before listing it (cancelling changes nothing). `Insert workflow` (README right-click) creates a new workflow from the catalog.
>
> Experiment folder names must start with `###_` (e.g. `020_GFP`). If a rename drops the number, you are warned and offered the name with the old number back. Running a workflow command from a note in an unnumbered folder says the folder is not an experiment folder.

## Research automation

Beyond the notebook itself, labnoteo can turn your vault into a lightweight research-notes system on GitHub — note validation, Experiment ↔ Issue links, and a Living-Manuscript Wiki — without you writing any CI by hand. Run **Setup research automation** from the command palette to provision these assets into the current vault.

- **Large-file protection** — `check-large-files.mjs` + a pre-commit hook + `.gitignore` block oversized data before commit.
- **Validation** — `validate.mjs` + `validate.yml` check `status` values, duplicate experiment ids, and `@issue` marker format with folder-unique ids on every push.
- **Experiment ↔ Issue** — `issue-sync.mjs` + `experiment-issues.yml` open one thread Issue per `discuss: true`/`status: needs-review` experiment, plus one Issue per `@issue` marker across all `*.labnote.md` in the folder. Deterministic and idempotent.
- **AI agent rules** — `AGENTS.md`/`CLAUDE.md` govern a local AI agent's git, commit, Issue-signal, and Wiki-draft behavior.
- **Living-Manuscript Wiki (optional)** — `wiki-sync.yml` publishes human-reviewed `wiki-staging/` drafts to the GitHub Wiki.

The bundled scripts are **zero-dependency** Node ESM, so no `npm install` is needed in the vault. All server-side automation is **deterministic** (GitHub-hosted runners, no server-side LLM); AI judgments are made by a **local AI agent** following `AGENTS.md`, while issue creation and Wiki publishing stay solely with the server, so nothing is duplicated. Automation **never rewrites your notes**; `status` changes and scientific judgment stay with you.

See the generated `.labnoteo/SETUP.md` (admins) for the full asset table, prerequisites, and backfill procedure, and `QUICKSTART.md` (researchers) for day-to-day usage. `AGENTS.md` is [shared with Copilot](docs/COPILOT.md).

## Settings

**Samples** — toggle the Samples sidebar view, add custom sample types, and set the global sample folder (default `resources/labsamples`). Custom types may be Korean (`배지` gets `@배지` autocomplete and highlighting); use letters, digits and `_` only — a type with a space or `-` (`Cell Line`, `Cell-Line`) is not autocompleted. A sample created from a note at the vault root becomes a global sample whatever experiment you opened before, since that note's local folder is the global one (with the default folder), and you are told so.

**Workflows** — **Auto-sync unit operation TOC** reorders a workflow note's `Related Unit Operations` list to match heading order after edits, so moving a unit-operation block re-sorts the top-of-note TOC. Dragging a block in Obsidian's Outline view tidies the TOC and `---` separators right away, and dropping it onto another unit operation places it after that whole unit operation instead of splitting it. The cleanup is saved separately from the move, so undoing back to before the move may take two presses of Ctrl+Z. The TOC links follow GitHub's anchor rules (non-ASCII text kept, a repeated unit operation numbered `-1`, `-2`) so they jump to the right block when the note is viewed on GitHub; inside Obsidian, click the Outline view instead of the TOC links. On by default. **Auto-update last updated date** sets a lab note's (`*.labnote.md` in an experiment folder) front matter `last_updated_date` to today (Asia/Seoul) when you edit it in the editor, change it with `Change experiment status` or `Toggle discussion flag`, or the AI edits it. Each note changes at most once a day, and editing a workflow note also updates its experiment README, as does creating a workflow. Changes pulled with git and undo are ignored, and automatic tidying such as the checklist sync or renumbering does not change the date. A note whose date you edit by hand is left alone until Obsidian restarts. The date update is itself an undo step, so undoing the day's first edit may take one more Ctrl+Z. On by default.

**AI provider** — pick `none`, `ollama`, or `openai`; set the Ollama/OpenAI endpoint (separate fields so an OpenAI key never leaks to a local Ollama address), the model id (e.g. `qwen3`, `gpt-4o-mini`), and the API key (OpenAI-compatible only, never sent to Ollama).

> **Tool calling needs a model with function-calling support.** With Ollama, pick a model that advertises the `tools` capability (`qwen3`, `llama3.1`, …); one without it answers in prose instead.

**MCP server & Copilot agents** — to expose Labnote's tools to an external MCP client, or to hand commits/Issues/Wiki drafts to Copilot's agent mode, see the **[Copilot agents guide](docs/COPILOT.md)** (Korean).

## Development

This is an npm workspaces monorepo:

- `src/` — the Obsidian plugin, bundled to `main.js` at the repository root via esbuild. The plugin lives at the root because Obsidian's community directory reads `manifest.json` from there.
- `packages/labnoteo-core` — platform-neutral core logic (parsers, workflow/sample domain), consumed by the plugin. It must not import Node-only APIs; anything platform-specific goes behind a port (`LabnoteFs`, `LabnoteHost`).
- `automation/` — sources for the vault-scaffolded [Research automation](#research-automation) scripts. esbuild builds them (Stage 1) to zero-dependency `dist-automation/*.mjs` — reusing the same `@labnoteo/core` source as the plugin, so there is no drift — and embeds them (plus the workflow/AGENTS.md/Wiki templates) as strings inside `main.js` (Stage 2). This keeps a 3-file install self-sufficient; the *Setup research automation* command writes those strings out into the vault. Not every source here ships: `issue-gate.ts` and `wiki-propose.ts` are excluded from the build, since the local AI agent makes those judgments now (see `esbuild.config.mjs`); they are kept as sources for a possible opt-in path.
- `issue-sync` and `validate` must see the *same* markers, so both read a folder through `readMarkerSources` rather than reading a README directly — narrowing either one alone would mean opening issues for markers that were never validated, or the reverse.
- `tests/` — plugin-layer tests, plus a runtime stub for the `obsidian` package (which ships types only). Core tests live beside the code in `packages/labnoteo-core/src/__tests__/`.

```bash
npm install           # install all workspaces
npm run dev           # watch build
npm run build         # bundle the Obsidian plugin -> main.js
npm run typecheck     # typecheck core + plugin
npm test              # run all tests (vitest: core + plugin projects)
npm run sync:versions # propagate root version to packages, manifest, and READMEs
```

`npm run sync:versions -- --check` writes nothing and fails if any target has drifted from the root `package.json` version; CI runs it that way.

Every `LabnoteFs` implementation must pass the shared contract in `packages/labnoteo-core/src/__tests__/labnoteFsContract.ts`, which is where the atomicity guarantee behind `{Type}.json` is enforced.

`npm run record:fixtures` re-records the LLM response fixtures in `tests/fixtures/llm/` against a live provider — see that folder's README for why they exist and how to read their provenance.

## License

[Apache License 2.0](LICENSE) (c) 2026 Korea Biofoundry (KRIBB). Retain the [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) files when redistributing.
