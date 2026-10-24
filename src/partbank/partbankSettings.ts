/** The "partbank" group of the settings tab. */
import { Notice, Platform, Setting } from 'obsidian';
import type { PartbankConnection } from '@labnoteo/core';
import { isDesktopOrigin } from '@labnoteo/core';
import type LabnotePlugin from '../main';
import { isValidPartbankUrl } from '../settings';

export function renderPartbankSettings(containerEl: HTMLElement, plugin: LabnotePlugin): void {
  const { t, settings: s } = plugin;
  const save = (): void => void plugin.saveSettings();

  new Setting(containerEl).setName(t('partbank')).setHeading();
  new Setting(containerEl).setDesc(
    t(
      'Register DNA parts, plasmids and primers from partbank as samples, read their storage location, and open them in partbank. Issue an API key in partbank under Profile - API Keys; it is kept on this PC only, not in the vault.'
    )
  );

  // The desktop app runs on this machine, so it is unreachable from a phone.
  const kinds: PartbankConnection[] = Platform.isDesktopApp ? ['desktop', 'web'] : ['web'];
  for (const kind of kinds) renderConnection(containerEl, plugin, kind, save);

  if (kinds.length > 1) {
    new Setting(containerEl)
      .setName(t('Connection to search'))
      .setDesc(
        t(
          'Which partbank the autocomplete search and the catalog download use. A link made through the desktop app points at this PC only, so a vault shared with the lab should use the server.'
        )
      )
      .addDropdown(d =>
        d
          .addOption('web', t('partbank server'))
          .addOption('desktop', t('partbank desktop app'))
          .setValue(s.partbankDefaultConnection)
          .onChange(v => {
            s.partbankDefaultConnection = v as PartbankConnection;
            save();
          })
      );
  }
}

function renderConnection(
  containerEl: HTMLElement,
  plugin: LabnotePlugin,
  kind: PartbankConnection,
  save: () => void
): void {
  const { t, settings: s } = plugin;
  const feature = plugin.partbank;
  const isDesktop = kind === 'desktop';
  const label = isDesktop ? t('partbank desktop app') : t('partbank server');

  const urlSetting = new Setting(containerEl)
    .setName(t('{0} address', label))
    .setDesc(
      isDesktop
        ? t('The address the desktop app serves its API on. Change it only if you moved its port.')
        : t('The address of your lab’s partbank server.')
    );
  const urlWarning = urlSetting.descEl.createDiv();
  const showUrlState = (value: string): void => {
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
  let urlValue = (): string => feature.url(kind);
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

  const keySetting = new Setting(containerEl)
    .setName(t('{0} API key', label))
    .setDesc(t('Kept on this PC and this vault only, never written to the vault.'));
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
}
