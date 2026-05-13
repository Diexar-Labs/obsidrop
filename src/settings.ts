import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsiDropPlugin from "./main";
import { t } from "./i18n";

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type SortMode = "modified-desc" | "modified-asc" | "created-desc" | "created-asc" | "title-asc";

export interface ObsiDropSettings {
  notesFolder: string;
  archiveFolder: string;
  sortMode: SortMode;
  cardWidth: number;
  showArchived: boolean;
  /** Of de loopback HTTP-server voor de Chrome-extension actief moet zijn. */
  clipServerEnabled: boolean;
  /** Poort waarop de loopback-server luistert (alleen 127.0.0.1). */
  clipServerPort: number;
  /** Bearer-token dat de extension moet meesturen. Wordt automatisch gegenereerd. */
  clipServerToken: string;
}

export const DEFAULT_SETTINGS: ObsiDropSettings = {
  notesFolder: "Mini Notes",
  archiveFolder: "Mini Notes/Archive",
  sortMode: "modified-desc",
  cardWidth: 240,
  showArchived: false,
  clipServerEnabled: false,
  clipServerPort: 27124,
  clipServerToken: "",
};

export class ObsiDropSettingTab extends PluginSettingTab {
  plugin: ObsiDropPlugin;

  constructor(app: App, plugin: ObsiDropPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("settings_notes_folder"))
      .setDesc(t("settings_notes_folder_desc"))
      .addText((text) =>
        text
          .setPlaceholder("Mini Notes")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value.trim() || "Mini Notes";
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_archive_folder"))
      .setDesc(t("settings_archive_folder_desc"))
      .addText((text) =>
        text
          .setPlaceholder("Mini Notes/Archive")
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value.trim() || "Mini Notes/Archive";
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_sort"))
      .setDesc(t("settings_sort_desc"))
      .addDropdown((dd) =>
        dd
          .addOptions({
            "modified-desc": t("sort_modified_desc"),
            "modified-asc": t("sort_modified_asc"),
            "created-desc": t("sort_created_desc"),
            "created-asc": t("sort_created_asc"),
            "title-asc": t("sort_title_asc"),
          })
          .setValue(this.plugin.settings.sortMode)
          .onChange(async (value) => {
            this.plugin.settings.sortMode = value as SortMode;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_card_width"))
      .setDesc(t("settings_card_width_desc"))
      .addSlider((s) =>
        s
          .setLimits(180, 360, 10)
          .setValue(this.plugin.settings.cardWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cardWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings_show_archived"))
      .setDesc(t("settings_show_archived_desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showArchived).onChange(async (value) => {
          this.plugin.settings.showArchived = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    // Chrome-extension clip-server — bewust beneden de basics, niet iedereen
    // gebruikt 'm en het hoeft niet bovenaan te schreeuwen om aandacht.
    containerEl.createEl("h3", { text: t("settings_clip_server_section") });
    const clipDesc = containerEl.createEl("p", {
      cls: "obsidrop-clip-desc",
      text: t("settings_clip_server_desc"),
    });
    void clipDesc;

    new Setting(containerEl)
      .setName(t("settings_clip_server_enabled"))
      .setDesc(t("settings_clip_server_enabled_desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.clipServerEnabled).onChange(async (value) => {
          this.plugin.settings.clipServerEnabled = value;
          if (value && !this.plugin.settings.clipServerToken) {
            this.plugin.settings.clipServerToken = generateToken();
          }
          await this.plugin.saveSettings();
          this.plugin.applyClipServerState();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings_clip_server_port"))
      .setDesc(t("settings_clip_server_port_desc"))
      .addText((text) =>
        text
          .setPlaceholder("27124")
          .setValue(String(this.plugin.settings.clipServerPort))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n >= 1024 && n <= 65535) {
              this.plugin.settings.clipServerPort = n;
              await this.plugin.saveSettings();
              this.plugin.applyClipServerState();
            }
          }),
      );

    const tokenSetting = new Setting(containerEl)
      .setName(t("settings_clip_server_token"))
      .setDesc(t("settings_clip_server_token_desc"));
    tokenSetting.addText((text) => {
      text
        .setValue(this.plugin.settings.clipServerToken)
        .setDisabled(true);
      text.inputEl.style.width = "100%";
      text.inputEl.style.fontFamily = "monospace";
    });
    tokenSetting.addButton((btn) =>
      btn
        .setButtonText(t("settings_clip_server_copy"))
        .onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.clipServerToken);
          new Notice(t("notice_token_copied"));
        }),
    );
    tokenSetting.addButton((btn) =>
      btn
        .setButtonText(t("settings_clip_server_regenerate"))
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.clipServerToken = generateToken();
          await this.plugin.saveSettings();
          this.plugin.applyClipServerState();
          this.display();
          new Notice(t("notice_token_regenerated"));
        }),
    );

    // "Over ObsiDrop" — discrete, klikt zelf weg als de gebruiker er geen
    // interesse in heeft. Geen popups, geen "premium"-features. Open source +
    // optionele bedankjes-knop.
    const support = containerEl.createDiv({ cls: "obsidrop-support" });
    support.createEl("h3", { text: t("section_support") });
    support.createEl("p", { text: t("support_blurb") });
    const buttonRow = support.createDiv({ cls: "obsidrop-support-buttons" });
    const kofiLink = buttonRow.createEl("a", {
      cls: "obsidrop-support-button",
      attr: { href: "https://ko-fi.com/L3L11ZETB9", target: "_blank", rel: "noopener noreferrer" },
    });
    kofiLink.setText(t("support_kofi"));
    // GitHub Sponsors wordt toegevoegd zodra de aanvraag goedgekeurd is.
  }
}
