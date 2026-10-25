/**
 * Settings tab for the Labnote Assistant plugin.
 *
 * Sample options mirror the companion VS Code extension's settings; the LLM section is
 * Obsidian-specific (the desktop build talks to Ollama/OpenAI directly).
 */
import { App, Notice, PluginSettingTab, requireApiVersion, type Setting, type SettingDefinitionItem } from 'obsidian';
import type LabnotePlugin from './main';
import { suggestSampleTypeName } from '@labnoteo/core/lib/sampleUtils';
import { isSameSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import { invalidVaultFolderReason } from '@labnoteo/core/lib/regexUtils';
import { getExperimentDir, getExperimentLabsamplesFolder } from '@labnoteo/core/lib/labnoteStructure';
import * as posix from '@labnoteo/core/posix';
import {
  countSampleRecords,
  DEFAULT_SETTINGS,
  invalidFolderText,
  partitionCustomSampleTypes,
  removedCustomSampleTypes,
  type LlmProviderKind,
} from './settings';
import { confirmModal } from './modals';
import { openUserGuide } from './userGuide';
import { writeNoteThroughVault } from './commands';
import { tokenFingerprint } from './llm/mcpServer';
import { scanSettingSections, type SettingsContext } from './scan/scanSettings';
import { partbankSettingSection } from './partbank/partbankSettings';
import { commitOnChange, renderSettingSections, toSettingDefinitions, type SettingSection } from './settingRows';

/** How long the regenerate button waits for its confirming second click. */
const REGENERATE_CONFIRM_MS = 5000;

export class LabnoteSettingTab extends PluginSettingTab {
  /** Debounce handle for refreshing sample views after a Global folder edit. */
  private globalFolderRefreshTimer?: number;
  /** Set between the first and the confirming second click on "Regenerate token". */
  private regenerateArm?: { timer: number; reset: () => void };
  /**
   * The Global sample folder when the tab was first shown; kept until the move
   * question for a change has been asked, so a redraw does not lose it (#101).
   */
  private globalFolderBaseline?: string;
  /** Polls for the settings modal to close before asking about a folder change. */
  private globalFolderPromptTimer?: number;
  /** Debounce handle for refreshing sample views after a custom type edit (#137). */
  private sampleTypesRefreshTimer?: number;
  /** The custom sample types when the tab was first shown, kept until removed ones were asked about (#137). */
  private sampleTypesBaseline?: string[];
  /** Polls for the settings modal to close before asking about removed types. */
  private sampleTypesPromptTimer?: number;
  /** Fields saved when left, committed on hide too (#321). */
  private pendingCommits: Array<() => void> = [];

  constructor(app: App, private readonly plugin: LabnotePlugin) {
    super(app, plugin);
  }

  /**
   * Re-read the Samples sidebar ~400ms after the Global folder changes so it
   * tracks the new folder without an app reload (#46). Skipped while the field
   * is empty (a transient mid-edit state that would read the vault root).
   */
  private scheduleGlobalFolderRefresh(): void {
    if (this.globalFolderRefreshTimer !== undefined) {
      window.clearTimeout(this.globalFolderRefreshTimer);
    }
    this.globalFolderRefreshTimer = window.setTimeout(() => {
      this.globalFolderRefreshTimer = undefined;
      if (!this.plugin.settings.globalSampleFolder) return;
      this.plugin.refreshSampleViews();
    }, 400);
  }

  /** Re-read the Samples sidebar ~400ms after the custom types change, so it shows the new list (#137). */
  private scheduleSampleTypesRefresh(): void {
    window.clearTimeout(this.sampleTypesRefreshTimer);
    this.sampleTypesRefreshTimer = window.setTimeout(() => {
      this.sampleTypesRefreshTimer = undefined;
      this.plugin.refreshSampleViews();
    }, 400);
  }

  /**
   * Once per draw of the tab, on both paths: put a half-confirmed regenerate
   * back, and note the values a change is later asked about against.
   */
  private prepare(): void {
    this.disarmRegenerate();
    this.pendingCommits = [];
    // Back on the tab before the question was asked: ask on the next hide.
    window.clearTimeout(this.globalFolderPromptTimer);
    this.globalFolderPromptTimer = undefined;
    this.globalFolderBaseline ??= this.plugin.settings.globalSampleFolder;
    window.clearTimeout(this.sampleTypesPromptTimer);
    this.sampleTypesPromptTimer = undefined;
    this.sampleTypesBaseline ??= [...this.plugin.settings.customSampleTypes];
  }

  /** Obsidian 1.13 and later draw these and index them for the settings search (#323). */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return toSettingDefinitions(this.sections());
  }

  /** Obsidian before 1.13 calls this instead of drawing the definitions. */
  display(): void {
    this.containerEl.empty();
    renderSettingSections(this.containerEl, this.sections());
  }

  private redraw(): void {
    if (requireApiVersion('1.13.0')) this.update();
    else this.display();
  }

  private sections(): SettingSection[] {
    const ctx: SettingsContext = {
      redraw: () => this.redraw(),
      onHide: commit => this.pendingCommits.push(commit),
    };
    return [
      this.guideSection(),
      this.samplesSection(),
      this.workflowsSection(),
      ...scanSettingSections(this.plugin, ctx),
      partbankSettingSection(this.plugin),
      this.aiSection(),
      this.mcpSection(),
    ];
  }

  private guideSection(): SettingSection {
    const t = this.plugin.t;
    return {
      rows: [
        {
          name: t('User guide'),
          desc: t(
            'New here? Open the quick-start guide. Searching "Labnote" in the command palette lists every command.'
          ),
          aliases: ['QUICKSTART'],
          render: setting => {
            // The first row: drawn whenever the tab is.
            this.prepare();
            setting.addButton(b =>
              b
                .setButtonText(t('Open user guide'))
                .setCta()
                .onClick(() => {
                  // Settings is a modal: close it or the guide opens hidden behind it.
                  (this.app as unknown as { setting?: { close(): void } }).setting?.close();
                  void openUserGuide(this.plugin.host, this.plugin.manifest.version, (path, content) =>
                    writeNoteThroughVault(this.app, this.plugin.host, path, content)
                  );
                })
            );
          },
        },
      ],
    };
  }

  private samplesSection(): SettingSection {
    const t = this.plugin.t;
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();
    return {
      heading: t('Samples'),
      rows: [
        {
          name: t('Sample tracking'),
          desc: t('Autocomplete, highlighting and {Type}.json sync. Reload to apply.'),
          render: setting =>
            setting.addToggle(toggle =>
              toggle.setValue(s.sampleTracking).onChange(v => {
                s.sampleTracking = v;
                save();
              })
            ),
        },
        {
          name: t('Custom sample types'),
          desc: t(
            'Comma-separated types in addition to the built-ins. Use letters, digits and _ only (no spaces or -), e.g. CellLine, 배지. A _ works between ASCII letters and digits (Cell_Line); next to other letters it turns the name italic in the reading view, so write those together (무세포용해물).'
          ),
          render: typesSetting => this.renderCustomTypes(typesSetting),
        },
        {
          name: t('Global sample folder'),
          desc: t('Vault-relative folder for vault-global samples.'),
          render: setting =>
            setting.addText(text => {
              text.setValue(s.globalSampleFolder);
              this.pendingCommits.push(commitOnChange(text, v => this.commitGlobalFolder(v)));
            }),
        },
      ],
    };
  }

  /**
   * Save the Global sample folder once the field is left (#328). An empty
   * field silently breaks Global-scope reads and writes, so it gets the
   * default back; a path some OS cannot make is refused with the reason.
   */
  private commitGlobalFolder(value: string): string {
    const s = this.plugin.settings;
    const folder = value.trim() || DEFAULT_SETTINGS.globalSampleFolder;
    const reason = invalidVaultFolderReason(folder);
    if (reason) {
      new Notice(
        this.plugin.t(
          '"{0}" cannot be the Global sample folder: {1} It is back to {2}.',
          folder,
          invalidFolderText(this.plugin.t, reason),
          s.globalSampleFolder
        ),
        10000
      );
      return s.globalSampleFolder;
    }
    if (folder !== s.globalSampleFolder) {
      s.globalSampleFolder = folder;
      void this.plugin.saveSettings();
      this.scheduleGlobalFolderRefresh();
    }
    return folder;
  }

  private renderCustomTypes(typesSetting: Setting): void {
    const s = this.plugin.settings;
    // Names stored before validation existed stay usable (#81).
    const storedTypes = [...s.customSampleTypes];
    typesSetting.addText(t => {
      t.setPlaceholder('CellLine, Strain')
        .setValue(s.customSampleTypes.join(', '))
        .onChange(v => {
          s.customSampleTypes = partitionCustomSampleTypes(v, storedTypes).save;
          void this.plugin.saveSettings();
          this.scheduleSampleTypesRefresh();
        });
      t.inputEl.addEventListener('blur', () => {
        const { rejected, italic, caseDuplicates } = partitionCustomSampleTypes(t.getValue(), storedTypes);
        if (rejected.length === 0 && italic.length === 0 && caseDuplicates.length === 0) return;
        if (rejected.length > 0) {
          new Notice(
            this.plugin.t(
              '{0}: a space or - keeps a type from autocompleting, so it was not saved. Use {1} instead.',
              rejected.map(r => r.name).join(', '),
              rejected.map(r => r.suggestion).join(', ')
            ),
            8000
          );
        }
        if (italic.length > 0) {
          new Notice(
            this.plugin.t(
              '{0}: a _ next to a letter that is not A–Z or a digit shows the name in italics in the reading view, so it was not saved. Use {1} instead.',
              italic.map(r => r.name).join(', '),
              italic.map(r => r.suggestion).join(', ')
            ),
            8000
          );
        }
        if (caseDuplicates.length > 0) {
          new Notice(
            this.plugin.t(
              '{0}: differs from {1} only in letter case, so on Windows both would share one {Type}.json and their samples would mix. It was not saved.',
              caseDuplicates.map(d => d.name).join(', '),
              caseDuplicates.map(d => d.clashesWith).join(', ')
            ),
            8000
          );
        }
        t.setValue(s.customSampleTypes.join(', '));
      });
    });
    const { legacyInvalid, legacyItalic, legacyCaseDuplicates } = partitionCustomSampleTypes(
      s.customSampleTypes.join(','),
      storedTypes
    );
    if (legacyInvalid.length > 0) {
      typesSetting.descEl.createDiv({
        cls: 'mod-warning',
        text: this.plugin.t(
          '{0} cannot be autocompleted in notes (a space or -). Rename it, e.g. {1}, if you have no samples of it yet.',
          legacyInvalid.join(', '),
          legacyInvalid.map(suggestSampleTypeName).join(', ')
        ),
      });
    }
    if (legacyItalic.length > 0) {
      typesSetting.descEl.createDiv({
        cls: 'mod-warning',
        text: this.plugin.t(
          '{0} is shown in italics in the reading view because of its _. It keeps working; rename it, e.g. {1}, if you have no samples of it yet.',
          legacyItalic.join(', '),
          legacyItalic.map(suggestSampleTypeName).join(', ')
        ),
      });
    }
    if (legacyCaseDuplicates.length > 0) {
      typesSetting.descEl.createDiv({
        cls: 'mod-warning',
        text: this.plugin.t(
          '{0} differs from {1} only in letter case: on Windows both share one {Type}.json, so their samples mix. Keep one of them.',
          legacyCaseDuplicates.map(d => d.name).join(', '),
          legacyCaseDuplicates.map(d => d.clashesWith).join(', ')
        ),
      });
    }
  }

  private workflowsSection(): SettingSection {
    const t = this.plugin.t;
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();
    return {
      heading: t('Workflows'),
      rows: [
        {
          name: t('Auto-sync unit operation TOC'),
          desc: t(
            "Reorder a workflow note's Related Unit Operations list to match heading order after edits, and tidy the --- separators immediately when a block is moved. Off, the order is left as you arranged it but the names and links still follow the headings."
          ),
          aliases: ['TOC'],
          render: setting =>
            setting.addToggle(toggle =>
              toggle.setValue(s.autoSyncUnitOpToc).onChange(v => {
                s.autoSyncUnitOpToc = v;
                save();
              })
            ),
        },
        {
          name: t('Auto-update last updated date'),
          desc: t(
            "Set a lab note's last_updated_date to today (once a day) when you edit it, change its status or discussion flag, or the AI edits it. Editing a workflow note also updates its experiment README. Changes pulled from git are ignored. A date you type by hand is kept for the rest of that day; turning this off and on resumes it at once."
          ),
          aliases: ['last_updated_date'],
          render: setting =>
            setting.addToggle(toggle =>
              toggle.setValue(s.autoUpdateLastUpdated).onChange(v => {
                s.autoUpdateLastUpdated = v;
                this.plugin.resetLastUpdatedTracking();
                save();
              })
            ),
        },
      ],
    };
  }

  private aiSection(): SettingSection {
    const t = this.plugin.t;
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();
    return {
      heading: t('AI provider'),
      rows: [
        {
          name: t('Provider'),
          aliases: ['AI', 'LLM', 'Ollama', 'OpenAI'],
          render: setting =>
            setting.addDropdown(d =>
              d
                .addOption('none', t('Disabled'))
                .addOption('ollama', 'Ollama')
                .addOption('openai', 'OpenAI-compatible')
                .setValue(s.llmProvider)
                .onChange(v => {
                  s.llmProvider = v as LlmProviderKind;
                  save();
                })
            ),
        },
        {
          name: t('Ollama endpoint'),
          desc: t('Without http:// or https://, http:// is added when connecting.'),
          render: setting =>
            setting.addText(text =>
              text.setValue(s.llmEndpointOllama).onChange(v => {
                s.llmEndpointOllama = v.trim();
                save();
              })
            ),
        },
        {
          name: t('OpenAI endpoint'),
          desc: t('Without http:// or https://, http:// is added when connecting.'),
          render: setting =>
            setting.addText(text =>
              text.setValue(s.llmEndpointOpenai).onChange(v => {
                s.llmEndpointOpenai = v.trim();
                save();
              })
            ),
        },
        {
          name: t('Model'),
          render: setting =>
            setting.addText(text =>
              text.setValue(s.llmModel).onChange(v => {
                s.llmModel = v.trim();
                save();
              })
            ),
        },
        {
          name: t('API key'),
          desc: t('Only sent to OpenAI-compatible providers, never to Ollama.'),
          render: setting =>
            setting.addText(text => {
              text.inputEl.type = 'password';
              // Debounce persistence so we don't hit disk on every keystroke of a key.
              let timer: number | undefined;
              text.setValue(s.llmApiKey).onChange(v => {
                s.llmApiKey = v;
                window.clearTimeout(timer);
                timer = window.setTimeout(() => void this.plugin.saveSettings(), 500);
              });
            }),
        },
      ],
    };
  }

  /** Its own heading: the server works whatever the AI provider is (#322). */
  private mcpSection(): SettingSection {
    const t = this.plugin.t;
    const s = this.plugin.settings;
    return {
      heading: t('MCP server'),
      rows: [
        {
          name: t('Enable MCP server'),
          desc: t(
            'Desktop only. Exposes tools to external MCP clients. Tools that change the vault run only after you allow them in Obsidian.'
          ),
          aliases: ['MCP', 'Claude', 'Copilot'],
          render: setting =>
            setting.addToggle(toggle =>
              toggle.setValue(s.mcpEnabled).onChange(v => {
                // Drive the live server from the toggle so the setting and the running
                // state stay consistent (matching the command's behaviour).
                s.mcpEnabled = v;
                void this.plugin.saveSettings();
                if (v) this.plugin.mcpServer.start();
                else this.plugin.mcpServer.stop();
              })
            ),
        },
        {
          name: t('MCP token'),
          desc: t(
            'Bearer token for external MCP clients. It stays the same when Obsidian or the server restarts; regenerate it if it leaked, then paste the new one into every client.'
          ),
          aliases: ['MCP'],
          render: tokenSetting => this.renderMcpToken(tokenSetting),
        },
      ],
    };
  }

  private renderMcpToken(tokenSetting: Setting): void {
    tokenSetting
      .addButton(b =>
        b.setButtonText(this.plugin.t('Copy token')).onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.mcpServer.ensureToken());
          new Notice(this.plugin.t('MCP token copied to clipboard.'));
        })
      )
      .addButton(b => {
        // Confirmed by a second click rather than a dialog: a modal opened over
        // the settings modal is what left the token unchanged (#107).
        const reset = (): void => {
          b.setButtonText(this.plugin.t('Regenerate token'));
          b.buttonEl.classList.remove('mod-warning');
        };
        b.setButtonText(this.plugin.t('Regenerate token')).onClick(async () => {
          if (!this.regenerateArm) {
            b.setButtonText(this.plugin.t('Click again to regenerate')).setWarning();
            this.regenerateArm = {
              timer: window.setTimeout(() => this.disarmRegenerate(), REGENERATE_CONFIRM_MS),
              reset,
            };
            return;
          }
          this.disarmRegenerate();
          const token = await this.plugin.mcpServer.regenerateToken();
          showFingerprint();
          new Notice(this.plugin.t('New MCP token issued. The old token no longer works.'));
          try {
            await navigator.clipboard.writeText(token);
            new Notice(this.plugin.t('New MCP token copied to clipboard.'));
          } catch {
            new Notice(this.plugin.t('The new token could not be copied. Use "Copy token".'));
          }
        });
      });
    const fingerprintEl = tokenSetting.descEl.createDiv();
    const showFingerprint = (): void => {
      const token = this.plugin.settings.mcpToken;
      fingerprintEl.setText(token ? this.plugin.t('Current token ends in {0}.', tokenFingerprint(token)) : '');
    };
    showFingerprint();
  }

  hide(): void {
    // A field still being edited when the tab closed (#321, #328).
    for (const commit of this.pendingCommits.splice(0)) commit();
    this.disarmRegenerate();
    this.askAboutGlobalFolderChange();
    this.askAboutRemovedSampleTypes();
  }

  /**
   * When custom sample types were removed while the tab was open and samples
   * of them are stored, offer to put the types back (#137): otherwise those
   * samples silently stop showing. Asked once settings has closed, like the
   * folder move.
   */
  private askAboutRemovedSampleTypes(): void {
    const removed = removedCustomSampleTypes(this.sampleTypesBaseline ?? [], this.plugin.settings.customSampleTypes);
    if (removed.length === 0) {
      this.sampleTypesBaseline = undefined;
      return;
    }
    const check = (): void => {
      if (document.querySelector('.modal-container')) {
        this.sampleTypesPromptTimer = window.setTimeout(check, 250);
        return;
      }
      this.sampleTypesPromptTimer = undefined;
      this.sampleTypesBaseline = undefined;
      this.offerToRestoreSampleTypes(removed).catch(err =>
        console.warn('[labnoteo] could not check the removed sample types:', err)
      );
    };
    window.clearTimeout(this.sampleTypesPromptTimer);
    this.sampleTypesPromptTimer = window.setTimeout(check, 250);
  }

  private async offerToRestoreSampleTypes(removed: string[]): Promise<void> {
    const { fs, settings } = this.plugin;
    const folders = [
      settings.globalSampleFolder,
      ...this.app.vault
        .getMarkdownFiles()
        .filter(f => f.name === 'README.labnote.md' && getExperimentDir(f.path) === posix.dirname(f.path))
        .map(f => getExperimentLabsamplesFolder(f.path)!),
    ];
    const left: { type: string; count: number }[] = [];
    for (const type of removed) {
      const texts: string[] = [];
      for (const folder of folders) {
        const file = posix.join(folder, `${type}.json`);
        if (await fs.exists(file)) texts.push(await fs.read(file));
      }
      const count = countSampleRecords(texts);
      if (count > 0) left.push({ type, count });
    }
    if (left.length === 0) return;

    const list = left.map(l => `- ${this.plugin.t('{0}: {1} sample(s)', l.type, String(l.count))}`).join('\n');
    const ok = await confirmModal(
      this.app,
      this.plugin.t('Samples of the removed sample type(s) will no longer show:\n\n{0}\n\nPut the type(s) back in the list?', list),
      this.plugin.t('Put back')
    );
    if (!ok) return;
    const now = this.plugin.settings.customSampleTypes;
    this.plugin.settings.customSampleTypes = [...now, ...left.map(l => l.type).filter(t => !now.includes(t))];
    await this.plugin.saveSettings();
    this.plugin.refreshSampleViews();
    new Notice(this.plugin.t('Put back: {0}', left.map(l => l.type).join(', ')));
  }

  /**
   * When the Global sample folder changed while the tab was open, offer to move
   * the samples left in the old one — once settings has closed, so the question
   * is not a modal over the settings modal (#107), and only for the final value.
   */
  private askAboutGlobalFolderChange(): void {
    const from = this.globalFolderBaseline;
    const to = this.plugin.settings.globalSampleFolder;
    if (from === undefined || !to || isSameSampleFolder(from, to)) {
      this.globalFolderBaseline = undefined;
      return;
    }
    const check = (): void => {
      if (document.querySelector('.modal-container')) {
        this.globalFolderPromptTimer = window.setTimeout(check, 250);
        return;
      }
      this.globalFolderPromptTimer = undefined;
      this.globalFolderBaseline = undefined;
      this.plugin.offerGlobalSampleFolderMove(from, to);
    };
    window.clearTimeout(this.globalFolderPromptTimer);
    this.globalFolderPromptTimer = window.setTimeout(check, 250);
  }

  /** Put the regenerate button back to its first-click state. */
  private disarmRegenerate(): void {
    if (!this.regenerateArm) return;
    window.clearTimeout(this.regenerateArm.timer);
    this.regenerateArm.reset();
    this.regenerateArm = undefined;
  }
}
