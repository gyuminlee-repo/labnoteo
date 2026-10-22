# Command reference

[← Back to README](../README.en.md) · [Installation](./INSTALL.en.md) · [Printout scan guide](./SCAN.md) (Korean)

What each command does in detail: where it inserts, what it asks before writing, and how it
handles file names, numbering and copies. The [README](../README.en.md#commands) lists the same
commands with a one-line summary each.

Under a Korean UI the command palette shows each name as `Korean (English)` (e.g.
`실험 생성 (Create experiment)`), so either language finds it; an English UI shows the English
name alone.

> Korean readers: [`QUICKSTART.md`](../automation/templates/QUICKSTART.md) covers the same ground
> in more depth, including an English/Korean command table and the right-click-only features.

## Dates

### Insert date

Insert the current date. Inside the front matter it only fills a line with an empty value such as
`end_date: ''`; on a line that has a value it inserts nothing and warns. On an empty
`Start_date`/`End_date` line of a unit operation's `#### Meta` it fills that value (with a value
already there, it points to the 📅 picker).

### Insert date and time

Insert the current timestamp. The front matter rule is the same as Insert date.

## Experiments

### Create experiment

Create a new `.labnote.md` experiment note.

- As you type the title, it shows how many characters go into the folder name (`n/60`) and turns
  the warning colour past 60. Creating is not blocked: only the title part of the folder name is
  cut at 60, and the README title keeps it all.
- On Windows, it warns when the path including the vault folder reaches 260 characters.

### Change experiment status

Update the active experiment's `status` frontmatter via a picker.

- Also on an experiment's right-click menu in the workflow view, where it changes that experiment
  (the picker title and notice name the experiment folder).
- Picking `completed` while checklist workflows are unchecked, or while workflow notes have an
  empty `end_date`, shows the counts and asks first.

### Toggle discussion flag

Turn the active experiment's `discuss` flag on or off, so the next push opens a GitHub Issue
(requires Setup research automation).

- Run from a workflow note, it still changes that experiment's README, and the notice says so.
- Also on an experiment's right-click menu in the workflow view, where it changes that experiment;
  flagged experiments show a speech-bubble icon.
- Editing the front matter by hand, `yes`, `y`, `on`, `1`, `예` and `네` also turn it on, besides
  `true`.

### Insert issue marker

Drop an `@issue;<ID>;<topic>` marker at the cursor (the selection becomes the topic); each marker
opens its own Issue (requires Setup research automation).

- With nothing selected it asks for the topic in a box prefilled with the sentence on the cursor's
  line; leaving it empty or cancelling inserts nothing.
- If text follows the selection, the selection starts partway into the line's text, or the cursor
  is mid-line, the line is kept as is and the marker goes at its end. Only a selection of one
  line's whole text is replaced by the marker.
- A multi-line selection is not folded into one line: the marker goes at the end of its last line,
  with list marks left out of the topic.
- On a heading it goes on the line below. Inside a table, the front matter or a code block
  (including code indented four spaces after a blank line) it is not inserted.
- Markers inside code blocks open no Issue and are not validated.

## Workflows

### Create workflow

Create a numbered workflow note.

- Under a Korean UI the catalog is also searchable by Korean names and shows Korean descriptions
  (as does Insert unit operation; words of the English description still match, and items a lab
  edited or added show the vault's English description).
- A word-ending `+` or `-` becomes `_plus`/`_minus` in the file name (`IND+` → `IND_plus`), and
  the `ID_name_alias` part after the number is cut at 80 characters. The note's title and alias
  stay whole; file names made at 100 characters up to 0.103.0 are left as they are.
- The alias prompt says what a workflow is and shows the chosen item's description. As you type it
  counts the characters that go into the file name (`n/room left`, which differs per workflow),
  turning the warning colour past it. Saving is not blocked.
- On Windows, it warns when the path including the vault folder reaches 260 characters.

### Renumber workflows

Renumber an experiment folder's workflows from 001 without gaps, and list any workflow missing
from the checklist. The `<note name>.labnote_tableN.csv` files made by `Export tables to CSV` move
to the new number too; a CSV whose new name is taken stays put, with a notice.

### Sync workflow checklist with folder

List moved-in or copied workflows in the README checklist and, after asking, remove entries whose
file is gone. Also on the README and experiment-folder right-click menus.

- A workflow moved into a subfolder of the experiment (`images/` …) is not removed but moved back
  to the experiment folder after asking.
- Entries whose label no longer matches the file name are shown as `old label → new label` and
  fixed after asking. Duplicate entries for the same workflow are reduced to one after asking, and
  labels with brackets are fixed so they show as links.
- A link Obsidian rewrote to a vault path such as `labnote/<experiment>/…` because another
  experiment uses the same file name (or one already broken into `./labnote/<experiment>/…`) is
  set back to `./<file name>` with its checkmark kept. Renaming the file fixes it too.
- Notes whose `experimenter` differs from the README `author` are updated after asking. A finished
  unit operation, one with an `End_date`, keeps its experimenter, and the dialog lists its empty
  lines apart for you to fill in.
- Local samples the notes use but that only another experiment's registry holds are brought into
  this experiment after asking.

### Insert unit operation

Insert a unit operation from the catalog, asking for an alias that tells runs or conditions apart
and adding it to the heading and TOC. Leave it empty for none; the prompt says what a unit
operation is, shows the chosen item's description and counts the characters, with no limit since
the alias goes into no file name.

- It goes after the unit-operation block the cursor is in, before the first block when the cursor
  is between the TOC and it, and at the end elsewhere. The notice says where.
- Run where it can't go (a README, a note without the number, a subfolder of the experiment, an
  experiment moved into a subfolder of `labnote/`, …), it says what is wrong before the list opens.
- A HW unit operation whose catalog entry names its equipment lists it in `#### Equipment`, not in
  `#### Meta`.

### Update catalogs

Bring the vault's catalogs in `resources/workflows/` up to the ones bundled with this plugin
version.

- New items are added, names and descriptions the lab never touched take the new text, and values
  the lab edited stay (listed apart in the dialog).
- The changes are listed and applied after you confirm; items the lab deleted are not brought back.
- A renamed item keeps its old name in the workflow notes and checklists already made; the dialog
  says how many notes use it.
- When a plugin update changes the bundled catalogs, you are told once on startup. In a team, one
  person runs it and commits.

This command is about the workflow catalogs. The sample "product catalogs" of
[partbank](#partbank) are a different thing.

## Tables

### Export tables to CSV

Export note tables to `<note name>.labnote_tableN.csv` next to the note.

**Naming**

- With ten tables or more the number has as many digits as the table count (`table01` … `table11`)
  so the files sort in table order. Existing CSVs such as `table1.csv` take the new name once the
  overwrite prompt passes, with a notice to update the paths in any analysis script. The names go
  back to `table1` when the note drops to nine tables or fewer.

**Cell contents**

- Rows are fitted to the header: extra cells are dropped, missing ones left empty. `<br>` in a cell
  becomes a line break.
- Bold, italic and code marks are dropped, and struck-through text is dropped with its marks
  (`~~0.10~~ 0.12` → `0.12`).
- A cell starting with `=` or `@`, or with a `+`/`-` that is not part of a number, gets a leading
  tab so Excel shows it as typed instead of evaluating it. Numbers like `-80` are left alone. In a
  column where such a cell appears, like `+/-`, a lone `+` or `-` gets the tab too.
- Opening the CSV by double-clicking it in Excel turns `3-1`, `1/2` and `SEPT9` into dates and
  drops the leading zero of `007`. The file holds the text as typed; Excel is what changes it.
  Open it with Data → From Text/CSV and set those columns to Text. When a table has such cells,
  the export notice says so with an example.

**Which tables are exported**

- Tables inside callouts and quotes (`> | … |`) are exported.
- Tables inside code blocks are skipped, including code indented four spaces after a blank line. A
  table indented under a list item still counts.
- A table written right under a line of text, with no blank line between, shows as text in the
  reading view, so it is skipped too and the notice says how many. A table right under a heading, a
  thematic break or a callout title is exported.
- A table inside a comment (`<!-- … -->` or `%% … %%`) is not shown in the reading view at all, so
  it is neither exported nor counted. The notice keeps this apart from the case above.

**Overwriting**

- A table whose values or header alone changed is overwritten without asking.
- When an added or removed table would put a different table into an existing CSV, or the header
  and values both changed, the reason is shown and it is overwritten only after asking. Removing a
  table while also editing the values of the remaining ones goes unnoticed.
- When tables with the same header trade places, the prompt adds `(2 rows → 1 rows)` or the first
  row that differs.
- The completion notice counts the files written and the ones left unchanged separately and shows
  the folder and file names, with a hint that the file explorer hides them while Obsidian's "Show
  all file types" setting is off.
- CSVs of tables the note no longer has are listed and moved to the trash after asking.

## Samples

### Open sample definition

Open the definition window for the sample reference under the cursor (on its ID or on the alias of
`ID;alias`), or else one picked by searching `ID | alias | scope`. The window edits, deletes, moves
between Local and Global, and changes the type.

- With no note open only Global samples are listed, and when the note's sample tracking is off it
  only shows a notice.
- From a note at the vault root, a Global sample shows scope `global` with no move button, since
  that note has no Local registry of its own.

### Insert sample list of this experiment

Insert, at the cursor, a Markdown table of every Local sample of this experiment and the Global
samples the note refers to, with ID, alias, description (the first one), location, scope, and
discarded columns, leaving the cursor below the table. With a Live Preview table cell focused it
goes below that table. Use `Export tables to CSV` for a CSV.

References the note makes that no registry has are left out of the table, and the notice names them.

## partbank

Register parts, devices, plasmids, primers, molecules and strains kept in
[partbank](https://partbank.kbiofoundry.kr) as samples, read where they are stored, and open them
in partbank. Nothing below appears until a connection is set up in the plugin settings, so a vault
that does not use partbank keeps the menus it always had.

### Connections

Two connections, each with an address, an API key and a `Test connection` button that answers with
the account name.

- **partbank server** — your lab's server (default `https://partbank.kbiofoundry.kr`). Its links
  work for the whole team, so **use this one in a shared vault**.
- **partbank desktop app** — the app running on this PC (default `http://127.0.0.1:47830`). A link
  made through it only means something on that PC; for everyone else the location refresh and the
  open action say so. The connection is hidden on mobile.

Issue the key in partbank under Profile → API Keys (365 days at most). It is kept on this PC and
this vault only, never written into the vault, so each PC needs its own. With both connections set
up, **Connection to search** picks the one the autocomplete search and the catalog download use.
The key is only ever sent to the address in the settings — never to an address stored in a sample
or in a link. A server address on plain `http://` warns that the key travels in the clear.

### Search partbank

Typing `@dna`, `@plasmid`, `@primer` (or `@sample`) puts **Search partbank** at the bottom of the
autocomplete menu, which opens a search window prefilled with whatever was typed after `;`. From
two characters on it searches after a short pause and lists each hit with its name, KID, kind and
whether it is yours, shared with you, or public. Picking one reads the item and its storage
location, registers it, and inserts `ID;alias`.

- **The type you typed wins.** Only when it is open (`@sample`, a link, a catalog) does the
  partbank kind decide: part and device → `DNA`, plasmid → `Plasmid`, primer → `Primer`,
  molecules by their kind (`protein`/`enzyme` → `Protein`, `rna` → `RNA`, `dna` → `DNA`, the rest
  → `Reagent`).
- **Strains** have no built-in type, so they use a custom type `Strain`, which you are asked to add
  when it does not exist. Decline and the strain is not registered.
- It registers where any other sample would (the experiment's Local registry, or Global outside an
  experiment). **An item already registered** is not registered twice: its existing ID is inserted
  instead, looked up in this experiment, then Global, then the product catalogs. The KID is kept
  with the link rather than as the sample ID, and shows in the sample definition window.

### Refresh storage location from partbank

In the sample view's context menu and in the definition window. It reads the location as
`storage / box / position` and stores it after showing the change once.
**Refresh storage locations from partbank** (command palette) does every linked sample at once,
listing only what changes as `old → new`; an entry that would become empty is unchecked by default
so a hand-written location is not wiped. Because the value is stored, it stays visible offline and
in the sample list table and search.

partbank only reports the stock **the calling account can see**, so the same vault can end up with
different values depending on who refreshed.

### Open in partbank

In the same two places. A server link opens in the browser; a desktop link opens the desktop app
(starting it if it is closed) through its own `partbank://` scheme. A sample linked to the app on
another PC says so instead.

### Download partbank catalog

Download the items in your own workspace on the default connection into the global sample folder
as `{Type}_partbank-web.json` (or `-desktop`), which the autocomplete then offers under
`{Type} catalog search` without any searching. Downloading again keeps the sample ID each item
already had and writes the file sorted by KID, so the git diff stays small. Items with the same
name within a file get ` (KID)` after the alias. Items other people share with your groups are
not included; register those through [Search partbank](#search-partbank). It stops with a notice
when no global sample folder is set. This is not the workflow [Update catalogs](#update-catalogs).

### Send to labnoteo

The detail screens in partbank have a **labnoteo로 보내기** button that opens Obsidian and asks
whether to register that item, letting you switch the destination to Global there. Links naming an
address that is not in the settings are refused. After registering, `ID;alias` goes to the cursor
of an open note after asking, or to the clipboard.

## Barcodes and scans

### Show note barcode

Show the note's ID and QR code in a window (`Copy ID`, and `Print experiment worksheet` for a
workflow note), giving the note an ID first if it has none. Also the QR icon at the top of a lab
note (`*.labnote.md`).

### Assign note ID

Give a note without one a `labnote_id`. This is not a content change, so `last_updated_date` stays.
When another note has the same ID, a new one is given after asking. Front matter that cannot be
read is left unchanged, with a notice.

### Print experiment worksheet

Pick a workflow note's unit operations (lab ones preselected) and print them as worksheets with a
QR code in two corners of every page; A4 or Letter. Method steps keep the numbers they have in the
note, lines indented under a step print below it, and pipe tables print as tables. Sections with
nothing in them are left as ruled writing space, Method and Results & Discussions widest. When
printing from Obsidian does not work, it opens in the browser. See the
[printout scan guide](./SCAN.md#2-기록지-출력) (Korean).

### Print whole note with barcodes

Print the whole note split into pages, with a QR code on each. READMEs too.

### Import scanned pages

Drop photos, PDFs or zips to file them in their notes by QR code, then show the results (open note,
undo, delete earlier scan). Also the scan icon in the left ribbon.

### Process scan folder now

Process the PC scan folder set in settings right away (desktop only).

### Assign unmatched scans

Look at the pages whose QR code could not be read (`_labnote-scans/unmatched/`) as thumbnails and
file each by choosing the note, unit operation, and page, or delete it.

## AI

### AI: Draft Method section

Draft an experimental method with the configured LLM.

- Run inside a unit operation, it fills that unit operation's `#### Method`, asking first if it
  already has content. Run elsewhere, it asks which of the note's unit operations to fill.
- In a note without unit operations, the front matter and heading lines the model added are dropped
  and the draft goes after the cursor's line.
- It goes in only if that note is still open when the reply arrives; if you moved to another note,
  the reply opens in the answer dialog (return to the note and press `Insert into note`, or `Copy`).
  A note that was only renamed meanwhile is still the same note, so the reply goes in.

### AI: Summarize results

Summarize results with the configured LLM, wrapped in a `> [!note] AI summary (model, date)`
callout and inserted after the cursor's line.

- With the cursor in the front matter or above the first heading, it is appended at the end of the
  note (the last section).
- Moving to another note while waiting opens the answer dialog, as for the Method draft.
- The summary and the Method draft ask the model to write in Obsidian's interface language.

### AI: Extract sample definitions

Extract samples from note text with the configured LLM.

- Unknown types are skipped, and an id that is not `<Type>-<number>` is replaced by a new one (the
  original is kept as the alias when there is none).
- A storage location the text gives goes into the sample's location field, and the notice says how
  many were created without one.
- IDs already registered, samples whose type and alias already exist (compared after characters
  such as `;` and `:` are replaced), samples of the same type and description when neither has an
  alias, and IDs the note already refers to are skipped. The notice counts new and skipped samples
  separately.

### AI: Ask assistant (uses tools)

State a goal and let the model reach it with Labnote's tools; it also reads the start of the
current note.

- The final answer opens in a dialog with `Insert into note`, `Copy`, and `Close` — nothing is
  added to the note on its own.
- With no answer and no tool called, it says the request may be outside the tools it can use.
- The end notice counts changes made, lookups, writes you denied, and failed calls, and says when
  nothing in the vault changed.

## Views and the rest

### Toggle MCP server

Start or stop the local MCP server. See the [Copilot guide](./COPILOT.md) (Korean).

### Open workflow view / Open sample view

Reveal the sidebar view and move focus into its list; arrow keys move, →← expand and collapse,
Enter opens, and Shift+F10 or the menu key opens the right-click menu.

### Setup research automation

Scaffold GitHub Actions and scripts into the current vault. See
[Research automation](../README.en.md#research-automation).

### Open user guide

Open the researcher quick start (`QUICKSTART.md`), creating it in the vault if missing. No Setup
research automation needed. Also a button at the top of the settings tab.

## Inserting while in reading view

A command that inserts at the cursor (Insert unit operation, Insert sample list of this experiment,
a sample reference, AI drafts and summaries, …) run on a note in reading view switches it to
editing view first, inserts near the end of the note, and says so. A unit operation goes after the
last block.

When a sample's alias or type changes, a note open only in reading view is fixed in its file and
its view is left as it is.

## Renaming, moving and copying notes

### Renaming a workflow file

- Renaming a workflow file in the file explorer automatically reorders the README checklist to
  match the new number prefix.
- A renamed note takes its `_tableN.csv` files along. An entry whose label matched the old file
  name follows the new name, and so do the note's `title` and `## [ID name]` heading if they
  matched it. Labels and titles you edited by hand are kept.
- If a rename breaks the `###_….labnote.md` format, you are warned and offered a fixed name; once
  the format is back (by accepting the offer or fixing it by hand), the checklist follows the file
  again.
- Changing only the catalog ID in a workflow file name, so that it no longer matches the note's
  `## [ID name]`, warns and offers the old name back.
- Renaming or moving an experiment's `README.labnote.md` warns and offers the old name back.
- `Sync workflow checklist with folder` finds note titles, headings and labels that no longer match
  their file names and fixes them after asking.

### Deleting a workflow file

Deleting one removes its checklist entry. Samples are kept — only that note's usage record is
dropped — and its leftover `.labnote_tableN.csv` files are moved to the trash after asking.

### Moving to another folder

- A workflow moved into another experiment folder is not listed automatically; you get a notice.
  Run `Sync workflow checklist with folder` there. `Insert workflow` (README right-click) creates a
  new workflow from the catalog, so do not use it to register a moved file.
- If the moved note uses Local samples of its old experiment, you are asked whether to bring them
  into the new experiment's registry: copied if other notes in the old experiment still use them,
  moved otherwise. When they would be copied, you choose between bringing copies and moving those
  samples to Global while bringing the rest.
- Moving a note to another folder takes its `_tableN.csv` files along and says so. A CSV whose name
  is taken there stays, with a warning.
- Moving one into a subfolder of its experiment (`images/` …) or out of the experiment warns that
  it is no longer a workflow step, and `Sync workflow checklist with folder` moves it back after
  asking.
- Renaming or renumbering notes updates the usage record (`sources`) in the Local registry to the
  new names.

### Making a copy

- A "Make a copy" duplicate (`….labnote 1.md`) asks for the copy's own alias in a box prefilled
  with the original's, then gives it the next number and updates its file name, note `title`, and
  `## [ID name]` heading together before listing it. Cancelling leaves the name, title, and
  checklist as they are.
- The copy's dates are reset then: created and last updated today, `end_date` and the unit
  operations' `Start_date`/`End_date` emptied. The same happens when you rename a copy into the
  format by hand; then the note's `title` and `## [ID name]` heading follow the new file name
  before you are asked to list it, so they match even if you decline.
- The copy's `@issue` markers get new IDs before that box opens, so they do not merge with the
  original's issues.
- An experiment folder duplicated with "Make a copy" (`001_… 1`) asks for a title and becomes the
  next experiment: its README gets the new `title` and today's dates, its discussion flag is turned
  off, and its notes get new `@issue` marker IDs and note IDs.

### Aliases with brackets

Aliases may contain brackets such as `[re]`; the checklist link writes them as `\[re\]`.

## Experiment folders

- Experiment folder names must start with `###_` (e.g. `020_GFP`). If a rename drops the number,
  you are warned and offered the name with the old number back.
- Running a workflow command from a note in an unnumbered folder says the folder is not an
  experiment folder.
- Experiment folders must sit directly under `labnote/`; moving one into a subfolder such as
  `labnote/group/020_GFP` warns and offers to move it back under `labnote/`.
