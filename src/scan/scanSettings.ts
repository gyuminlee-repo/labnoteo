/** The "Barcode & scans" group of the settings tab. */
import { Notice, Platform, Setting } from 'obsidian';
import type LabnotePlugin from '../main';
import { SCAN_IMAGE_EDGE_RANGE, type WorksheetPaperSize } from '../settings';
import { isInsideFolder, type ScanFolderMode } from './scanFolderWatcher';
import type { SlackMode } from './slack';

export function renderScanSettings(containerEl: HTMLElement, plugin: LabnotePlugin, redraw: () => void): void {
  const { t, settings: s } = plugin;
  const feature = plugin.barcode;
  const save = () => void plugin.saveSettings();

  new Setting(containerEl).setName(t('Barcode & scans')).setHeading();

  new Setting(containerEl)
    .setName(t('Worksheet paper size'))
    .addDropdown(d =>
      d
        .addOption('a4', 'A4')
        .addOption('letter', 'Letter')
        .setValue(s.worksheetPaperSize)
        .onChange(v => {
          s.worksheetPaperSize = v as WorksheetPaperSize;
          save();
        })
    );

  const watcher = feature.watcher;
  if (watcher && Platform.isDesktopApp) {
    const cfg = watcher.config();
    let path = cfg?.path ?? '';
    let mode: ScanFolderMode = cfg?.mode ?? 'dedicated';
    const folderSetting = new Setting(containerEl)
      .setName(t('Scan folder'))
      .setDesc(
        t('A folder on this PC where photos and scans arrive (Google Drive folder, scanner share, KakaoTalk downloads…). Checked every 30 seconds. Stored for this PC only; set it on one PC.')
      )
      .addText(text => {
        text.setPlaceholder('C:\\Users\\me\\Google Drive\\labnote-scans').setValue(path);
        text.inputEl.style.width = '100%';
        text.onChange(v => (path = v));
        text.inputEl.addEventListener('blur', () => {
          if ((watcher.config()?.path ?? '') === path.trim()) return;
          watcher.setConfig(path, mode);
          showFolderState();
        });
      });
    const stateEl = folderSetting.descEl.createDiv();
    const showFolderState = (): void => {
      stateEl.empty();
      stateEl.removeClass('mod-warning');
      const current = watcher.config()?.path;
      if (!current) return;
      const req = (window as unknown as { require: NodeRequire }).require;
      const fs = req('fs') as typeof import('fs');
      let isDir = false;
      try {
        isDir = fs.statSync(current).isDirectory();
      } catch {
        // Missing.
      }
      const base = (plugin.app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.();
      if (!isDir) {
        stateEl.addClass('mod-warning');
        stateEl.setText(t('This folder does not exist on this PC.'));
      } else if (base && isInsideFolder(current, base)) {
        stateEl.addClass('mod-warning');
        stateEl.setText(t('This folder is inside the vault, so the original photos also show up in Obsidian and in git. A folder outside the vault is better.'));
      } else {
        stateEl.setText(t('Watching this folder. Only files added from now on are read.'));
      }
    };
    showFolderState();

    new Setting(containerEl)
      .setName(t('Scan folder mode'))
      .setDesc(t('Dedicated: a folder only for scans; originals are moved to labnote-processed/ or labnote-failed/ inside it. Shared: a folder with other files too (KakaoTalk, camera uploads); originals stay, files without a worksheet QR code are left alone.'))
      .addDropdown(d =>
        d
          .addOption('dedicated', t('Dedicated folder'))
          .addOption('shared', t('Shared folder'))
          .setValue(mode)
          .onChange(v => {
            mode = v as ScanFolderMode;
            if (watcher.config()) watcher.setConfig(watcher.config()!.path, mode);
          })
      );

    new Setting(containerEl)
      .setName(t('Process scan folder now'))
      .setDesc(t('Files already in the folder when it was set are skipped; process them once with the second button.'))
      .addButton(b => b.setButtonText(t('Process now')).onClick(() => feature.processFolderNow()))
      .addButton(b => b.setButtonText(t('Process existing files too')).onClick(() => feature.processFolderNow(true)));
  }

  const unmatched = feature.unmatchedCount();
  new Setting(containerEl)
    .setName(t('Unmatched scans'))
    .setDesc(unmatched > 0 ? t('{0} page(s) wait to be assigned to a note.', String(unmatched)) : t('No unmatched scans.'))
    .addButton(b => b.setButtonText(t('Assign unmatched scans')).onClick(() => feature.openUnmatched()));

  new Setting(containerEl)
    .setName(t('Stored scan size'))
    .setDesc(t('Long edge in pixels that a scanned page is scaled down to before it is stored ({0}–{1}).', String(SCAN_IMAGE_EDGE_RANGE.min), String(SCAN_IMAGE_EDGE_RANGE.max)))
    .addText(text => {
      text.inputEl.type = 'number';
      text.setValue(String(s.scanMaxImageEdge)).onChange(v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= SCAN_IMAGE_EDGE_RANGE.min && n <= SCAN_IMAGE_EDGE_RANGE.max) {
          s.scanMaxImageEdge = Math.round(n);
          save();
        }
      });
    });

  new Setting(containerEl)
    .setName(t('Stored scan quality'))
    .setDesc(t('JPEG quality of stored scans. Lower makes smaller files.'))
    .addSlider(slider =>
      slider
        .setLimits(50, 100, 5)
        .setValue(Math.round(s.scanJpegQuality * 100))
        .setDynamicTooltip()
        .onChange(v => {
          s.scanJpegQuality = v / 100;
          save();
        })
    );

  renderSlackSettings(containerEl, plugin, redraw);
}

function renderSlackSettings(containerEl: HTMLElement, plugin: LabnotePlugin, redraw: () => void): void {
  const { t } = plugin;
  const slack = plugin.barcode.slack;
  const cfg = slack.config();
  new Setting(containerEl).setName(t('Slack scans (optional)')).setHeading();

  if (cfg) {
    const status = slack.status();
    new Setting(containerEl)
      .setName(t('Slack connection'))
      .setDesc(
        status === 'linked'
          ? t('Linked. Files you send to the bot ({0}) are filed every 90 seconds.', cfg.mode === 'dm' ? t('direct message') : cfg.channelId ?? '')
          : t('Waiting for the link code. Send {0} to the bot as a direct message (or post it in the channel).', cfg.linkCode ?? '')
      )
      .addButton(b =>
        b
          .setButtonText(t('Disconnect'))
          .setWarning()
          .onClick(() => {
            slack.disconnect();
            redraw();
          })
      );
    return;
  }

  let token = '';
  let mode: SlackMode = 'dm';
  let channelId = '';
  new Setting(containerEl)
    .setName(t('Slack bot token'))
    .setDesc(t('xoxb-… token of a Slack app you made for yourself. Stored on this PC only. See docs/SCAN.md for the steps.'))
    .addText(text => {
      text.inputEl.type = 'password';
      text.setPlaceholder('xoxb-…').onChange(v => (token = v));
    });
  new Setting(containerEl)
    .setName(t('Where you send scans'))
    .addDropdown(d =>
      d
        .addOption('dm', t('Direct message to the bot'))
        .addOption('channel', t('Private channel'))
        .setValue(mode)
        .onChange(v => (mode = v as SlackMode))
    )
    .addText(text => text.setPlaceholder(t('Channel ID (C…)')).onChange(v => (channelId = v)));
  new Setting(containerEl).addButton(b =>
    b
      .setButtonText(t('Connect'))
      .setCta()
      .onClick(() => {
        if (!/^xox[bp]-/.test(token.trim())) {
          new Notice(t('Enter the bot token (it starts with xoxb-).'));
          return;
        }
        if (mode === 'channel' && !/^[CG][A-Z0-9]+$/.test(channelId.trim())) {
          new Notice(t('Enter the channel ID (it starts with C).'));
          return;
        }
        const code = slack.beginLink(token, mode, channelId);
        new Notice(t('Send {0} to the bot in Slack to link this PC.', code), 15000);
        slack.start();
        redraw();
      })
  );
}
