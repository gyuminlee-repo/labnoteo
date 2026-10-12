/**
 * Settings tab for the Labnote Assistant plugin.
 *
 * Sample options mirror the companion VS Code extension's settings; the LLM section is
 * Obsidian-specific (the desktop build talks to Ollama/OpenAI directly).
 */
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LabnotePlugin from './main';
import { DEFAULT_SETTINGS, type LlmProviderKind } from './settings';
import { openUserGuide } from './userGuide';

export class LabnoteSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LabnotePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl)
      .setName(this.plugin.t('User guide'))
      .setDesc(
        this.plugin.t(
          'New here? Open the quick-start guide. Searching "Labnote" in the command palette lists every command.'
        )
      )
      .addButton(b =>
        b
          .setButtonText(this.plugin.t('Open user guide'))
          .setCta()
          .onClick(() => {
            // Settings is a modal: close it or the guide opens hidden behind it.
            (this.app as unknown as { setting?: { close(): void } }).setting?.close();
            void openUserGuide(this.plugin.host);
          })
      );

    new Setting(containerEl).setName(this.plugin.t('Samples')).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t('Sample tracking'))
      .setDesc(this.plugin.t('Autocomplete, highlighting and {Type}.json sync. Reload to apply.'))
      .addToggle(t =>
        t.setValue(s.sampleTracking).onChange(v => {
          s.sampleTracking = v;
          save();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('Custom sample types'))
      .setDesc(this.plugin.t('Comma-separated types in addition to the built-ins.'))
      .addText(t =>
        t
          .setPlaceholder('CellLine, Strain')
          .setValue(s.customSampleTypes.join(', '))
          .onChange(v => {
            s.customSampleTypes = v
              .split(',')
              .map(x => x.trim())
              .filter(Boolean);
            save();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('Global sample folder'))
      .setDesc(this.plugin.t('Vault-relative folder for vault-global samples.'))
      .addText(t => {
        t.setValue(s.globalSampleFolder).onChange(v => {
          s.globalSampleFolder = v.trim();
          save();
        });
        // An empty Global folder silently breaks Global-scope reads/writes; if
        // the user clears the field, restore the default when focus leaves.
        t.inputEl.addEventListener('blur', () => {
          if (!s.globalSampleFolder) {
            s.globalSampleFolder = DEFAULT_SETTINGS.globalSampleFolder;
            t.setValue(s.globalSampleFolder);
            save();
          }
        });
      });

    new Setting(containerEl).setName(this.plugin.t('Workflows')).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t('Auto-sync unit operation TOC'))
      .setDesc(
        this.plugin.t(
          "Reorder a workflow note's Related Unit Operations list to match heading order after edits, and tidy the --- separators immediately when a block is moved."
        )
      )
      .addToggle(t =>
        t.setValue(s.autoSyncUnitOpToc).onChange(v => {
          s.autoSyncUnitOpToc = v;
          save();
        })
      );

    new Setting(containerEl).setName(this.plugin.t('AI provider')).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t('Provider'))
      .addDropdown(d =>
        d
          .addOption('none', this.plugin.t('Disabled'))
          .addOption('ollama', 'Ollama')
          .addOption('openai', 'OpenAI-compatible')
          .setValue(s.llmProvider)
          .onChange(v => {
            s.llmProvider = v as LlmProviderKind;
            save();
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('Ollama endpoint'))
      .addText(t =>
        t.setValue(s.llmEndpointOllama).onChange(v => {
          s.llmEndpointOllama = v.trim();
          save();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('OpenAI endpoint'))
      .addText(t =>
        t.setValue(s.llmEndpointOpenai).onChange(v => {
          s.llmEndpointOpenai = v.trim();
          save();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('Model'))
      .addText(t =>
        t.setValue(s.llmModel).onChange(v => {
          s.llmModel = v.trim();
          save();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('API key'))
      .setDesc(this.plugin.t('Only sent to OpenAI-compatible providers, never to Ollama.'))
      .addText(t => {
        t.inputEl.type = 'password';
        // Debounce persistence so we don't hit disk on every keystroke of a key.
        let timer: number | undefined;
        t.setValue(s.llmApiKey).onChange(v => {
          s.llmApiKey = v;
          window.clearTimeout(timer);
          timer = window.setTimeout(() => void this.plugin.saveSettings(), 500);
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t('Enable MCP server'))
      .setDesc(this.plugin.t('Desktop only. Exposes tools to external MCP clients.'))
      .addToggle(t =>
        t.setValue(s.mcpEnabled).onChange(v => {
          // Drive the live server from the toggle so the setting and the running
          // state stay consistent (matching the command's behaviour).
          s.mcpEnabled = v;
          save();
          if (v) this.plugin.mcpServer.start();
          else this.plugin.mcpServer.stop();
        })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('MCP token'))
      .setDesc(
        this.plugin.t('Copy the bearer token for external MCP clients (server must be running).')
      )
      .addButton(b =>
        b.setButtonText(this.plugin.t('Copy token')).onClick(async () => {
          const token = this.plugin.mcpServer.currentToken();
          if (!token) {
            new Notice(this.plugin.t('Start the MCP server first.'));
            return;
          }
          await navigator.clipboard.writeText(token);
          new Notice(this.plugin.t('MCP token copied to clipboard.'));
        })
      );
  }
}
