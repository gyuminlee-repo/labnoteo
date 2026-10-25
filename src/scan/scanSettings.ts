/** The "Barcode & scans" group of the settings tab. */
import { Notice, Platform, type TextComponent } from 'obsidian';
import type LabnotePlugin from '../main';
import {
  parseRangedNumber,
  SCAN_EMBED_WIDTH_RANGE,
  SCAN_IMAGE_EDGE_RANGE,
  type WorksheetPaperSize,
} from '../settings';
import { commitOnChange, type SettingSection } from '../settingRows';
import { isInsideFolder, type ScanFolderMode } from './scanFolderWatcher';
import type { SlackMode } from './slack';

/** What the settings tab lends the sections it draws. */
export interface SettingsContext {
  /** Draw the tab again, after a change that adds or removes rows. */
  redraw: () => void;
  /** Run `commit` when the tab closes, for a field still being edited. */
  onHide: (commit: () => void) => void;
}

/**
 * A number field saved when it is left (#321): a value outside the range is
 * refused with a notice and the field goes back to the saved value.
 */
function numberField(
  plugin: LabnotePlugin,
  ctx: SettingsContext,
  text: TextComponent,
  opts: {
    label: string;
    range: { min: number; max: number };
    allowed: string;
    also?: number[];
    get: () => number;
    set: (n: number) => void;
  }
): void {
  text.inputEl.type = 'number';
  text.setValue(String(opts.get()));
  ctx.onHide(
    commitOnChange(text, value => {
      const n = parseRangedNumber(value, opts.range, opts.also);
      if (n === undefined) {
        new Notice(
          plugin.t(
            '{0} takes {1}; the value was not saved and is back to {2}.',
            opts.label,
            opts.allowed,
            String(opts.get())
          ),
          8000
        );
        return String(opts.get());
      }
      if (n !== opts.get()) {
        opts.set(n);
        void plugin.saveSettings();
      }
      return String(n);
    })
  );
}

export function scanSettingSections(plugin: LabnotePlugin, ctx: SettingsContext): SettingSection[] {
  const { t, settings: s } = plugin;
  const feature = plugin.barcode;
  const save = () => void plugin.saveSettings();
  const hasWatcher = () => Boolean(feature.watcher) && Platform.isDesktopApp;
  let mode: ScanFolderMode = 'dedicated';

  const edge = SCAN_IMAGE_EDGE_RANGE;
  const width = SCAN_EMBED_WIDTH_RANGE;
  return [
    {
      heading: t('Barcode & scans'),
      rows: [
        {
          name: t('Worksheet paper size'),
          aliases: ['A4', 'Letter'],
          render: setting =>
            setting.addDropdown(d =>
              d
                .addOption('a4', 'A4')
                .addOption('letter', 'Letter')
                .setValue(s.worksheetPaperSize)
                .onChange(v => {
                  s.worksheetPaperSize = v as WorksheetPaperSize;
                  save();
                })
            ),
        },
        {
          name: t('Scan folder'),
          desc: t(
            'A folder on this PC where photos and scans arrive (Google Drive folder, scanner share, KakaoTalk downloads…). Checked every 30 seconds. Stored for this PC only; set it on one PC.'
          ),
          visible: hasWatcher,
          render: setting => {
            const watcher = feature.watcher!;
            const cfg = watcher.config();
            let path = cfg?.path ?? '';
            mode = cfg?.mode ?? 'dedicated';
            setting.addText(text => {
              text.setPlaceholder('C:\\Users\\me\\Google Drive\\labnote-scans').setValue(path);
              text.inputEl.style.width = '100%';
              text.onChange(v => (path = v));
              text.inputEl.addEventListener('blur', () => {
                if ((watcher.config()?.path ?? '') === path.trim()) return;
                watcher.setConfig(path, mode);
                showFolderState();
              });
            });
            const stateEl = setting.descEl.createDiv();
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
          },
        },
        {
          name: t('Scan folder mode'),
          desc: t('Dedicated: a folder only for scans; originals are moved to labnote-processed/ or labnote-failed/ inside it. Shared: a folder with other files too (KakaoTalk, camera uploads); originals stay, files without a worksheet QR code are left alone.'),
          visible: hasWatcher,
          render: setting =>
            setting.addDropdown(d =>
              d
                .addOption('dedicated', t('Dedicated folder'))
                .addOption('shared', t('Shared folder'))
                .setValue(mode)
                .onChange(v => {
                  mode = v as ScanFolderMode;
                  const watcher = feature.watcher!;
                  if (watcher.config()) watcher.setConfig(watcher.config()!.path, mode);
                })
            ),
        },
        {
          name: t('Process scan folder now'),
          desc: t('Files already in the folder when it was set are skipped; process them once with the second button.'),
          visible: hasWatcher,
          render: setting =>
            setting
              .addButton(b => b.setButtonText(t('Process now')).onClick(() => feature.processFolderNow()))
              .addButton(b =>
                b.setButtonText(t('Process existing files too')).onClick(() => feature.processFolderNow(true))
              ),
        },
        {
          name: t('Unmatched scans'),
          render: setting => {
            const unmatched = feature.unmatchedCount();
            setting
              .setDesc(
                unmatched > 0 ? t('{0} page(s) wait to be assigned to a note.', String(unmatched)) : t('No unmatched scans.')
              )
              .addButton(b => b.setButtonText(t('Assign unmatched scans')).onClick(() => feature.openUnmatched()));
          },
        },
        {
          name: t('Stored scan size'),
          desc: t('Long edge in pixels that a scanned page is scaled down to before it is stored ({0}–{1}).', String(edge.min), String(edge.max)),
          render: setting =>
            setting.addText(text =>
              numberField(plugin, ctx, text, {
                label: t('Stored scan size'),
                range: edge,
                allowed: `${edge.min}–${edge.max}`,
                get: () => s.scanMaxImageEdge,
                set: n => (s.scanMaxImageEdge = n),
              })
            ),
        },
        {
          name: t('Stored scan quality'),
          desc: t('JPEG quality of stored scans. Lower makes smaller files.'),
          render: setting =>
            setting.addSlider(slider =>
              slider
                .setLimits(50, 100, 5)
                .setValue(Math.round(s.scanJpegQuality * 100))
                .setDynamicTooltip()
                .onChange(v => {
                  s.scanJpegQuality = v / 100;
                  save();
                })
            ),
        },
        {
          name: t('Scan width in notes'),
          desc: t('Width in pixels of scans shown in notes ({0}–{1}); 0 shows them full size. Scans already filed keep their size.', String(width.min), String(width.max)),
          render: setting =>
            setting.addText(text =>
              numberField(plugin, ctx, text, {
                label: t('Scan width in notes'),
                range: width,
                allowed: t('0 or {0}–{1}', String(width.min), String(width.max)),
                also: [0],
                get: () => s.scanEmbedWidth,
                set: n => (s.scanEmbedWidth = n),
              })
            ),
        },
      ],
    },
    slackSettingSection(plugin, ctx),
  ];
}

function slackSettingSection(plugin: LabnotePlugin, ctx: SettingsContext): SettingSection {
  const { t } = plugin;
  const slack = plugin.barcode.slack;
  const linked = () => Boolean(slack.config());
  const unlinked = () => !linked();

  let token = '';
  let mode: SlackMode = 'dm';
  let channelId = '';
  return {
    heading: t('Slack scans (optional)'),
    rows: [
      {
        name: t('Slack connection'),
        visible: linked,
        render: setting => {
          const cfg = slack.config()!;
          const status = slack.status();
          const statusDesc =
            status === 'linked'
              ? t('Linked. Files you send to the bot ({0}) are filed every 90 seconds.', cfg.mode === 'dm' ? t('direct message') : cfg.channelId ?? '')
              : t('Waiting for the link code. Send {0} to the bot as a direct message (or post it in the channel).', cfg.linkCode ?? '');
          setting
            .setDesc(slack.lastError ? `${statusDesc} ${t('Last check failed: {0}', slack.lastError)}` : statusDesc)
            .addButton(b =>
              b
                .setButtonText(t('Disconnect'))
                .setWarning()
                .onClick(() => {
                  slack.disconnect();
                  ctx.redraw();
                })
            );
        },
      },
      {
        name: t('Slack bot token'),
        desc: t('xoxb-… token of a Slack app you made for yourself. Stored on this PC only. See docs/SCAN.md for the steps.'),
        visible: unlinked,
        render: setting =>
          setting.addText(text => {
            // A fresh form on every draw: the rows outlive one draw on Obsidian 1.13+.
            token = '';
            mode = 'dm';
            channelId = '';
            text.inputEl.type = 'password';
            text.setPlaceholder('xoxb-…').onChange(v => (token = v));
          }),
      },
      {
        name: t('Where you send scans'),
        visible: unlinked,
        render: setting =>
          setting
            .addDropdown(d =>
              d
                .addOption('dm', t('Direct message to the bot'))
                .addOption('channel', t('Private channel'))
                .setValue(mode)
                .onChange(v => (mode = v as SlackMode))
            )
            .addText(text => text.setPlaceholder(t('Channel ID (C…)')).onChange(v => (channelId = v))),
      },
      {
        name: '',
        visible: unlinked,
        render: setting =>
          setting.addButton(b =>
            b
              .setButtonText(t('Connect'))
              .setCta()
              .onClick(async () => {
                if (!/^xoxb-/.test(token.trim())) {
                  new Notice(t('Enter the bot token (it starts with xoxb-).'));
                  return;
                }
                if (mode === 'channel' && !/^[CG][A-Z0-9]+$/.test(channelId.trim())) {
                  new Notice(t('Enter the channel ID (it starts with C).'));
                  return;
                }
                // Check the token, its permissions and (for a channel) the invite
                // before making a link code, so a mistake shows up now rather than
                // as a silent "waiting" state.
                b.setDisabled(true);
                try {
                  const check = await slack.verify(token.trim(), mode, channelId.trim());
                  if (check.missingScopes.length) {
                    new Notice(t('The Slack token is missing permissions: {0}. Add them under OAuth & Permissions and reinstall the app.', check.missingScopes.join(', ')), 15000);
                    return;
                  }
                  if (check.notInChannel) {
                    new Notice(t('The bot is not in that channel. In the channel, run /invite @{0} and press Connect again.', check.botName), 15000);
                    return;
                  }
                  if (check.missingRecommended) {
                    new Notice(t('Tip: the {0} permission lets the bot mark messages with 👀 so two PCs never file the same photo.', 'reactions:write'), 15000);
                  }
                  const code = slack.beginLink(token, mode, channelId);
                  new Notice(t('Connected to the bot {0}. Send {1} to it in Slack to link this PC.', check.botName, code), 15000);
                  slack.start();
                  ctx.redraw();
                } catch (err) {
                  new Notice(t('Could not verify the Slack token: {0}', err instanceof Error ? err.message : String(err)), 15000);
                } finally {
                  b.setDisabled(false);
                }
              })
          ),
      },
    ],
  };
}
