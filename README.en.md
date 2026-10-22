# Labnote Assistant for Obsidian (labnoteo)

**Version 0.117.0**

[한국어](README.md)

A Markdown-based lab notebook for Obsidian for synthetic biology experiments on a biofoundry, with sample tracking, workflow checklists, unit operations, and optional LLM assistance.

This repository is the Obsidian port of the Labnote Assistant. It shares its platform-neutral parsing and domain logic with a companion VS Code extension, but is fully self-contained here.

## Quick start

1. **[Installation guide](docs/INSTALL.en.md)** — from installing Obsidian to the first push, in order.
2. **[Command reference](docs/REFERENCE.en.md)** — what each command does in detail: where it inserts, what it confirms, and how it handles file names, numbering and copies.
3. To hand commits, Issues and Wiki drafts to an AI agent, see the **[Copilot agents guide](docs/COPILOT.md)** (Korean).
4. To print worksheets, write on them, and file photos or scans of them back into notes, see the **[printout scan guide](docs/SCAN.md)** (Korean).
5. To see the features first, the **[help site](https://sblabkribb.github.io/labnoteo/en/)** has a short clip of each one (Korean and English).

## Features

- **Sample tracking**: A dedicated Samples sidebar view to define, insert, and edit samples (DNA, RNA, Plasmid, and custom types) and move them between local (note) and global scope. Typing `@` autocompletes references and highlights them; an ID that is in no registry gets a red wavy underline, and an alias that no longer matches the registry gets an orange dotted one. A used-up sample stays registered with *Mark as discarded* instead of being deleted. → [Samples](docs/REFERENCE.en.md#samples)
- **Workflow checklists**: A Workflows sidebar view to create numbered workflow notes and keep the README table of contents in sync. Its **Experiments** section at the top groups the vault's experiments by status, project, or discussion flag, with a search box and full keyboard control (↑↓→←, Enter, Shift+F10). → [Workflows](docs/REFERENCE.en.md#workflows)
- **Unit operations**: Insert hardware/software unit operations from a bundled catalog, with automatic heading normalization and TOC updates. → [Insert unit operation](docs/REFERENCE.en.md#insert-unit-operation)
- **Sample suggestions & CSV export**: Inline suggestions and highlighting for sample references while editing, plus CSV export of note tables (Excel-compatible UTF-8 with BOM). → [Export tables to CSV](docs/REFERENCE.en.md#export-tables-to-csv)
- **Experiment status, discussion flag, issue markers**: Track each experiment's lifecycle (`planned` → `in-progress` → … → `completed`/`failed`) in frontmatter, and flag a note for team discussion either whole (*Toggle discussion flag*) or at a specific line (`@issue;<ID>;<topic>` marker). The next push opens a GitHub Issue.
- **Note IDs, QR worksheets, scan filing (desktop)**: Every lab note gets a unique ID (`labnote_id: LN-7K3M9QX2`), and a workflow note's unit operations print as **experiment worksheets** with a QR code on every page. Write on them, then put phone photos or scanner output (images, PDF, zip) in a **PC scan folder** or drop them on a window: the QR code is read and the image is filed in a `#### Worksheet scans` section at the end of that unit operation. Sending them to your own Slack bot by DM works too (optional). → [printout scan guide](docs/SCAN.md) (Korean)
- **partbank integration (optional)**: Search partbank's parts, plasmids, primers and strains from the `@` autocomplete and register them as samples, read their storage location, and open them in partbank. A whole catalog can be downloaded to pick from offline. The API key is kept on the PC, never in the vault. → [partbank](docs/REFERENCE.en.md#partbank)
- **LLM assistance (optional)**: Draft methods, summarize results, and extract samples via Ollama or OpenAI. The *Ask assistant* command lets the model call Labnote's own tools to reach a goal, confirming before any write. The same tools are available to external MCP clients. → [AI](docs/REFERENCE.en.md#ai)
- **Research automation (optional)**: One command scaffolds GitHub Actions, zero-dependency scripts, and AI-agent rules (`AGENTS.md`) into your vault to validate notes, open Experiment ↔ Issue links, and draft a Living-Manuscript Wiki — all opt-in and human-reviewed. → [below](#research-automation)

## Requirements

- Obsidian `1.5.0` or later (latest version recommended).
- For the GitHub automation: [git](https://git-scm.com/downloads) and a GitHub account. (Not needed if you only take notes.)
- Node.js `22+` for development.

## Installation

The step-by-step path from installing Obsidian and preparing git and a GitHub account through
community plugins, automation, and the first push is in the
**[installation guide (docs/INSTALL.en.md)](docs/INSTALL.en.md)**. In short:

1. (For automation) Install git and prepare a GitHub account.
2. Install Obsidian → create a vault → turn on community plugins.
3. Install and enable this plugin (`sblabkribb/labnoteo`) with **BRAT**.
4. (Automation only) Run *Setup research automation* → (optional) connect a Copilot agent → create an empty private GitHub repository and make the first commit and push, either through the agent or with manual git.

## Commands

Under a Korean UI the command palette shows each name as `Korean (English)` (e.g. `실험 생성 (Create experiment)`), so either language finds it; an English UI shows the English name alone.

| Command | What it does |
| --- | --- |
| Insert date | Insert today's date at the cursor (in the front matter and `#### Meta`, only into empty values) |
| Insert date and time | Insert the current timestamp at the cursor |
| Create experiment | Create a new `.labnote.md` experiment note and its numbered experiment folder |
| Change experiment status | Change an experiment's `status` frontmatter through a picker (also on the workflow view's right-click menu) |
| Toggle discussion flag | Turn an experiment's `discuss` flag on or off, so the next push opens a GitHub Issue |
| Insert issue marker | Drop an `@issue;<ID>;<topic>` marker at the cursor — each marker opens its own Issue |
| Create workflow | Create a numbered workflow note from the catalog and list it in the checklist |
| Renumber workflows | Renumber an experiment folder's workflows from 001 without gaps |
| Sync workflow checklist with folder | Match the checklist to the folder and fix labels, titles and experimenters that drifted, after asking |
| Insert unit operation | Insert a unit operation from the catalog into a workflow note and refresh the TOC |
| Update catalogs | Bring the vault's `resources/workflows/` catalogs up to this plugin version, keeping values the lab edited |
| Export tables to CSV | Export the note's tables to `<note name>.labnote_tableN.csv` (Excel-compatible UTF-8 with BOM) |
| Setup research automation | Scaffold GitHub Actions + scripts into the current vault (see [Research automation](#research-automation)) |
| AI: Draft Method section | Draft a unit operation's `#### Method` with the configured LLM |
| AI: Summarize results | Summarize results with the configured LLM, wrapped in a callout |
| AI: Extract sample definitions | Find samples in the note text and register them (the note body is not changed) |
| AI: Ask assistant (uses tools) | State a goal and let the model reach it with Labnote's tools — every write is confirmed first |
| Toggle MCP server | Start/stop the local MCP server (see [Copilot guide](docs/COPILOT.md)) |
| Open workflow view / Open sample view | Reveal the sidebar view and move focus into its list |
| Open sample definition | Open the definition window for the sample under the cursor, or one picked by search |
| Insert sample list of this experiment | Insert this experiment's samples as a Markdown table at the cursor |
| Download partbank catalog | Download your own partbank items as product catalog files in the global sample folder |
| Refresh storage locations from partbank | Read the storage location of every partbank-linked sample again and store the changes after confirming |
| Show note barcode | Show the note's ID and QR code in a window, giving it an ID first if it has none |
| Assign note ID | Give a note without one a `labnote_id` |
| Print experiment worksheet | Print the chosen unit operations as worksheets with a QR code on every page (A4 or Letter) |
| Print whole note with barcodes | Print the whole note split into pages, with a QR code on each |
| Import scanned pages | Drop photos, PDFs or zips to file them in their notes by QR code |
| Process scan folder now | Process the PC scan folder set in settings right away (desktop only) |
| Assign unmatched scans | File the pages whose QR code could not be read by picking the note and unit operation |
| Open user guide | Open the researcher quick start (`QUICKSTART.md`), creating it in the vault if missing |

> **What each command does in detail** — where it inserts, what it confirms before writing, and how
> it handles file names, numbering, moves and copies — is in the
> **[command reference](docs/REFERENCE.en.md)**. See in particular
> [Renaming, moving and copying notes](docs/REFERENCE.en.md#renaming-moving-and-copying-notes) and
> [Experiment folders](docs/REFERENCE.en.md#experiment-folders).

## Research automation

Beyond the notebook itself, labnoteo can turn your vault into a lightweight research-notes system on GitHub — note validation, Experiment ↔ Issue links, and a Living-Manuscript Wiki — without you writing any CI by hand. Run **Setup research automation** from the command palette to provision these assets into the current vault.

- **Large-file protection** — `check-large-files.mjs` + a pre-commit hook + `.gitignore` block oversized data before commit.
- **Validation** — `validate.mjs` + `validate.yml` check `status` values, duplicate experiment ids, duplicate note IDs (`labnote_id`), and `@issue` marker format with folder-unique ids on every push.
- **Experiment ↔ Issue** — `issue-sync.mjs` + `experiment-issues.yml` open one thread Issue per `discuss: true`/`status: needs-review` experiment, plus one Issue per `@issue` marker across all `*.labnote.md` in the folder. Deterministic and idempotent.
- **AI agent rules** — `AGENTS.md`/`CLAUDE.md` govern a local AI agent's git, commit, Issue-signal, and Wiki-draft behavior.
- **Living-Manuscript Wiki (optional)** — `wiki-sync.yml` publishes human-reviewed `wiki-staging/` drafts to the GitHub Wiki.

The bundled scripts are **zero-dependency** Node ESM, so no `npm install` is needed in the vault. All server-side automation is **deterministic** (GitHub-hosted runners, no server-side LLM); AI judgments are made by a **local AI agent** following `AGENTS.md`, while issue creation and Wiki publishing stay solely with the server, so nothing is duplicated. Automation **never rewrites your notes**; `status` changes and scientific judgment stay with you.

**Updates** — after a plugin update, Obsidian brings the installed files up to the new version when it starts and tells you which ones changed. Each kind of file is handled differently.

- **Files you have not edited since they were installed** (the `.labnoteo/` scripts and `SETUP.md`, the `.github/` workflows, …) — replaced outright.
- **`AGENTS.md` and `QUICKSTART.md`** — only their managed block (`<!-- BEGIN labnoteo (managed) -->` to `END`) is refreshed. A block you edited is not replaced automatically but listed, and running *Setup research automation* again asks before replacing it.
- **`.gitignore` and `CLAUDE.md`** — only gain missing lines.
- **Files you edited, and files missing from the vault** — left alone and only listed (once per new version), so run *Setup research automation* again then.
- **`wiki-staging/` drafts** — never changed automatically.

Which template each file was matched to is recorded in `.labnoteo/installed.json`; commit it along with the rest. In a vault without that record (set up before 0.95.0), files still exactly as an earlier version wrote them, and the `.labnoteo/scripts/*.mjs` bundles, are updated automatically as well. Server-side behavior changes only once the updated files are committed and pushed.

Your lab's own rules in `QUICKSTART.md` survive updates when written **below** the managed block. A `QUICKSTART.md` created before 0.99.0 is switched to this form on startup if you never edited it; an edited one is only listed, and running *Setup research automation* again switches it after you confirm (the edits are lost then, so copy them out first).

**Attachment location** — after *Setup research automation*, if Obsidian's default location for new attachments is still the vault root, you are asked whether to switch it to `./images` (an images folder next to the note, which for a lab note is the experiment's `images/`). It is the same as changing Obsidian's Settings → Files and links → Default location for new attachments.

See the generated `.labnoteo/SETUP.md` (admins) for the full asset table, prerequisites, and backfill procedure, and `QUICKSTART.md` (researchers) for day-to-day usage. `AGENTS.md` is [shared with Copilot](docs/COPILOT.md).

## Settings

**Samples**

- **Sample tracking**: whether autocomplete, highlighting and `{Type}.json` registry sync are on (reload to apply). `sample_tracking: 'no'` in an experiment README's front matter turns them off for that experiment's notes only.
- **Custom sample types**: types in addition to the built-ins. Korean types (`배지`) get `@배지` autocomplete. Use letters, digits and `_` only — a name with a space or `-`, or one that differs from an existing type only in letter case, is not saved. A `_` works between ASCII letters and digits (`Cell_Line`); next to other letters it turns the name italic in the reading view, so such a name is not saved either and the joined-up form (`무세포용해물`) is suggested.
- **Global sample folder**: the vault-global sample folder (default `resources/labsamples`). After you change it and close settings, you are asked whether to move the samples left in the old folder.

**partbank**

- **partbank server** / **partbank desktop app**: an address, an API key and a `Test connection` button for each. The key is kept on this PC only, never in the vault, so enter it once per PC. The desktop connection is hidden on mobile.
- **Connection to search**: which connection the autocomplete search and the catalog download use (default `partbank server`). A link made through the desktop app only means something on that PC, so a vault shared with the lab should use the server.

See [partbank](docs/REFERENCE.en.md#partbank) for the details.

**Workflows**

- **Auto-sync unit operation TOC**: reorders a workflow note's `Related Unit Operations` list to match heading order after edits. Turned off, the order is left as you arranged it but the names and links still follow the headings. The TOC links follow GitHub's anchor rules so they jump to the right block when the note is viewed on GitHub; inside Obsidian, use the Outline view instead. On by default.
- **Auto-update last updated date**: sets a lab note's (`*.labnote.md`) front matter `last_updated_date` to today (Asia/Seoul) when you edit it. Each note changes at most once a day, and editing a workflow note also updates its experiment README. Changes pulled with git and automatic tidying are ignored. On by default.

**Barcode & scans**

- **Worksheet paper size**: A4 or Letter (also changeable in the print window).
- **Scan folder** and **Scan folder mode** (desktop only): the PC folder photos and scans arrive in, and how it is treated (a **Dedicated folder** or a **Shared folder**). These values do not sync with the vault's settings; they are kept per PC and per vault, so set the folder on one PC only.
- **Unmatched scans**: how many pages wait to be assigned, with an **Assign unmatched scans** button.
- **Stored scan size**, **Stored scan quality** and **Scan width in notes**: the long edge (default 2400 px) and JPEG quality (default 85%) of stored scans, and the thumbnail width in notes (default 200 px; 0 shows them full size).
- **Slack scans (optional)**: file photos sent to your own Slack bot by DM. The token stays on this PC; link only one PC.

See the [printout scan guide](docs/SCAN.md) (Korean) for each setting in detail and for every way in (Google Drive, KakaoTalk, OneDrive, email, office scanners, Slack). `_labnote-scans/` (the unmatched queue) is excluded from commits by the research automation's `.gitignore`; an existing vault picks this up when *Setup research automation* is run again after the plugin update.

**AI provider**

- **Provider**: `Disabled`, `ollama`, or `openai`. The plugin talks to the provider directly.
- **Ollama endpoint** / **OpenAI endpoint**: the base URL. The fields are separate so an OpenAI key never leaks to a local Ollama address. Written without `http://` or `https://`, as in `localhost:11434`, it gets `http://` when connecting.
- **Model**: the model id, e.g. `qwen3`, `gpt-4o-mini`.
- **API key**: OpenAI-compatible providers only — never sent to Ollama.

When an AI request fails, the notice names the cause and the setting to fix: the endpoint when the server cannot be reached, the API key on 401/403, the model when it is not found, and the endpoint path (server address only, without `/v1` or `/api`) on any other 404; an endpoint that is not an `http://` or `https://` address (a typo such as `htp://`) gets told how to write it. The original error stays in the developer console (Ctrl+Shift+I, or Cmd+Option+I on macOS).

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
