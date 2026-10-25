/**
 * The settings tab written once as rows (#323), drawn two ways: as definitions
 * for Obsidian 1.13 and later, whose settings search indexes them, and by
 * `display()` on older versions.
 */
import { Setting, type SettingDefinitionItem, type SettingDefinitionRender, type TextComponent } from 'obsidian';

/** One row of the settings tab. */
export interface SettingRow {
  /** '' for a row of only a description or buttons; such a row is not searched. */
  name: string;
  desc?: string;
  /** More words the settings search finds the row by. */
  aliases?: string[];
  /** Checked on every draw: whether the row is shown now. */
  visible?: () => boolean;
  /**
   * Adds the controls (and any status line under the description). On
   * Obsidian 1.13 and later it also runs while the row is hidden by `visible`.
   */
  render?: (setting: Setting) => void;
}

/** Rows under one heading; the first section may have none. */
export interface SettingSection {
  heading?: string;
  visible?: () => boolean;
  rows: SettingRow[];
}

const shown = (visible?: () => boolean): boolean => !visible || visible();

/** Draw `sections` into `containerEl`, for Obsidian before 1.13. */
export function renderSettingSections(containerEl: HTMLElement, sections: readonly SettingSection[]): void {
  for (const section of sections) {
    if (!shown(section.visible)) continue;
    if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
    for (const row of section.rows) {
      if (!shown(row.visible)) continue;
      const setting = new Setting(containerEl).setName(row.name);
      if (row.desc) setting.setDesc(row.desc);
      row.render?.(setting);
    }
  }
}

/**
 * `sections` as setting definitions. Obsidian sets each row's name and
 * description before it calls `render`, so a status line `render` adds under
 * the description stays.
 */
export function toSettingDefinitions(sections: readonly SettingSection[]): SettingDefinitionItem[] {
  const items: SettingDefinitionItem[] = [];
  for (const section of sections) {
    const defs = section.rows.map(row => {
      const def: SettingDefinitionRender = {
        name: row.name,
        // Nothing returned: Obsidian calls what `render` returns when it tears
        // the row down, and a row's `render` may hand back its Setting (#362).
        // Hidden rows are drawn too, so one that throws must not stop the rest.
        render: setting => {
          try {
            row.render?.(setting);
          } catch (e) {
            console.error(`labnoteo: could not draw the setting "${row.name}"`, e);
          }
        },
      };
      if (row.desc) def.desc = row.desc;
      if (row.aliases) def.aliases = row.aliases;
      if (row.visible) def.visible = row.visible;
      if (!row.name) def.searchable = false;
      return def;
    });
    if (section.heading) {
      items.push({
        type: 'group',
        heading: section.heading,
        items: defs,
        ...(section.visible ? { visible: section.visible } : {}),
      });
    } else {
      items.push(...defs);
    }
  }
  return items;
}

/**
 * Save a text field when it is left or Enter is pressed (#321, #328), not on
 * every key, so a value passed on the way to another (8 → 80 → 800 → 8000) is
 * never saved. `commit` gets what was typed and returns what the field shows
 * afterwards: the value saved, or the earlier one when it refused the input.
 * Returns the commit, for a tab closed while the field still had focus.
 */
export function commitOnChange(text: TextComponent, commit: (value: string) => string): () => void {
  let pending = false;
  text.onChange(() => {
    pending = true;
  });
  const flush = (): void => {
    if (!pending) return;
    pending = false;
    text.setValue(commit(text.getValue()));
  };
  text.inputEl.addEventListener('change', flush);
  return flush;
}
