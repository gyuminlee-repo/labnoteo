/** The "partbank" group of the settings tab. */
import { Notice, Platform, type Setting } from 'obsidian';
import type { PartbankConnection } from '@labnoteo/core';
import { isDesktopOrigin } from '@labnoteo/core';
import type LabnotePlugin from '../main';
import { isValidPartbankUrl } from '../settings';
import type { SettingRow, SettingSection } from '../settingRows';

export function partbankSettingSection(plugin: LabnotePlugin): SettingSection {
  const { t, settings: s } = plugin;
  const save = (): void => void plugin.saveSettings();

  // The desktop app runs on this machine, so it is unreachable from a phone.
  const kinds: PartbankConnection[] = Platform.isDesktopApp ? ['desktop', 'web'] : ['web'];
  const rows: SettingRow[] = [
    {
      name: '',
      desc: t(
        'Register DNA parts, plasmids and primers from partbank as samples, read their storage location, and open them in partbank. Issue an API key in partbank under Profile - API Keys; it is kept on this PC only, not in the vault.'
      ),
    },
  ];
  for (const kind of kinds) rows.push(...connectionRows(plugin, kind, save));

  if (kinds.length > 1) {
    rows.push({
      name: t('Connection to search'),
      desc: t(
        'Which partbank the autocomplete search and the catalog download use. A link made through the desktop app points at this PC only, so a vault shared with the lab should use the server.'
      ),
      render: setting =>
        setting.addDropdown(d =>
          d
            .addOption('web', t('partbank server'))
            .addOption('desktop', t('partbank desktop app'))
            .setValue(s.partbankDefaultConnection)
            .onChange(v => {
              s.partbankDefaultConnection = v as PartbankConnection;
              save();
            })
        ),
    });
  }
  rows.push({
    name: t('Send note usages to partbank'),
    desc: t(
      'Lists the lab notes that use a sample from partbank on its partbank page. Note paths, experiment folder names and section titles are stored on the partbank server and shown to you only. Turning this off deletes what this PC sent.'
    ),
    render: setting =>
      setting.addToggle(toggle =>
        toggle.setValue(s.partbankSendUsages).onChange(on => {
          s.partbankSendUsages = on;
          save();
          void (on ? plugin.partbankUsages.syncAll() : plugin.partbankUsages.disable());
        })
      ),
  });
  return { heading: t('partbank'), rows };
}

function connectionRows(plugin: LabnotePlugin, kind: PartbankConnection, save: () => void): SettingRow[] {
  const { t, settings: s } = plugin;
  const feature = plugin.partbank;
  const isDesktop = kind === 'desktop';
  const label = isDesktop ? t('partbank desktop app') : t('partbank server');

  // Shared by the two rows of one draw: the key row tests what the address field holds.
  let showUrlState = (_value: string): void => {};
  let urlValue = (): string => feature.url(kind);

  const renderUrl = (urlSetting: Setting): void => {
    const urlWarning = urlSetting.descEl.createDiv();
    showUrlState = (value: string): void => {
      urlWarning.empty();
      urlWarning.removeClass('mod-warning');
      if (!value.trim()) return;
      if (!isValidPartbankUrl(value)) {
        urlWarning.addClass('mod-warning');
        urlWarning.setText(t('Enter a full address starting with http:// or https://.'));
        return;
      }
      // The API key travels on every call, so plain HTTP to another machine
      // hands it to anyone on the way.
      if (!isDesktop && value.trim().startsWith('http://') && !isDesktopOrigin(value)) {
        urlWarning.addClass('mod-warning');
        urlWarning.setText(t('This address is not encrypted, so the API key is sent in the clear.'));
      }
    };
    urlSetting.addText(text => {
      urlValue = () => text.getValue().trim();
      text
        .setPlaceholder(isDesktop ? 'http://127.0.0.1:47830' : 'https://partbank.kbiofoundry.kr')
        .setValue(feature.url(kind));
      text.inputEl.style.width = '100%';
      text.onChange(v => showUrlState(v));
      text.inputEl.addEventListener('blur', () => {
        const value = text.getValue().trim();
        if (value && !isValidPartbankUrl(value)) return;
        if (isDesktop) s.partbankDesktopUrl = value;
        else s.partbankWebUrl = value;
        save();
      });
    });
    showUrlState(feature.url(kind));
  };

  const renderKey = (keySetting: Setting): void => {
    const keyState = keySetting.descEl.createDiv();
    let keyValue = (): string => feature.apiKey(kind);
    keySetting.addText(text => {
      keyValue = () => text.getValue().trim();
      text.setPlaceholder('pbk_...').setValue(feature.apiKey(kind));
      text.inputEl.type = 'password';
      text.inputEl.style.width = '100%';
      text.inputEl.addEventListener('blur', () => feature.setApiKey(kind, text.getValue()));
    });
    keySetting.addButton(b =>
      // What the fields hold now, saved or not (#278).
      b.setButtonText(t('Test connection')).onClick(async () => {
        const url = urlValue();
        const apiKey = keyValue();
        if (!url || !apiKey) {
          new Notice(t('Enter the address and the API key first.'));
          return;
        }
        if (!isValidPartbankUrl(url)) {
          showUrlState(url);
          keyState.addClass('mod-warning');
          keyState.setText(t('Enter a full address starting with http:// or https://.'));
          return;
        }
        keyState.removeClass('mod-warning');
        keyState.setText(t('Checking…'));
        try {
          const who = await feature.probeClient(kind, url, apiKey).whoAmI();
          keyState.setText(t('Connected as {0}.', who));
        } catch (err) {
          keyState.addClass('mod-warning');
          keyState.setText(feature.describeProbeError(err, kind));
        }
      })
    );
  };

  return [
    {
      name: t('{0} address', label),
      desc: isDesktop
        ? t('The address the desktop app serves its API on. Change it only if you moved its port.')
        : t('The address of your lab’s partbank server.'),
      render: renderUrl,
    },
    {
      name: t('{0} API key', label),
      desc: t('Kept on this PC and this vault only, never written to the vault.'),
      render: renderKey,
    },
  ];
}
