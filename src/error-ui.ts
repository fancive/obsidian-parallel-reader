'use strict';

import { type App, Modal, Notice, Setting } from 'obsidian';
import type { CliErrorDetails } from './cli';
import { translate } from './i18n';
import type { ErrorKind, PluginSettings } from './types';
import { copyToClipboard } from './ui-helpers';

interface GenerationErrorContext {
  app: App;
  settings: PluginSettings;
  /** Open the plugin settings tab (best-effort; falls back to no-op if unavailable). */
  openSettings: () => void;
  /** Re-run the generation that failed (used by retryable error kinds such as network). */
  onRetry?: () => void;
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

/**
 * Retry action, hoisted so every re-rollable error kind wires it up the same way instead of
 * four copies of the same `if (ctx.onRetry) actions.push(...)` line. Returns an empty array
 * when no retry callback was supplied so callers can always spread it into their actions list.
 */
function retryAction(
  ctx: GenerationErrorContext,
  tr: (key: string, vars?: Record<string, string | number>) => string,
): ActionableNoticeAction[] {
  return ctx.onRetry ? [{ label: tr('errorActionRetry'), primary: true, onClick: ctx.onRetry }] : [];
}

function reasonCopyKeys(reason: CliErrorDetails['reason']): { titleKey: string; reasonKey: string } {
  switch (reason) {
    case 'wall-timeout':
      return { titleKey: 'errorModalTimeoutTitle', reasonKey: 'errorModalReasonWall' };
    case 'exit-nonzero':
      return { titleKey: 'errorModalExitTitle', reasonKey: 'errorModalReasonExit' };
    case 'spawn-failure':
    case 'startup-error':
      return { titleKey: 'errorModalStartupTitle', reasonKey: 'errorModalReasonStartup' };
    default:
      return { titleKey: 'errorModalTimeoutTitle', reasonKey: 'errorModalReasonWall' };
  }
}

class CliDiagnosticsModal extends Modal {
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
    const { titleKey, reasonKey } = reasonCopyKeys(this.details.reason);
    contentEl.createEl('h2', { text: translate(this.settings, titleKey) });
    contentEl.createEl('p', { text: translate(this.settings, reasonKey) });
    if (this.details.exitCode != null) {
      contentEl.createEl('p', {
        cls: 'parallel-reader-error-modal-exit',
        text: translate(this.settings, 'errorModalFieldExit', {
          code: String(this.details.exitCode),
          signal: this.details.signal ?? 'none',
        }),
      });
    }

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

    let hasOutput = false;
    if (this.details.stderrTail) {
      contentEl.createEl('h3', { text: translate(this.settings, 'errorModalStderrTail') });
      contentEl.createEl('pre', { cls: 'parallel-reader-error-modal-tail', text: this.details.stderrTail });
      hasOutput = true;
    }
    if (this.details.stdoutTail) {
      contentEl.createEl('h3', { text: translate(this.settings, 'errorModalStdoutTail') });
      contentEl.createEl('pre', { cls: 'parallel-reader-error-modal-tail', text: this.details.stdoutTail });
      hasOutput = true;
    }
    if (!hasOutput) {
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

  // Any structured CLI error opens the diagnostics modal — even when classify falls
  // through to 'unknown' (e.g. exit-nonzero with empty stderr) we want the stdout tail
  // surfaced so the failure is debuggable.
  const cliDetails = (error as { details?: CliErrorDetails }).details;
  const isStructuredCliError = !!cliDetails && typeof cliDetails.reason === 'string';
  if (isStructuredCliError) {
    new CliDiagnosticsModal(ctx.app, ctx.settings, cliDetails, message, ctx.openSettings).open();
    return;
  }

  if (kind === 'timeout') {
    // API streaming timeout: no structured details, show actionable notice with raw message tail.
    // Timeouts are frequently transient (slow model, brief network hang), so retry is the most
    // useful action when available and takes the primary slot.
    showActionableNotice(tr('errorNoticeTimeout'), [
      ...retryAction(ctx, tr),
      {
        label: tr('errorActionCopyDetails'),
        onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
      },
      { label: tr('errorActionOpenSettings'), primary: !ctx.onRetry, onClick: ctx.openSettings },
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
    // Deliberately no countdown/auto-retry: this notice auto-hides (~12s, see
    // showActionableNotice) which is often shorter than a real rate-limit backoff, so a timed
    // button would vanish before it could fire. A plain manual Retry avoids that trap.
    showActionableNotice(tr('errorNoticeRateLimit', { error: message }), [
      ...retryAction(ctx, tr),
      {
        label: tr('errorActionCopyDetails'),
        onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
      },
    ]);
    return;
  }

  if (kind === 'network') {
    showActionableNotice(tr('errorNoticeNetwork'), [
      ...retryAction(ctx, tr),
      {
        label: tr('errorActionCopyDetails'),
        onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
      },
    ]);
    return;
  }

  if (kind === 'schema') {
    showActionableNotice(tr('errorNoticeSchema'), [
      ...retryAction(ctx, tr),
      {
        label: tr('errorActionCopyRaw'),
        primary: !ctx.onRetry,
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

  if (kind === 'cancelled') {
    // Cancellation isn't a failure to retry — keep the legacy quiet Notice, no action buttons.
    new Notice(tr('generationFailed', { kind: ` (${kind})`, error: message }));
    return;
  }

  // Unknown: routed through the same actionable-notice path as the classified kinds above
  // (previously a bare, buttonless Notice). `unknown` is where a lot of real failures land —
  // classifyGenerationError pattern-matches English prose, so non-English locales frequently
  // fall through here — so it needs the same Retry/Copy-details recourse, not a dead end.
  showActionableNotice(tr('generationFailed', { kind: '', error: message }), [
    ...retryAction(ctx, tr),
    {
      label: tr('errorActionCopyDetails'),
      onClick: () => void copyToClipboard(message, tr('errorModalCopySuccess')),
    },
  ]);
}
