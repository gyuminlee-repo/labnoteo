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

While a table cell is being edited, the date goes in at the cursor in that cell. In reading view
the command is still listed and says to switch to the editing view and place the cursor first.
Run while a field of the Properties box or the title above the note has focus, it inserts nothing
and says to click in the note body first, rather than adding the date at the body's last cursor
position.

### Insert date and time

Insert the current timestamp. The front matter and table cell rules are the same as Insert date.

### Date picker (📅)

Click the 📅 icon at the end of a `Start_date`/`End_date` line in `#### Meta`, or the value
itself, to open a date and time field. A changed value goes into the note at once; Enter or a
click elsewhere closes the field, and Escape puts back the value it opened with. One Ctrl+Z undoes
everything changed while it was open.

- Enter without picking anything keeps a value that is already there. Dates written with dots or
  slashes, or with single digits, such as `2026.10.23 14:00`, `2026/10/23` or `2026-1-5 9:30`, are
  read and shown; a value the field cannot read is left as it is too, and the field says it starts
  at another time. An empty value shows the current time, and Enter writes it.
- With a `Start_date` in the same block, the `End_date` calendar starts at that date, and closing
  with an end earlier than the start says so (the value is still written).
- Years outside 1900–2100, such as 0001 after stepping the year with the arrow keys or the digits
  passed through while typing a year, are not written; closing says the date was kept.
- Works in editing views only, including notes opened in a separate window.

## Experiments

### Create experiment

Create a new `.labnote.md` experiment note.

- As you type the title, it shows how many characters go into the folder name (`n/60`) and turns
  the warning colour past 60. Creating is not blocked: only the title part of the folder name is
  cut at 60, and the README title keeps it all.
- On Windows, it warns when the path including the vault folder reaches 260 characters.

### Change experiment status

Update the active experiment's `status` frontmatter via a picker.

- Each status is listed with what it means, and its search also matches words for it (in the
  Korean UI, Korean ones). The stored value is the English term either way.
- Also on an experiment's right-click menu in the workflow view, where it changes that experiment
  (the picker title and notice name the experiment folder). In a list filtered by a search, the
  experiment stays listed until the search changes, so it can be right-clicked again to undo.
- Picking `completed` while checklist workflows are unchecked, or while workflow notes have an
  empty `end_date`, shows the counts and the note names and asks first. A note whose front matter
  `end_date` is empty but whose unit operations all have an `End_date` counts as finished. An
  experiment with no workflow at all, in the checklist or the folder, is asked about too.
- Only the `status` line is rewritten (with the `discuss` line, when the flag is cleared); the
  other front matter lines, `#` comments included, stay as written. Obsidian's Properties editor
  can still drop comments when you edit there. When the README front matter cannot be read, it is
  left unchanged and the notice names the file.
- With the discussion flag on, picking `completed` offers to clear the flag or keep it, and lists
  where `@issue` markers remain (`note:line`).

### Retry this experiment

On the right-click menu of a `failed` or `needs-repeat` experiment in the workflow view: create the
next experiment to run it again. The title starts from the original's (`… 1차` becomes `… 2차`;
otherwise ` (retry)` is added, ` 2차` in the Korean UI; a run that already has a folder is skipped)
and can be edited; the new experiment is `planned` and keeps the original's `author` and `project`
as written there (a `[[name]]` link stays a link).

- Its README gets `retry_of` with a link to the original README (`[[labnote/061_…/README.labnote|061]]`),
  so Obsidian keeps it pointing there when folders are renumbered.
- In the workflow view the retry's tooltip says `Retry of: 061` and the original's says
  `Retried in: 103`; searching `061` finds both.

### Toggle discussion flag

Turn the active experiment's `discuss` flag on or off, so the next push opens a GitHub Issue
(requires Setup research automation).

- Run from a workflow note, it still changes that experiment's README, and the notice says so.
- Also on an experiment's right-click menu in the workflow view, where it changes that experiment;
  flagged experiments show a speech-bubble icon.
- Turning it off while `@issue` markers remain says where they are (`note:line`), since the
  experiment then stays under "Something to discuss". **Show @issue markers** on the experiment's
  right-click menu picks one and opens its line.
- Editing the front matter by hand, `yes`, `y`, `on`, `1`, `예` and `네` also turn it on, besides
  `true`.
- Like Change experiment status, it changes only the `discuss` line (turning it off removes the
  line) and keeps the other lines and their `#` comments.

### Insert issue marker

Drop an `@issue;<ID>;<topic>` marker at the cursor (the selection becomes the topic); each marker
opens its own Issue (requires Setup research automation).

- Only the README and workflow notes (`.labnote.md`) directly in an experiment folder are read for
  markers. In any other note (a plain `.md` in the experiment folder, a note in a subfolder or
  outside experiments) it inserts nothing and says so, and markers written there by hand are not
  highlighted.
- With nothing selected it asks for the topic in a box prefilled with the sentence on the cursor's
  line; leaving it empty or cancelling inserts nothing.
- If text follows the selection, the selection starts partway into the line's text, or the cursor
  is mid-line, the line is kept as is and the marker goes at its end. Only a selection of one
  line's whole text is replaced by the marker.
- A multi-line selection is not folded into one line: the marker goes at the end of its last line,
  with list marks left out of the topic.
- On a README workflow checklist line the link is never replaced: the marker always goes after it,
  and the topic box is prefilled with the label rather than the link. A line whose link became the
  marker would no longer be a workflow entry.
- On a line with a sample reference (`DNA-001;pUC19`), such as a sample line in `Input` or
  `Reagent`, the topic box starts empty and the marker goes on an indented line below: at the end of
  the line the reference's alias would run into the marker, dropping the sample from the list.
- On a heading it goes on the line below. Inside a table, the front matter, a code block
  (including code indented four spaces after a blank line) or a comment (`<!-- -->`, `%% %%`) it is
  not inserted.
- Markers inside code blocks, inline code (`` `@issue;…` ``) or comments are not highlighted, open
  no Issue, are not validated and keep their IDs when a note is copied. Commenting out a marker
  leaves an Issue it already opened as it is. Rerun `Setup research automation` after updating for
  the server automation to skip comments and inline code.

## Workflows

### Create workflow

Create a numbered workflow note and add it to the README checklist.

- The new line goes right after the last entry with the same or a lower number. Existing lines,
  and to-dos or notes written between them, are left alone.
- The section is found under a translated heading such as `## 관련 워크플로`. If the heading was
  changed to anything else, the first `##` section holding workflow entries is used; with neither,
  you are told the workflow was not listed.

- Under a Korean UI the catalog is also searchable by Korean names and shows Korean descriptions
  (as does Insert unit operation; words of the English description still match, and items a lab
  edited or added show the vault's English description).
- A word-ending `+` or `-` becomes `_plus`/`_minus` in the file name (`IND+` → `IND_plus`), and
  the `ID_name_alias` part after the number is cut at 80 characters. The note's title and alias
  stay whole; file names made at 100 characters up to 0.103.0 are left as they are.
- The alias prompt says what a workflow is and shows the chosen item's description. As you type it
  counts the characters that go into the file name (`n/room left`, which differs per workflow),
  turning the warning colour past it. Saving is not blocked.
- If the experiment already has a workflow with the same ID and alias (both empty included), the
  prompt warns with that file's name, since the two would read the same in the checklist. Saving
  is not blocked.
- An alias with `#`, with `*`, or with `_` anywhere but between ASCII letters and digits is refused
  with the reason: `#` breaks links to the heading, and the others turn part of the heading, TOC
  entry and checklist label italic in the reading view. Use a space; the file name gets `_` for it
  anyway. Notes made before this rule keep their names.
- On Windows, it warns when the path including the vault folder reaches 260 characters.

### Renumber workflows

Renumber an experiment folder's workflows from 001 without gaps **in the order of the README
checklist**, and list any workflow missing from the checklist. The `<note name>.labnote_tableN.csv`
files made by `Export tables to CSV` move to the new number too; a CSV whose new name is taken stays
put, with a notice.

- Reorder the checklist lines and run it to turn that order into numbers. A file the checklist does
  not list goes where its number puts it.
- The confirmation shows what the order follows and each changed file as `old → new` (more than ten
  are summed up as "+N more"). A name whose number has the wrong number of digits (`01_…`) is fixed
  too, marked "name format fixed", and a listed note without a number (`WB020_Cloning.labnote.md`)
  gets the number of its place in the checklist.
- A checklist entry whose file is gone is pointed at an unlisted file of the same workflow ID and
  name (such as a note renumbered by hand), shown in the same confirmation.
- Nothing changes when the numbers already follow the checklist; a README without the section is
  reported.
- When two notes share a number, moving a note in, renaming a note to another's number and
  `Sync workflow checklist with folder` point at this command.
- Renaming a note by hand while a CSV of its new name is there keeps its CSVs on the old name and
  names them; `Export tables to CSV` on the note then rewrites its CSVs and offers the leftovers for
  the trash.

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
- Notes with an empty `experimenter` get the README `author` after asking; a note that names
  someone keeps that name, since each note may be another person's. A finished unit operation, one
  with an `End_date`, keeps its experimenter, and the dialog lists its empty lines apart for you to
  fill in.
- A README `author` written as a YAML list or as `[[name]]` links is read as those names, joined
  with commas, here and for new workflows and unit operations.
- Local samples the notes use but that only another experiment's registry holds are brought into
  this experiment after asking.

### Insert unit operation

Insert a unit operation from the catalog, asking for an alias that tells runs or conditions apart
and adding it to the heading and TOC. Leave it empty for none; the prompt says what a unit
operation is, shows the chosen item's description and counts the characters, with no limit since
the alias goes into no file name. The same characters are refused as in Create workflow.

- It goes after the unit-operation block the cursor is in, before the first block when the cursor
  is between the TOC and it, and at the end elsewhere. The notice says where.
- The unit-operation section is `## Related Unit Operations`, its Korean name, or (after the
  heading was renamed) the first `##` section holding unit-operation blocks or TOC entries. With
  none, the block goes before `## Conclusions and Discussion`, or at the end of the note, and the
  notice says the TOC was not updated.
- The new block's Experimenter is the note's own `experimenter`, or the README `author` when the
  note names nobody. When the two differ, the notice says which one was used.
- Run where it can't go (a README, a note without the number, a subfolder of the experiment, an
  experiment moved into a subfolder of `labnote/`, …), it says what is wrong before the list opens.
- A HW unit operation whose catalog entry names its equipment lists it in `#### Equipment`, not in
  `#### Meta`.
- If the note already has a block of the same unit operation with the same alias (both empty
  included; case and spacing ignored), the alias prompt warns that the two would read the same in
  the headings and TOC, and a scanned worksheet page could not tell them apart. Inserting is not
  blocked.
- Typing in the list puts items whose name (Korean name included) equals the query first, then
  names containing it, then items that only mention it in their description, so Enter picks the
  named one. Last come items that hold the query typed without its spaces (`primerdesign` finds
  `primer design`) or every word of it in any order. Every picker (workflows, statuses, …) ranks
  this way.
- With **Auto-sync unit operation TOC** on, the TOC is reordered to match the headings. Turned
  off, the order stays as you arranged it, but renaming a unit operation still updates the entry's
  name and link, and deleting a block removes its entry (cutting one does not, since it is usually
  pasted back elsewhere).
- A note or `@issue` marker written after a TOC entry's link stays on that line when the TOC is
  rebuilt, and `[`/`]` in an alias are written `\[`/`\]` in the TOC, so an unmatched one does not
  break the link.

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
- A cell holds what the reading view shows. Bold, italic, highlight (`==`) and code marks are
  dropped, and struck-through text is dropped with its marks (`~~0.10~~ 0.12` → `0.12`). Footnote
  numbers (`[^1]`) go, math loses its `$`, links become the text they show, `<sup>6</sup>` becomes
  `^6` (`<sub>` just loses its tags), and HTML entities are decoded (`&lt;0.1` → `<0.1`, `&nbsp;` a space).
- A cell starting with `=` or `@`, or with a `+`/`-` that is not part of a number, gets a leading
  tab so Excel shows it as typed instead of evaluating it. Numbers like `-80` are left alone. In a
  column where such a cell appears, like `+/-`, a lone `+` or `-` gets the tab too.
- Opening the CSV by double-clicking it in Excel turns `3-1`, `1/2` and `SEPT9` into dates,
  `2:1`, `10:30` and `1:80` (a dilution) into times, `(1)` and `(0.05)` into negative numbers,
  numbers of 16 digits or more (barcodes, LIMS IDs) into ones with zeros past the 15th digit,
  plate-well names and dilutions such as `2E4` and `1E-3` into numbers in E notation (`20000`,
  `0.001`), and drops the leading zero of `007`. A pair that cannot be a month and a day, such as
  `12/48` or `7/40`, stays text. The file holds the text as typed; Excel is what changes it.
  Open it with Data → From Text/CSV and set those columns to Text. When a table has such cells,
  the export notice names each CSV with the columns to set to Text, and up to three examples per
  kind of change ("+N more").
- Excel cannot open a file whose path is longer than 218 characters. When a CSV's path including
  the vault folder is longer, the notice names it and its length.

**Which tables are exported**

- Tables inside callouts and quotes (`> | … |`) are exported.
- A table written without `|` at the ends of its rows is exported too, as the reading view shows
  it as a table. Its header and `---` row need the same number of cells, so text over a `---`
  heading underline is not taken for one.
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
- CSVs of tables the note no longer has are listed and moved to the trash after asking. So are
  `….labnote_tableN.csv` files with no note of their name in the folder (left by a deleted note, or
  by a rename that found the new CSV name taken), listed apart in the same prompt.

### Export all tables of this experiment to CSV

Export the tables of every note directly in the experiment folder, the README first and then the
others by name (workflow notes and plain `.md` notes alike), by the rules above. Run it from a note
of the experiment, or right-click the experiment folder or its `README.labnote.md` in the file
explorer.

- CSVs that would be overwritten or moved to the trash are asked about once for the whole
  experiment.
- The completion notice gives the table count per note and how many notes had none. Tables left
  out (inside a comment, or with no blank line above) are counted per note (`In: README 1`).

## Samples

- The sample view, autocomplete, the definition search and the sample list table list samples by
  alias, numbers by their size (`WTR-2` before `WTR-10`), then those without an alias by ID.
- Choosing `{Type} catalog search` in autocomplete opens the catalog search with what you typed
  after `;` already searched.
- The **Global sample folder** setting refuses a folder inside an experiment (its
  `resources/labsamples/` is that experiment's Local registry) and puts the previous value back.
  When the old Global folder was such a folder, its samples are not moved to the new one; use
  `Move to Global` for the ones to share.

### Open sample definition

Open the definition window for the sample reference under the cursor (on its ID or on the alias of
`ID;alias`), or else one picked by searching `ID | alias | scope` or the storage location, which
the list shows under each sample. The window edits, deletes, moves between Local and Global, and
changes the type.

- With no note open only Global samples are listed. When sample tracking is off it only says
  why: the plugin setting is off (Settings → Labnote Assistant → Samples → Sample tracking), or the
  experiment's README sets `sample_tracking: 'no'`.
- From a note at the vault root, a Global sample shows scope `global` with no move button, since
  that note has no Local registry of its own.
- A sample from a product catalog (`{Type}_name.json`) shows that file and the scope
  `Product catalog (read-only)`, and the window says to edit the file itself (or, if it was the
  sample registry, to rename it back to `{Type}.json`).

### Sample view context menu

Right-click a sample in the sample view (Shift+F10 from the keyboard) to copy its ID, insert a
reference, view usages, edit, delete, move between Local and Global, or change its type.

- **Insert reference** follows the cursor: at the end of the note from the front matter or above
  the title, on the next line from a heading or a `@type;ID;…` definition line, at the end of the
  line from another reference, inside the cells on a table row, and at the cursor otherwise. Text
  selected within one body line is replaced by the reference (a template hint such as
  `(samples from the previous step)`); a selection across lines, on a heading or definition line,
  over another reference, or across a table cell's `|` is ignored. A reference with an alias gets a
  space before any text right after it, since the alias is read up to whitespace.
- **View usages** lists each line that refers to or defines the sample, with the note path and its
  section (`[UHW250 …] › Output · line 12`), and opens the note with the cursor on that reference.
  A Local sample is looked up in its experiment, a Global one in the whole vault, leaving out
  experiments whose own Local sample has the same ID. A Local sample is also looked up in notes
  outside every experiment (a daily note, say) whose registries do not have its ID, for usages,
  deleting, alias changes and type changes alike; when another experiment has a sample with the
  same ID, those notes are counted but left unchanged, and the dialog says so. A reference copied
  into an AI summary callout (`> [!note] AI …`) is not a usage (deleting still counts it). A
  README that went into the registry's usage record (`sources`) before this rule is not taken out
  by itself.
- **Edit** asks before saving an alias another sample of the same type in the same registry
  already has; for a Local sample whose alias only Global samples have, a notice says so.
  **Change type** names the samples of the new type that already have its alias.
- **Delete** shows the sample's alias, description, location, scope and discard date in the
  confirmation, and the notice names it as `ID;alias`.
- **Move to Global / Move to Local** asks first when notes outside the experiment use a Global
  sample being made Local, and when the destination already has another sample of the same type
  and alias; moving then shows two samples with the same text in autocomplete (they are not
  merged).

### Insert sample list of this experiment

Insert, at the cursor, a Markdown table of every Local sample of this experiment and the Global
samples the note refers to, with ID, alias, description (the first one), location, scope, and
discarded columns, leaving the cursor below the table. With a Live Preview table cell focused it
goes below that table; run from the front matter or above the first heading, it goes at the end of
the note, with a notice. Use `Export tables to CSV` for a CSV.

References the note makes that no registry has are left out of the table, and the notice names them.

Outside the ID column, `#`, `[`, `]`, `*`, `_`, a backtick, `<`, `$`, `~~`, `==` and `%%` get a
backslash (`freezer \#B3`), so a location such as `#B3` shows as written instead of turning into a
tag, link or emphasis. `Export tables to CSV` drops those backslashes.

Once the table is in, `Edit sample`, `Mark as discarded`, `Unmark discarded` and moving between Local
and Global rewrite that sample's row in the sample list tables of the notes that list it, and the
notice counts the notes changed. Tables are found by their header (`ID | Alias | Description |
Location | Scope | Discarded`, or the Korean one), so tables inserted earlier are kept up to date
too; a table whose header you changed, and every other row, are left alone. When a sample gets its
first alias, the ID cell of these tables does not get `;alias` added, since the alias has its own
column.

A row of these tables lists a sample without using it. View usages leaves it out, it does not
bring a deleted sample's record back or keep a Global sample in the next table, and it does not
stop a delete: deleting a sample listed only there says so in the confirmation and removes its
rows too.

### Sample aliases

An alias cannot contain `;` or `:`, which end it in a note, nor `#`, `[[`, `]]`, `](`, `*`, `_` or a
backtick, which Markdown reads as a tag, link, emphasis or code (`_` next to Korean turns italic).
The alias box says why and suggests `-` or `/`. A link shape such as `standard [Trolox](1mM)` is
refused; lone brackets such as `[uninoculated]` show as written and are accepted. Aliases
registered before a rule are left as they are. For one already holding `[text](target)`, reading
view sees the alias only up to the link, and that alone no longer marks the reference with the
"registry calls this sample" warning.

### Discarded samples

`Mark as discarded` keeps a used-up sample, so the notes that used it still resolve it, and shows
it faded as `(discarded)` in the sample view.

- Autocomplete lists discarded samples last, below `Generate new … ID` and `Enter info`, tagged
  `· Discarded`; Enter on a lone discarded match therefore makes a new ID.
- Inserting one from autocomplete or the sample view, or typing its ID again, shows
  "… was marked discarded on 2026-10-25." So do Search partbank and Send to labnoteo when they
  reuse a discarded sample for the item picked.
- When a new sample's alias is already taken, the question lists discarded samples of that alias
  below `Create a new sample anyway`, marked `(discarded)`, so Enter does not reuse one, and says
  when only discarded samples have it.
- References to it are faded and struck through in editing and reading view, with
  `Marked discarded on <date>` on hover. A Local record in use hides a discarded Global one of
  the same ID.
- Editing its alias, description or location keeps the mark, the definition window shows the date,
  and `Unmark discarded` clears it.

## partbank

Register parts, devices, plasmids, primers, molecules and strains kept in
[partbank](https://partbank.kbiofoundry.kr) as samples, read where they are stored, and open them
in partbank. Nothing below appears until a connection is set up in the plugin settings, so a vault
that does not use partbank keeps the menus it always had.

### Connections

Two connections, each with an address, an API key and a `Test connection` button that answers with
the account name. It tests what the fields hold now, saved or not; a malformed address is not
called. An address that answers but not as partbank's API (another site, a login page) gets
"No partbank API was found at this address".

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

- **Each typed type searches its own kinds.** `@dna` searches parts, devices and molecules,
  `@plasmid` plasmids, `@primer` primers, `@protein`, `@reagent` and `@rna` molecules only, a strain
  type strains only, and `@sample` everything. A part like sfGFP is therefore found under `@dna` or
  `@sample`, not `@protein`. The Search partbank row and the empty result name what was searched.
- **The type you typed wins.** Only when it is open (`@sample`, a link, a catalog) does the
  partbank kind decide: part and device → `DNA`, plasmid → `Plasmid`, primer → `Primer`,
  molecules by their kind (`protein`/`enzyme` → `Protein`, `rna` → `RNA`, `dna` → `DNA`, the rest
  → `Reagent`).
- **Strains** have no built-in type, so they use a custom type `Strain`, which you are asked to add
  when it does not exist. Decline and the strain is not registered.
- It registers where any other sample would (the experiment's Local registry, or Global outside an
  experiment). **An item already registered** is not registered twice: its existing ID is inserted
  instead, looked up in this experiment, then Global, then the product catalogs. A sample moved to
  another type with Change type is found too, and the notice says which type it is registered as,
  and when it was marked discarded.
  One found in a catalog is reported as "Used ID from the partbank catalog (folder)", adding that
  saving the note copies it into this experiment's registry when the reference went into a note of
  an experiment. The KID is kept with the link rather than as the sample ID, and shows in the
  sample definition window. The description holds the KID, the name and partbank's description up
  to 1000 characters, cut between words beyond that (for samples registered from 0.125.0 on).

### Refresh storage location from partbank

In the sample view's context menu and in the definition window. It reads the location as
`storage / box / position` and stores it after showing the change once. When partbank shows no
stock, the current location is kept without asking (empty it in Edit sample to clear it).
**Refresh storage locations from partbank** (command palette) does every linked sample at once,
in every experiment of the vault and the Global folder whichever note is open, listing only what
changes as `old → new` with the experiment folder (or Global) it is in. A sample partbank shows no
stock for is left out of the list and keeps its location, so a hand-written one is not wiped; the
closing notice counts those and
the samples that could not be read. Because the value is stored, it stays visible offline and
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
already had and writes the file sorted by KID, so the git diff stays small. An item a Global sample
of another type already stands for (after Change type) is not added to this type's catalog, so it
keeps one ID. Items with the same
name within a file get ` (KID)` after the alias. Items other people share with your groups are
not included; register those through [Search partbank](#search-partbank). It stops with a notice
when no global sample folder is set. This is not the workflow [Update catalogs](#update-catalogs).

### Send to labnoteo

The detail screens in partbank have a **labnoteo로 보내기** button that opens Obsidian and asks
whether to register that item, letting you switch the destination to Global there. Even with Global
picked, an item this experiment already has is reused rather than registered again, and the notice
says where that sample is (and, with the insert question, when it was marked discarded). Links
naming an
address that is not in the settings are refused. After registering, it asks whether to put
`ID;alias` at the cursor of the open note (over the selected text, if any); `Cancel` does nothing.
With no open note, or one whose samples are not tracked, it goes to the clipboard without asking.

## Barcodes and scans

### Show note barcode

Show the note's ID and QR code in a window (`Copy ID`, and `Print experiment worksheet` for a
workflow note), giving the note an ID first if it has none. Also the QR icon at the top of a lab
note (`*.labnote.md`).

### Assign note ID

Give a note without one a `labnote_id`. This is not a content change, so `last_updated_date` stays.
When another note has the same ID, a new one is given after asking. Front matter that cannot be
read is left unchanged, with a notice.

- Lab notes sharing an ID (usually a copy) are pointed out with an offer to give the newest one a
  new ID. With three or more, you are asked again about the ones still sharing it. A set you
  decline is not asked about again that session, unless another note joins it.
- Only lab notes (`*.labnote.md`) count, and only they receive scans. A template or other Markdown
  file carrying a lab note's ID is not offered a new ID; a warning names it and says to delete its
  `labnote_id` line, since every note made from it would get that ID too.

### Print experiment worksheet

Pick a workflow note's unit operations (lab ones preselected) and print them as worksheets with a
QR code in two corners of every page; A4 or Letter. Method steps keep the numbers they have in the
note, lines indented under a step print below it, and tables print as tables (also ones without
`|` at the ends of their rows). Notes written
between a unit operation's title and its first `####` section print at the top, as a section without
a title. Sections with
nothing in them are left as ruled writing space, Method and Results & Discussions widest. Template
hint lines such as `(samples from the previous step)` are left out even when you wrote below them.
A fenced code block prints line by line as written, under the step above it without a step number
of its own, and a ticked Method step (`- [x]`) prints with a ✓ in its box. Inline formatting prints
as the reading view shows it: struck-through text struck (not dropped), highlights underlined,
footnote references and `<sup>` raised, `<sub>` lowered, and math without its `$`. The
dialog opens with focus on **Print**, so Enter prints; tabbing to a toggle shows a focus ring. When
printing from Obsidian does not work, it opens in the browser. See the
[printout scan guide](./SCAN.md#2-기록지-출력) (Korean).

### Print whole note with barcodes

Print the whole note split into pages, with a QR code on each. READMEs too. Each unit operation
starts on a new page, so the sheets can be filed by unit operation.

### Import scanned pages

Drop photos, PDFs or zips to file them in their notes by QR code, then show the results (open note,
undo, delete earlier scan). Also the scan icon in the left ribbon.

Each result names the block it went to (`note › [UHW290 Name] alias`). From 0.123.0 the QR code
also carries a fingerprint of the block's name and alias, so a page still finds its block after
blocks above it were removed or reordered, instead of sliding into the next block of the same ID.
The result asks you to check when the block was found somewhere else or the printout is older than
0.123.0. A page whose block was deleted or renamed since printing (the QR code cannot tell which) is
not guessed: it goes to unmatched scans.
Plugins before 0.123.0 do not read the new QR codes, so everyone sharing a vault should update
before scanning new printouts.

A page the note already has, but whose image was deleted, is filed again in place of the entry left
behind, and the result says so. A new scan never takes the name of a missing image a note still
links, so **delete earlier scan** removes the earlier image, not the new one.

### Process scan folder now

Process the PC scan folder set in settings right away (desktop only).

### Assign unmatched scans

Look at the pages that could not be filed on their own (`_labnote-scans/unmatched/`) as thumbnails,
with the reason for each, and file each by choosing the note, unit operation, and page, or delete it.

- For a page whose QR code was read, its note comes first, marked `from the QR code`; choosing it
  fills in the page and print date from the QR code.
- When the position the QR code names still holds a block of the same ID, that block comes first;
  otherwise (the block was deleted or moved) the window title only says which unit operation the
  QR code names.
- A page filed into a block you chose is not reported as an old printout, and if that block's
  heading changes before it is filed, the page stays unmatched instead of going to its neighbour.
- Pages sent to unmatched scans before 0.126.0 kept only the note ID, so only the note is offered.
- A page filed from here is captioned with its original file name, not the name it was kept under
  in `unmatched/`.

## AI

### AI: Draft Method section

Draft an experimental method with the configured LLM.

- Run inside a unit operation, it fills that unit operation's `#### Method`, asking first if it
  already has content. Run elsewhere, it asks which of the note's unit operations to fill.
- Without an AI provider configured, it says so before asking anything.
- In a workflow note that has no unit operation yet, it stops and says to insert one first.
- In another note without unit operations, the front matter and heading lines the model added are
  dropped and the whole draft goes inside the AI draft callout after the cursor's line, so result
  summaries do not read it as yours. With the cursor above the note body, it goes at the end of the
  note, with a notice.
- The draft starts with a `> [!note] AI draft (model, date) — review it, then delete this line`
  line. Delete it once you have checked the draft; left in place, it does not shift the step
  numbers of the printed worksheet.
- Inserting the draft leaves the cursor where it was, so text typed while waiting stays where you
  were writing.
- It goes in only if that note is still open when the reply arrives; if you moved to another note,
  the reply opens in the answer dialog (return to the note and press `Insert into note`, or `Copy`).
  A note that was only renamed meanwhile is still the same note, so the reply goes in.

### AI: Summarize workflow results

Summarize the results of a workflow note with the configured LLM. Not listed in an experiment
README, which has the next command.

- Only the result sections go to the model (`Results & Discussions`, `QC Metrics`, `Discussion`,
  `Conclusions and Discussion` and sections of your own, plus `Output` of a software unit operation
  — `USW…` or one with a `- Software:` line in its Meta), each headed by its unit operation;
  front matter, reagent and equipment lists, and a lab unit operation's `Output` (the samples handed
  to the next step) stay out.
- The summary goes at the end of `Conclusions and Discussion` as a
  `> [!note] AI workflow results summary (model, date)` callout. Without that section (its heading
  was renamed, say) it goes to the section holding the summary inserted earlier, or else to the end
  of the note, and the notice says which. Running it again asks before replacing the summary
  already there.
- In a note outside the template the whole note is sent and the summary goes after the cursor's
  line as `> [!note] AI summary (model, date)`.
- In a workflow note with no results written yet — its `Results & Discussions`, `QC Metrics`,
  `Discussion` and `Conclusions and Discussion` empty or still holding the template wording, and
  no section of the researcher's own — it stops instead of asking the model, so nothing is
  invented. A section you added yourself counts as results, and a note outside the template is
  summarized as before.
- The template's `- (…)` wording and summaries inserted earlier are left out of what the model
  reads, and it is told not to invent a measurement that is not in the note.
- Moving to another note while waiting opens the answer dialog, as for the Method draft.
- Inserting the summary leaves the cursor where it was, so text typed while waiting does not end
  up inside the callout.
- The summary and the Method draft ask the model to write in Obsidian's interface language.
- Both summaries ask the model to call samples by their alias rather than copy `ID;alias`
  references. `@issue` markers are sent as their topic sentences, and any `@issue;` or `@issue:`
  left in the reply loses its `@`, so a summary opens no issue and does not fail `validate`.

### AI: Summarize experiment results

From an experiment README, summarize the whole experiment. Listed only in a README.

- Reads the result sections of every workflow note in the folder, in README checklist order (notes
  the checklist misses come after, by number), plus your own notes in the README's
  `Summary and Discussion`. Open notes are read as they are in the editor. The model is told to use
  your notes as context only, and lines of the reply that repeat one of them (20 characters or
  more) are dropped.
- About 10,000 characters of results are sent, shared among the notes; what a short note leaves
  goes to the others.
- The summary goes at the end of `Summary and Discussion` as a
  `> [!note] AI experiment results summary (model, date)` callout. With that heading renamed, it goes
  where the earlier summary is, or at the end, as for the workflow summary. Running it again asks
  before replacing it.
- When no workflow note has results written yet it stops without asking the model.

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
- A name the alias rules do not allow is registered changed (`_`, `:` and `;` become `-`, `#` and
  `*` are dropped), and the notice lists each change (`pX330_lacZ → pX330-lacZ`). The note keeps the
  name as written; the sample view search and autocomplete treat `_` and `-` alike, so that name
  still finds the sample.

### AI: Ask assistant (uses tools)

State a goal and let the model reach it with Labnote's tools; it also reads the start of the
current note.

- The final answer opens in a dialog with `Insert into note`, `Copy`, and `Close` — nothing is
  added to the note on its own.
- With no answer and no tool called, it says the request may be outside the tools it can use.
- The end notice counts changes made, lookups, writes you denied, and failed calls, and says when
  nothing in the vault changed. Failed or denied calls are named with their target and reason, up
  to three (`Failed: update_section (Method) — …`, then `+N more`).
- When at least one change was made, an empty final answer does not bring up the "The model gave no
  answer" notice.

## Views and the rest

### Toggle MCP server

Start or stop the local MCP server. See the [Copilot guide](./COPILOT.md) (Korean).

### Open workflow view / Open sample view

Reveal the sidebar view and move focus into its list; arrow keys move, →← expand and collapse,
Enter opens, and Shift+F10 or the menu key opens the right-click menu.

- The workflow view's **Experiments** section groups experiments by status, by project, by author
  (the README `author`, empty ones under **(no author)**), or by discussion. **By discussion** puts
  the ones flagged for discussion or with at least one `@issue` marker (counted in the notes
  directly in the experiment folder, as the automation does) under **Something to discuss** and the
  rest under **Nothing to discuss**; the tooltip gives the marker count and the author.
- **By author** reads a list `author` or `[[name]]` links as the names, and puts an experiment of
  several people in each one's group, so the group counts can add up to more than the experiments.
- **By status**, an experiment whose README front matter cannot be read goes under
  **(front matter unreadable)** with a warning icon, its tooltip giving the error, rather than among
  the ones with no status.
- **Search experiments** matches the folder name, title, project, author, status and the names of
  the experiment's workflow notes (an alias such as `WTR-3`, or a catalog ID), the status also by
  its name in the UI language (`검토 필요` for `needs-review` in Korean), and `discuss` for the ones
  with something to discuss. When nothing matches, the view says so and what it searches. An
  experiment whose status or discussion flag was changed from the list stays listed until the
  search changes.

### Setup research automation

Scaffold GitHub Actions and scripts into the current vault. See
[Research automation](../README.en.md#research-automation).

When Obsidian still saves new attachments at the vault root, it then offers to save them in an
`images` folder next to each note (the experiment's `images/` for a lab note). Accepting sets
Settings → Files and links → **Default location for new attachments** to **In subfolder under
current folder**, with **Subfolder name** `images`; to do it later, set those two yourself.

Once the automation is installed, renaming `AGENTS.md`, `CLAUDE.md` or `wiki-staging/` at the vault
root warns that AI agents and the automation look for them only by that name, and offers the name
back. Rerunning the command after one went missing names the files it had to create again.

### Open user guide

Open the researcher quick start (`QUICKSTART.md`), creating it in the vault if missing. No Setup
research automation needed. Also a button at the top of the settings tab.

The guide says which release it was written for at the top. Plugin updates replace its marked block
while nobody edited it. A guide from an older release whose block was edited asks first: replacing
keeps the old file as `QUICKSTART.backup.md` (committed too in a Git vault), and Cancel opens it as
it is. When a backup by that name is already there, the new one takes the old guide's release
(`QUICKSTART.backup-0.125.0.md`, then numbered), so an earlier backup is never written over; the
dialog and the notice name the file. Text below the block is always kept.

Setup research automation treats an edited marked block of `AGENTS.md` (and the other marked files)
the same way: it lists the lines that would go (up to eight), asks to put the block back to the
installed text when this plugin version ships the same block or to replace it with the new version
otherwise, and on yes keeps the current file beside it as `AGENTS.backup.md` (then
`AGENTS.backup_2.md`, …) so you can move your lines outside the markers.

## Inserting while in reading view

A command that inserts at the cursor (Insert unit operation, Insert sample list of this experiment,
a sample reference, AI drafts and summaries, …) run on a note in reading view switches it to
editing view first, inserts near the end of the note, and says so. A unit operation goes after the
last block.

When a sample's alias or type changes, a note open only in reading view is fixed in its file and
its view is left as it is.

## Renaming, moving and copying notes

### Renaming a workflow file

- Renaming a workflow file in the file explorer relinks its README checklist line. Only when the new
  number no longer fits between its neighbours does **that line** move to its number, with the more
  deeply indented sub-tasks under it. Your own to-do and note lines, the order of other entries, and
  markers or notes after a link stay as they are.
- A renamed note takes its `_tableN.csv` files along. An entry whose label matched the old file
  name follows the new name, and so do the note's `title` and `## [ID name]` heading if they
  matched it. Labels and titles you edited by hand are kept.
- If a rename breaks the `###_….labnote.md` format, you are warned and offered a fixed name. When
  there is no fix (the number became `01_`, say) or its name is taken, you are offered the old name
  back. Once the format is back (by accepting either offer or fixing it by hand), the checklist
  follows the file again.
- Changing only the catalog ID in a workflow file name, so that it no longer matches the note's
  `## [ID name]`, warns and offers the old name back.
- A name with `#`, `^`, `|`, `[` or `]` cannot be reached by any link, so its checklist entry does
  not open. You are warned and offered the name without them, or the old name back when there is
  none; `Sync workflow checklist with folder` reports such notes too.
- Renaming or moving an experiment's `README.labnote.md` warns and offers the old name back.
- `Sync workflow checklist with folder` finds note titles, headings and labels that no longer match
  their file names and fixes them after asking.

### Deleting a workflow file

Deleting one removes its checklist entry. Samples are kept — only that note's usage record is
dropped — and its leftover `.labnote_tableN.csv` files are moved to the trash after asking.

Deleting only an experiment's `README.labnote.md` (the folder stays) says to restore it from the
trash and offers a new README listing the folder's workflow notes, with status `planned`, an empty
objective and summary, and every entry unchecked. Nothing is asked when the whole folder was deleted.

### Moving to another folder

- A workflow moved into another experiment folder is not listed automatically; you get a notice.
  Run `Sync workflow checklist with folder` there. `Insert workflow` (README right-click) creates a
  new workflow from the catalog, so do not use it to register a moved file.
- Its line stays in the README checklist of the experiment it left, and a notice says to run the
  same command there, which removes it after asking. The workflow view's progress counts only notes
  still in the folder.
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
  checklist as they are. The box refuses the same characters as Create workflow, except that the
  original's alias passes when you keep it unchanged.
- The copy's dates are reset then: created and last updated today, `end_date` and the unit
  operations' `Start_date`/`End_date` emptied. The same happens when you rename a copy into the
  format by hand; then the note's `title` and `## [ID name]` heading follow the new file name
  before you are asked to list it, so they match even if you decline.
- The copy's `@issue` markers get new IDs before that box opens, so they do not merge with the
  original's issues.
- An experiment folder duplicated with "Make a copy" (`001_… 1`) asks for a title and becomes the
  next experiment: its README gets the new `title`, today's dates and status `planned`, its
  discussion flag is removed, and its notes get new `@issue` marker IDs and note IDs.
- Cancelling that title box warns that the copy still has the original's number, title, status,
  created date and discussion flag. Renaming the copy's folder to a new number by hand then (also
  after Obsidian closed with the box open) asks again, keeping that number when it is free.
- When the original is `failed` or `needs-repeat`, or is itself a retry, you are asked whether to
  mark the copy as a retry. **Mark as retry** points the copy's `retry_of` at the original (or, for a
  copy of a retry, at the experiment it retried); otherwise `retry_of` is removed, as it is without
  asking for any other original. The completion notice says which.
- The copied README's `id` (`EXP-###`) becomes the number after the highest one with that prefix;
  an `id` not ending in a number is removed, so the folder name is the experiment ID. Either way the
  automation does not take the copy for the original.
- Checklist links that reach the original's notes are pointed at the copy's own notes, and the
  original's worksheet scans (`#### Worksheet scans` entries) are taken out of the copy's notes; the
  scan images stay for the original. The workflow notes keep their dates.

### Aliases with brackets

Aliases may contain brackets such as `[re]`; the checklist link writes them as `\[re\]`. Unlike
brackets, `#`, `*` and `_` (other than between ASCII letters and digits) are refused; see
[Create workflow](#create-workflow).

## Experiment folders

- Experiment folder names must start with `###_` (e.g. `020_GFP`). If a rename drops the number,
  you are warned and offered the name with the old number back.
- Running a workflow command from a note in an unnumbered folder says the folder is not an
  experiment folder.
- Do not rename or move an experiment's `resources/labsamples/`: it is the Local sample registry, so
  every Local sample would read as unregistered and new ones would go to an empty registry. Renaming
  or moving `resources` or `labsamples` warns and offers to put it back.
- The same goes for a registry file `{Type}.json` there or in the Global sample folder. Renaming or
  moving one warns with its sample count and offers the old name back; a name such as
  `{Type}_old.json` would also make it a read-only product catalog. Deleting one warns to restore it
  from the trash before adding samples.
- Experiment folders must sit directly under `labnote/`; moving one into a subfolder such as
  `labnote/group/020_GFP`, or out of `labnote/` altogether, warns and offers to move it back under
  `labnote/`. Running a workflow command from a note of such a folder says the same.
