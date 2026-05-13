import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, ObsiDropSettings, ObsiDropSettingTab } from "./settings";
import { ObsiDropView, VIEW_TYPE_OBSIDROP } from "./view";
import { QuickCaptureModal, createNoteInFolder } from "./capture";
import { PreviewRescue } from "./previewRescue";
import { ReminderScheduler } from "./reminderScheduler";
import { ClipServer } from "./clipServer";
import { fetchOg } from "./ogfetch";
import {
  ColorName,
  isColorName,
  neutralizeBodyHashtags,
  updateMeta,
} from "./metadata";
import { t } from "./i18n";

export default class ObsiDropPlugin extends Plugin {
  settings!: ObsiDropSettings;
  private refreshTimer: number | null = null;
  // Paden waarvan we de volgende modify-event willen negeren: gebruikt bij
  // in-place updates (bv. kleurwissel) zodat de grid niet hersorteert door mtime.
  private readonly suppressedPaths: Set<string> = new Set();
  private reminderScheduler!: ReminderScheduler;
  private clipServer!: ClipServer;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_OBSIDROP, (leaf) => new ObsiDropView(leaf, this));

    this.addRibbonIcon("sticky-note", t("open_obsidrop"), () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-obsidrop",
      name: t("cmd_open_view"),
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "quick-capture-keep",
      name: t("cmd_quick_capture"),
      callback: () => new QuickCaptureModal(this.app, this).open(),
    });

    this.addSettingTab(new ObsiDropSettingTab(this.app, this));

    this.reminderScheduler = new ReminderScheduler(this);
    this.clipServer = new ClipServer(this);

    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f instanceof TFile) this.reminderScheduler.scheduleFile(f);
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      this.reminderScheduler.cancelFile(f.path);
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.reminderScheduler.scheduleFile(file);
      if (this.suppressedPaths.has(file.path)) {
        this.suppressedPaths.delete(file.path);
        return;
      }
      this.refreshViews();
    }));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      this.reminderScheduler.cancelFile(oldPath);
      if (f instanceof TFile) this.reminderScheduler.scheduleFile(f);
      this.refreshViews();
    }));

    this.app.workspace.onLayoutReady(() => {
      this.reminderScheduler.scheduleAll();
      this.applyClipServerState();
    });

    // Obsidian-URI fallback voor de Chrome-extension wanneer de loopback-server
    // uit staat of de plugin nog niet draaide bij send. Schema:
    // obsidian://obsidrop-clip?url=…&title=…&selection=…&tags=…&color=…
    this.registerObsidianProtocolHandler("obsidrop-clip", (params) => {
      void this.handleClipFromUri(params);
    });

    const rescue = new PreviewRescue(this);
    rescue.start();

    this.addCommand({
      id: "rescue-pending-previews",
      name: t("cmd_rescue_previews"),
      callback: () => { void rescue.rescueAllNow(); },
    });

    this.addCommand({
      id: "neutralize-inline-hashtags",
      name: t("cmd_neutralize_hashtags"),
      callback: () => { void this.neutralizeExistingHashtags(); },
    });

  }

  onunload(): void {
    // Obsidian sluit de view automatisch
    this.reminderScheduler?.cancelAll();
    this.clipServer?.stop();
  }

  /**
   * Start of stop de clip-server volgens settings; herstart bij poort-wijziging.
   */
  applyClipServerState(): void {
    if (!this.clipServer) return;
    const shouldRun = this.settings.clipServerEnabled && !!this.settings.clipServerToken;
    if (shouldRun) {
      if (!this.clipServer.isRunning()) {
        this.clipServer.start();
      } else if (this.clipServer.needsRestart()) {
        this.clipServer.restart();
      }
    } else if (this.clipServer.isRunning()) {
      this.clipServer.stop();
    }
  }

  /**
   * Verwerkt een obsidian://obsidrop-clip?…-URI als fallback voor wanneer de
   * loopback-server niet draaide bij send. Doet OG-fetch en maakt notitie.
   */
  private async handleClipFromUri(params: Record<string, string>): Promise<void> {
    const url = (params.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return;
    const title = (params.title || "").trim() || url;
    const selection = (params.selection || "").trim().slice(0, 8000);
    const tags = (params.tags || "")
      .split(",")
      .map((s) => s.replace(/^#/, "").trim())
      .filter((s) => s.length > 0 && !/\s/.test(s));
    const color: ColorName = isColorName(params.color) ? params.color : "default";

    const notice = new Notice(t("notice_fetching_preview"), 0);
    let content = `# ${title}\n\n`;
    if (selection) content += `> ${selection.replace(/\n/g, "\n> ")}\n\n`;
    content += `[${title}](${url})`;
    try {
      const attachmentsFolder = `${this.settings.notesFolder}/.attachments`;
      const preview = await fetchOg(this.app, attachmentsFolder, url);
      if (preview?.imageBasename) {
        content = `![[${preview.imageBasename}]]\n\n${content}`;
      }
    } catch (e) {
      console.error("ObsiDrop URI-clip: OG-fetch faalde:", e);
    } finally {
      notice.hide();
    }

    const safe = neutralizeBodyHashtags(content);
    const file = await createNoteInFolder(this.app, this.settings.notesFolder, safe);
    if (color !== "default" || tags.length > 0) {
      await updateMeta(this.app, file, { color, tags, pinned: false });
    }
    new Notice(t("notice_clip_saved", file.basename));
    this.refreshViews();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_OBSIDROP);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_OBSIDROP, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /**
   * Markeer dat de eerstvolgende modify-event voor dit pad genegeerd moet worden.
   * Wordt gebruikt bij in-place metadata-updates (kleurwissel) zodat de grid
   * niet hersorteert vanwege de bumpende mtime. Auto-clear na 2s als veiligheid.
   */
  suppressModifyOnce(path: string): void {
    this.suppressedPaths.add(path);
    window.setTimeout(() => this.suppressedPaths.delete(path), 2000);
  }

  /**
   * Loopt door alle notities onder `notesFolder` (incl. archief) en escapet
   * inline `#hashtags` zodat ze niet meer in Obsidian's vault-brede tag-index
   * verschijnen. Eénmalige migratie voor notities die vóór de fix gesynct zijn.
   */
  async neutralizeExistingHashtags(): Promise<void> {
    const root = normalizePath(this.settings.notesFolder);
    const files = this.app.vault.getMarkdownFiles().filter((f) =>
      f.path === root || f.path.startsWith(`${root}/`),
    );
    let changed = 0;
    for (const file of files) {
      try {
        const original = await this.app.vault.read(file);
        const next = neutralizeBodyHashtags(original);
        if (next !== original) {
          await this.app.vault.modify(file, next);
          changed += 1;
        }
      } catch (err) {
        console.error("ObsiDrop: neutralize faalde voor", file.path, err);
      }
    }
    if (changed === 0) {
      new Notice(t("notice_neutralized_none"));
    } else {
      new Notice(t("notice_neutralized", String(changed)));
      this.refreshViews();
    }
  }

  refreshViews(): void {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIDROP);
      for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof ObsiDropView) {
          void view.render();
        }
      }
    }, 150);
  }
}
