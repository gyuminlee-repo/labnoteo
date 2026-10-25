/**
 * #323: the settings tab is written once as rows and drawn both as Obsidian
 * 1.13 definitions (which the settings search indexes) and by display().
 * #321: a field is saved when it is left, not on every key.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Setting, TextComponent } from 'obsidian';
import { commitOnChange, toSettingDefinitions, type SettingSection } from '../../src/settingRows';

describe('toSettingDefinitions', () => {
  it('puts rows without a heading at the top and the rest in groups', () => {
    const render = vi.fn();
    const visible = () => false;
    const sections: SettingSection[] = [
      { rows: [{ name: 'User guide', desc: 'Open it', render }] },
      {
        heading: 'MCP server',
        rows: [
          { name: 'Enable MCP server', aliases: ['MCP'] },
          { name: '', desc: 'only a description' },
        ],
      },
      { heading: 'Slack', visible, rows: [{ name: 'Slack connection', visible }] },
    ];

    const defs = toSettingDefinitions(sections);

    expect(defs).toHaveLength(3);
    expect(defs[0]).toMatchObject({ name: 'User guide', desc: 'Open it' });
    expect(defs[1]).toMatchObject({
      type: 'group',
      heading: 'MCP server',
      items: [{ name: 'Enable MCP server', aliases: ['MCP'] }, { name: '', searchable: false }],
    });
    expect(defs[2]).toMatchObject({ type: 'group', heading: 'Slack', visible, items: [{ visible }] });
    const setting = {} as Setting;
    (defs[0] as unknown as { render: (s: Setting) => void }).render(setting);
    expect(render).toHaveBeenCalledWith(setting);
  });
});

describe('commitOnChange', () => {
  function fakeText(initial: string) {
    let value = initial;
    let onChange: (v: string) => void = () => {};
    const listeners: Array<() => void> = [];
    const text = {
      inputEl: { addEventListener: (_: string, fn: () => void) => listeners.push(fn) },
      getValue: () => value,
      setValue: (v: string) => {
        value = v;
        return text;
      },
      onChange: (fn: (v: string) => void) => {
        onChange = fn;
        return text;
      },
    };
    const type = (v: string) => {
      value = v;
      onChange(v);
    };
    const leave = () => listeners.forEach(fn => fn());
    return { text: text as unknown as TextComponent, type, leave, value: () => value };
  }

  it('commits once when the field is left, with the last value typed', () => {
    const field = fakeText('2400');
    const commit = vi.fn((v: string) => v);
    commitOnChange(field.text, commit);

    field.type('8');
    field.type('80');
    field.type('800');
    field.type('8000');
    expect(commit).not.toHaveBeenCalled();
    field.leave();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('8000');
  });

  it('shows what commit returns, and commits a pending edit when the tab closes', () => {
    const field = fakeText('2400');
    const flush = commitOnChange(field.text, () => '2400');

    field.type('8000');
    flush();
    expect(field.value()).toBe('2400');

    const commit = vi.fn((v: string) => v);
    const untouched = fakeText('200');
    commitOnChange(untouched.text, commit)();
    expect(commit).not.toHaveBeenCalled();
  });
});
