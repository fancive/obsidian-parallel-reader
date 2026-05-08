'use strict';

import { type App, Modal, Notice, Setting } from 'obsidian';
import type { CliErrorDetails } from './cli';
import { translate } from './i18n';
import type { ErrorKind, PluginSettings } from './types';
import { copyToClipboard } from './ui-helpers';

export interface GenerationErrorContext {
  app: App;
  settings: PluginSettings;
  /** Open the plugin settings tab (best-effort; falls back to no-op if unavailable). */
  openSettings: () => void;
}

interface ActionableNoticeAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

function showActionableNotice(message: string, actions: ActionableNoticeAction[], durationMs = 12000): Notice {
  const notice = new Notice('', durationMs);
  const root = notice.messageEl;
  root.addClass('parallel-reader-error-notice');
  root.createDiv({ cls: 'parallel-reader-error-notice-message', text: message });
  if (actions.length > 0) {
    const buttonRow = root.createDiv({ cls: 'parallel-reader-error-notice-actions' });
    for (const action of actions) {
      const btn = buttonRow.createEl('button', {
        cls: action.primary ? 'parallel-reader-error-notice-button mod-cta' : 'parallel-reader-error-notice-button',
        text: action.label,
        attr: { type: 'button' },
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          action.onClick();
        } catch (err: unknown) {
          console.error('[parallel-reader] error notice action failed', err);
        } finally {
          notice.hide();
        }
      });
    }
  }
  return notice;
}

class TimeoutDiagnosticsModal extends Modal {
  private readonly settings: PluginSettings;
  private readonly details: CliErrorDetails;
  private readonly fullMessage: string;
  private readonly onOpenSettings: () => void;

  constructor(
    app: App,
    settings: PluginSettings,
    details: CliErrorDetails,
    fullMessage: string,
    onOpenSettings: () => void,
  ) {
    super(app);
    this.settings = settings;
    this.details = details;
    this.fullMessage = fullMessage;
    this.onOpenSettings = onOpenSettings;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('parallel-reader-error-modal');
    contentEl.createEl('h2', { text: translate(this.settings, 'errorModalTimeoutTitle') });

    const reasonKey = this.details.reason === 'idle-timeout' ? 'errorModalReasonIdle' : 'errorModalReasonWall';
    contentEl.createEl('p', { text: translate(this.settings, reasonKey) });

    const grid = contentEl.createDiv({ cls: 'parallel-reader-error-modal-grid' });
    const addRow = (label: string, value: string) => {
      const row = grid.createDiv({ cls: 'parallel-reader-error-modal-row' });
      row.createSpan({ cls: 'parallel-reader-error-modal-label', text: label });
      row.createSpan({ cls: 'parallel-reader-error-modal-value', text: value });
    };
    addRow(translate(this.settings, 'errorModalFieldCmd'), this.details.cmd);
    addRow(translate(this.settings, 'errorModalFieldPid'), String(this.details.pid ?? '—'));
    addRow(translate(this.settings, 'errorModalFieldElapsed'), `${this.details.elapsedMs}ms`);
    addRow(
      translate(this.settings, 'errorModalFieldIdle'),
      this.details.idleMs == null ? '—' : `${this.details.idleMs}ms`,
    );
    addRow(
      translate(this.settings, 'errorModalFieldBytes'),
      `stdout ${this.details.stdoutBytes}B / stderr ${this.details.stderrBytes}B`,
    );

    if (this.details.stderrTail) {
      contentEl.createEl('h3', { text: translate(this.settings, 'errorModalStderrTail') });
      contentEl.createEl('pre', { cls: 'parallel-reader-error-modal-tail', text: this.details.stderrTail });
    } else if (this.details.stdoutTail) {
      contentEl.createEl('h3', { text: translate(this.settings, 'errorModalStdoutTail') });
      contentEl.createEl('pre', { cls: 'parallel-reader-error-modal-tail', text: this.details.stdoutTail });
    } else {
      contentEl.createEl('p', {
        cls: 'parallel-reader-error-modal-empty',
        text: translate(this.settings, 'errorModalNoOutput'),
      });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText(translate(this.settings, 'errorModalActionCopy')).onClick(() => {
          void copyToClipboard(this.fullMessage, translate(this.settings, 'errorModalCopySuccess'));
        }),
      )
      .addButton((b) =>
        b
          .setButtonText(translate(this.settings, 'errorModalActionOpenSettings'))
          .setCta()
          .onClick(() => {
            this.onOpenSettings();
            this.close();
          }),
      )
      .addButton((b) => b.setButtonText(translate(this.settings, 'errorModalActionClose')).onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function showGenerationError(
  ctx: GenerationErrorContext,
  kind: ErrorKind,
  error: unknown,
  message: string,
): void {
  const tr = (k: string, vars?: Record<string, string | number>) => translate(ctx.settings, k, vars);

  if (kind === 'timeout') {
    const details = (error as { details?: CliErrorDetails }).details;
    if (details) {
      // Open a modal so users can read the stderr tail at leisure and copy it.
      new TimeoutDiagnosticsModal(ctx.app, ctx.settings, details, message, ctx.openSettings).open();
      return;
    }
    // API streaming timeout: no structured details, show actionable notice with raw message tail.
    showActionableNotice(tr('errorNoticeTimeout'), [
      {
        label: tr('errorActionCopyDetails'),
        onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
      },
      { label: tr('errorActionOpenSettings'), primary: true, onClick: ctx.openSettings },
    ]);
    return;
  }

  if (kind === 'auth') {
    showActionableNotice(tr('errorNoticeAuth'), [
      { label: tr('errorActionOpenSettings'), primary: true, onClick: ctx.openSettings },
    ]);
    return;
  }

  if (kind === 'rate-limit') {
    showActionableNotice(tr('errorNoticeRateLimit', { error: message }), [
      {
        label: tr('errorActionCopyDetails'),
        onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
      },
    ]);
    return;
  }

  if (kind === 'schema') {
    showActionableNotice(tr('errorNoticeSchema'), [
      {
        label: tr('errorActionCopyRaw'),
        primary: true,
        onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
      },
      { label: tr('errorActionOpenSettings'), onClick: ctx.openSettings },
    ]);
    return;
  }

  if (kind === 'config') {
    showActionableNotice(tr('errorNoticeConfig', { error: message }), [
      { label: tr('errorActionOpenSettings'), primary: true, onClick: ctx.openSettings },
    ]);
    return;
  }

  // Unknown / fallback: keep the legacy short Notice with kind tag, no buttons.
  new Notice(tr('generationFailed', { kind: kind === 'unknown' ? '' : ` (${kind})`, error: message }));
}
