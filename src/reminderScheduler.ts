import { Notice, TFile, normalizePath } from "obsidian";
import type ObsiDropPlugin from "./main";
import { LightboxModal } from "./lightbox";
import { EditNoteModal } from "./edit";
import { parseReminderMs, readMeta } from "./metadata";
import { t } from "./i18n";

/**
 * Houdt window-timeouts bij per notitie-pad zodat reminders kunnen worden
 * herschikt zodra een notitie wijzigt, en netjes opgeruimd bij plugin-unload.
 * setTimeout heeft een max delay van ~24.8 dagen — voor reminders verder weg
 * herplannen we elke dag i.p.v. één gigantische timeout.
 */
export class ReminderScheduler {
  private plugin: ObsiDropPlugin;
  private timers: Map<string, number> = new Map();
  private static readonly MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24 h, ruim onder browser-limiet

  constructor(plugin: ObsiDropPlugin) {
    this.plugin = plugin;
  }

  scheduleAll(): void {
    this.cancelAll();
    const root = normalizePath(this.plugin.settings.notesFolder);
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f) =>
      f.path === root || f.path.startsWith(`${root}/`),
    );
    for (const file of files) this.scheduleFile(file);
  }

  scheduleFile(file: TFile): void {
    this.cancelFile(file.path);
    const meta = readMeta(this.plugin.app, file);
    const ms = parseReminderMs(meta.reminder);
    if (!Number.isFinite(ms)) return;

    const delay = ms - Date.now();
    if (delay <= 0) return; // Reeds verlopen — kaart toont "Verlopen"-badge; we vuren niet retroactief.

    if (delay > ReminderScheduler.MAX_DELAY_MS) {
      // Wacht 24 u en herevalueer; vermijdt browser-setTimeout overflow op
      // verre data en maakt herstart na slaapstand robuuster.
      const id = window.setTimeout(() => {
        this.timers.delete(file.path);
        this.scheduleFile(file);
      }, ReminderScheduler.MAX_DELAY_MS);
      this.timers.set(file.path, id);
      return;
    }

    const id = window.setTimeout(() => {
      this.timers.delete(file.path);
      this.fire(file);
    }, delay);
    this.timers.set(file.path, id);
  }

  cancelFile(path: string): void {
    const id = this.timers.get(path);
    if (id !== undefined) {
      window.clearTimeout(id);
      this.timers.delete(path);
    }
  }

  cancelAll(): void {
    for (const id of this.timers.values()) window.clearTimeout(id);
    this.timers.clear();
  }

  private fire(file: TFile): void {
    // Notice met klik-handler → opent lightbox als er een attachment is,
    // anders de edit-modal.
    const notice = new Notice(t("notice_reminder_fired", file.basename), 30_000);
    notice.noticeEl.addClass("obsidrop-reminder-notice");
    notice.noticeEl.addEventListener("click", () => {
      notice.hide();
      this.openCard(file);
    });
  }

  private async openCard(file: TFile): Promise<void> {
    // Probeer een ingebedde afbeelding te vinden voor lightbox; anders edit-modal.
    const content = await this.plugin.app.vault.cachedRead(file);
    const m = content.match(/!\[\[([^\]|]+?)\]\]/);
    if (m) {
      const basename = m[1].trim().split("|")[0].trim();
      const resourcePath = this.plugin.app.vault.adapter.getResourcePath(
        normalizePath(`${file.parent?.path ?? ""}/.attachments/${basename}`),
      );
      new LightboxModal(this.plugin.app, this.plugin, file, resourcePath, null).open();
      return;
    }
    new EditNoteModal(this.plugin.app, this.plugin, file).open();
  }
}
