import { Notice, TAbstractFile, TFile } from "obsidian";
import { fetchOg, buildLinkNote, detectUrl } from "./ogfetch";
import type ObsiDropPlugin from "./main";
import { t } from "./i18n";

/**
 * Pakt placeholder-notities op die Android v0.6.0+ via Syncthing binnenstuurt
 * (gekenmerkt door `<!-- obsidrop-preview: pending -->` of het oudere
 * `diexar-preview`-formaat) en die de Android-side `PreviewWorker` om wat voor
 * reden ook niet kon afronden — bv. omdat de telefoon offline was, de batterij
 * leeg ging, of WorkManager-retries op zijn.
 *
 * Strategie: rescue alleen als de file-mtime ouder is dan `MIN_RESCUE_AGE_MS`.
 * Bij elke modify-event wordt de timer-deadline opnieuw berekend a.d.h.v. de
 * verse mtime — Android's eigen OG-update bumpt de mtime en reset zo onze
 * wachttijd, waardoor we hun verse versie nooit overrulen. Voorkomt
 * Syncthing-conflicts bij trage OG-endpoints (TikTok-oEmbed loopt soms
 * 30s+).
 */

// Accepteer beide markers — `diexar-preview` blijft erin voor placeholders die
// van een oudere Android-build (vóór de rename) zijn binnengekomen.
const PENDING_MARKER_REGEX = /<!--\s*(?:obsidrop|diexar)-preview:\s*pending\s*-->/;
function hasPendingMarker(content: string): boolean {
  return PENDING_MARKER_REGEX.test(content);
}

// Marker moet minstens 5 min oud zijn (volgens file-mtime) voor we ingrijpen.
// Geeft Android ruim baan om z'n eigen PreviewWorker af te ronden, ook bij
// trage OG-endpoints + Syncthing-propagatie-vertraging.
const MIN_RESCUE_AGE_MS = 5 * 60 * 1000;

export class PreviewRescue {
  private pending = new Map<string, number>();

  constructor(private plugin: ObsiDropPlugin) {}

  start(): void {
    const { vault } = this.plugin.app;
    this.plugin.registerEvent(vault.on("create", this.onChange));
    this.plugin.registerEvent(vault.on("modify", this.onChange));
    this.plugin.registerEvent(vault.on("delete", this.onDelete));

    // Bij plugin-load: scan bestaande pending-notities. Kunnen via Syncthing
    // zijn binnengekomen toen plugin uit was.
    this.plugin.app.workspace.onLayoutReady(() => {
      void this.scanExisting();
    });
  }

  private onChange = (file: TAbstractFile): void => {
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    void this.maybeSchedule(file);
  };

  private onDelete = (file: TAbstractFile): void => {
    const timer = this.pending.get(file.path);
    if (timer != null) {
      window.clearTimeout(timer);
      this.pending.delete(file.path);
    }
  };

  private async scanExisting(): Promise<void> {
    const files = this.plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.maybeSchedule(file);
    }
  }

  /**
   * Probeert nu meteen alle pending-notities op te halen, zonder de 15s
   * wachttijd. Handig voor handmatige test/debug via een command.
   */
  async rescueAllNow(): Promise<number> {
    const files = this.plugin.app.vault.getMarkdownFiles();
    let count = 0;
    for (const file of files) {
      let content: string;
      try {
        content = await this.plugin.app.vault.read(file);
      } catch {
        continue;
      }
      if (!hasPendingMarker(content)) continue;
      const t = this.pending.get(file.path);
      if (t != null) {
        window.clearTimeout(t);
        this.pending.delete(file.path);
      }
      await this.rescue(file);
      count++;
    }
    new Notice(t("notice_pending_attempted", String(count)));
    return count;
  }

  private async maybeSchedule(file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!hasPendingMarker(content)) {
      const t = this.pending.get(file.path);
      if (t != null) {
        window.clearTimeout(t);
        this.pending.delete(file.path);
      }
      return;
    }
    // Bij modify event: oude timer cancellen en opnieuw plannen met verse
    // mtime — Android-OG-updates resetten zo onze wachttijd, en daarmee de
    // race die Syncthing-conflicts veroorzaakt.
    const existing = this.pending.get(file.path);
    if (existing != null) {
      window.clearTimeout(existing);
      this.pending.delete(file.path);
    }
    const age = Date.now() - file.stat.mtime;
    // Minimum 1s wachten om snelle burst-events te debouncen; max = de
    // resterende tijd tot mtime + MIN_RESCUE_AGE_MS.
    const wait = Math.max(MIN_RESCUE_AGE_MS - age, 1_000);
    const timer = window.setTimeout(() => {
      this.pending.delete(file.path);
      void this.rescue(file);
    }, wait);
    this.pending.set(file.path, timer);
  }

  private async rescue(file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!hasPendingMarker(content)) return; // Android was 'm voor.

    // Mtime kan tijdens onze fetch opnieuw zijn ververst door een binnenkomende
    // Syncthing-update — re-plan i.p.v. doorgaan, anders alsnog conflict-risico.
    if (Date.now() - file.stat.mtime < MIN_RESCUE_AGE_MS) {
      void this.maybeSchedule(file);
      return;
    }

    const url = detectUrl(content);
    if (!url) return;

    const attachmentsFolder = `${this.plugin.settings.notesFolder}/.attachments`;
    const preview = await fetchOg(this.plugin.app, attachmentsFolder, url);
    if (!preview) return;

    // Race-check: lees nog een keer vlak voor de write — als de marker tussen
    // fetch en write verdween, niet overschrijven.
    let latest: string;
    try {
      latest = await this.plugin.app.vault.read(file);
    } catch {
      return;
    }
    if (!hasPendingMarker(latest)) return;

    const newContent = buildLinkNote(url, preview, url);
    try {
      await this.plugin.app.vault.modify(file, newContent);
    } catch (e) {
      console.error("ObsiDrop preview-rescue: write faalde voor", file.path, e);
    }
  }
}
