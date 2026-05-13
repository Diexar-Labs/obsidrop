import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type ObsiDropPlugin from "./main";
import { QuickCaptureModal } from "./capture";
import { EditNoteModal } from "./edit";
import { LightboxModal } from "./lightbox";
import { FolderPickerModal } from "./folderPicker";
import { TagPickerModal, TagItem } from "./tagPicker";
import { ConfirmModal } from "./confirmModal";
import {
  colorLabel,
  COLOR_NAMES,
  ColorName,
  DEFAULT_META,
  formatReminderShort,
  NoteMeta,
  parseReminderMs,
  readMeta,
  renderInlinePreviewHtml,
  stripFrontmatter,
  updateMeta,
} from "./metadata";
import { t } from "./i18n";

export const VIEW_TYPE_OBSIDROP = "obsidrop-view";

const TITLE_MAX_WORDS = 10;
const PREVIEW_MAX_WORDS = 25;
const LINK_CHIPS_VISIBLE = 3;
const TAG_CHIPS_TOP_N = 8;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD_PX = 10;

interface CardData {
  file: TFile;
  content: string;
  meta: NoteMeta;
  archived: boolean;
}

export class ObsiDropView extends ItemView {
  plugin: ObsiDropPlugin;
  private gridEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private filterBarEl!: HTMLElement;
  private normalToolbarEl!: HTMLElement;
  private selectionToolbarEl!: HTMLElement;
  private selectionCountEl!: HTMLElement;
  private selectAllBtn!: HTMLButtonElement;
  private query = "";
  private selectedTags = new Set<string>();
  private selectionMode = false;
  private selectedPaths = new Set<string>();
  private lastFiltered: CardData[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: ObsiDropPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_OBSIDROP;
  }

  getDisplayText(): string {
    return t("view_title");
  }

  getIcon(): string {
    return "sticky-note";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("obsidrop-view");

    this.normalToolbarEl = root.createDiv({ cls: "obsidrop-toolbar" });

    const newBtn = this.normalToolbarEl.createEl("button", { cls: "obsidrop-new-btn" });
    setIcon(newBtn.createSpan({ cls: "obsidrop-new-btn-icon" }), "plus");
    newBtn.createSpan({ text: t("action_new_note") });
    newBtn.addEventListener("click", () => {
      new QuickCaptureModal(this.app, this.plugin).open();
    });

    this.searchEl = this.normalToolbarEl.createEl("input", {
      cls: "obsidrop-search",
      attr: { type: "search", placeholder: t("search_placeholder") },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.toLowerCase();
      void this.render();
    });

    this.selectionToolbarEl = root.createDiv({
      cls: "obsidrop-toolbar obsidrop-selection-toolbar is-hidden",
    });
    this.buildSelectionToolbar();

    this.filterBarEl = root.createDiv({ cls: "obsidrop-filter-bar" });
    this.gridEl = root.createDiv({ cls: "obsidrop-grid" });
    this.applyCardWidth();

    // Escape verlaat selection-mode (pendant van Android's BackHandler).
    this.registerDomEvent(document, "keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && this.selectionMode) {
        ev.preventDefault();
        this.exitSelection();
      }
    });

    await this.render();
  }

  private buildSelectionToolbar(): void {
    const bar = this.selectionToolbarEl;
    bar.empty();

    const exitBtn = bar.createEl("button", {
      cls: "obsidrop-selection-exit",
      attr: { "aria-label": t("action_exit_selection") },
    });
    setIcon(exitBtn, "x");
    exitBtn.addEventListener("click", () => this.exitSelection());

    this.selectionCountEl = bar.createDiv({ cls: "obsidrop-selection-count" });

    const spacer = bar.createDiv({ cls: "obsidrop-selection-spacer" });
    void spacer;

    this.selectAllBtn = bar.createEl("button", {
      cls: "obsidrop-selection-action",
      attr: { "aria-label": t("action_select_all") },
    });
    setIcon(this.selectAllBtn, "check-check");
    this.selectAllBtn.addEventListener("click", () => this.selectAllFiltered());

    const archiveBtn = bar.createEl("button", {
      cls: "obsidrop-selection-action",
      attr: { "aria-label": t("action_archive") },
    });
    setIcon(archiveBtn, "archive");
    archiveBtn.addEventListener("click", () => this.confirmBulkArchive());

    const deleteBtn = bar.createEl("button", {
      cls: "obsidrop-selection-action is-destructive",
      attr: { "aria-label": t("action_delete") },
    });
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", () => this.confirmBulkDelete());
  }

  private updateSelectionToolbar(): void {
    if (!this.selectionCountEl) return;
    this.selectionCountEl.setText(
      t("selection_count", String(this.selectedPaths.size)),
    );
    const allSelected =
      this.lastFiltered.length > 0 &&
      this.lastFiltered.every((c) => this.selectedPaths.has(c.file.path));
    this.selectAllBtn.toggleClass("is-active", allSelected);
  }

  private enterSelection(initialPath: string): void {
    this.selectionMode = true;
    this.selectedPaths = new Set([initialPath]);
    this.normalToolbarEl.toggleClass("is-hidden", true);
    this.filterBarEl.toggleClass("is-hidden", true);
    this.selectionToolbarEl.toggleClass("is-hidden", false);
    this.contentEl.toggleClass("is-selecting", true);
    this.updateSelectionToolbar();
    void this.render();
  }

  private exitSelection(): void {
    this.selectionMode = false;
    this.selectedPaths.clear();
    this.normalToolbarEl.toggleClass("is-hidden", false);
    this.selectionToolbarEl.toggleClass("is-hidden", true);
    this.contentEl.toggleClass("is-selecting", false);
    void this.render();
  }

  private toggleSelect(path: string): void {
    if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
    else this.selectedPaths.add(path);
    if (this.selectedPaths.size === 0) {
      // Auto-exit als laatste deselect — pendant van Android-gedrag.
      this.exitSelection();
      return;
    }
    this.updateSelectionToolbar();
    // Update alleen de getroffen kaart visueel ipv volledige re-render —
    // anders verliest de gebruiker scroll-positie bij elke toggle. Loopen
    // is robuuster dan een attribute-selector op file-paden (bevatten
    // slashes, punten en mogelijk quotes die CSS-escape lastig maken).
    const cards = this.gridEl.querySelectorAll<HTMLElement>(".obsidrop-card");
    for (const c of Array.from(cards)) {
      if (c.dataset.path === path) {
        this.applyCardSelectionVisual(c, this.selectedPaths.has(path));
        break;
      }
    }
  }

  private selectAllFiltered(): void {
    if (this.lastFiltered.length === 0) return;
    const allPaths = this.lastFiltered.map((c) => c.file.path);
    const allSelected = allPaths.every((p) => this.selectedPaths.has(p));
    if (allSelected) {
      for (const p of allPaths) this.selectedPaths.delete(p);
    } else {
      for (const p of allPaths) this.selectedPaths.add(p);
    }
    if (this.selectedPaths.size === 0) {
      this.exitSelection();
      return;
    }
    this.updateSelectionToolbar();
    void this.render();
  }

  private applyCardSelectionVisual(cardEl: HTMLElement, selected: boolean): void {
    cardEl.toggleClass("is-selected", selected);
    const marker = cardEl.querySelector(".obsidrop-card-select-marker");
    if (marker instanceof HTMLElement) {
      marker.empty();
      setIcon(marker, selected ? "check-circle-2" : "circle");
    }
  }

  private confirmBulkArchive(): void {
    const count = this.selectedPaths.size;
    if (count === 0) return;
    new ConfirmModal(
      this.app,
      {
        title: t("bulk_archive_title", String(count)),
        message: t("bulk_archive_message"),
        confirmLabel: t("action_archive"),
      },
      () => void this.bulkArchive(),
    ).open();
  }

  private confirmBulkDelete(): void {
    const count = this.selectedPaths.size;
    if (count === 0) return;
    new ConfirmModal(
      this.app,
      {
        title: t("bulk_delete_title", String(count)),
        message: t("bulk_delete_message"),
        confirmLabel: t("action_delete"),
        destructive: true,
      },
      () => void this.bulkDelete(),
    ).open();
  }

  private async bulkArchive(): Promise<void> {
    // Snapshot van paden — selectie kan tijdens de operatie wijzigen
    // (al onwaarschijnlijk) en we willen sequentieel werken.
    const paths = Array.from(this.selectedPaths);
    const archiveFolder = normalizePath(this.plugin.settings.archiveFolder);
    if (!this.app.vault.getAbstractFileByPath(archiveFolder)) {
      try {
        await this.app.vault.createFolder(archiveFolder);
      } catch {
        // Bestaat misschien al; rename hieronder faalt anders alsnog netjes per file.
      }
    }
    let ok = 0;
    let fail = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        fail++;
        continue;
      }
      try {
        const newPath = normalizePath(`${archiveFolder}/${file.name}`);
        if (this.app.vault.getAbstractFileByPath(newPath)) {
          fail++;
          continue;
        }
        await this.app.fileManager.renameFile(file, newPath);
        ok++;
      } catch {
        fail++;
      }
    }
    this.reportBulkResult("notice_bulk_archived", ok, fail);
    this.exitSelection();
  }

  private async bulkDelete(): Promise<void> {
    const paths = Array.from(this.selectedPaths);
    let ok = 0;
    let fail = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        fail++;
        continue;
      }
      try {
        // System-trash i.p.v. .trash/ — zo komt het in OS-prullenbak en is
        // herstel mogelijk; aligned met de single-card delete-flow.
        await this.app.vault.trash(file, true);
        ok++;
      } catch {
        fail++;
      }
    }
    this.reportBulkResult("notice_bulk_deleted", ok, fail);
    this.exitSelection();
  }

  /**
   * Long-press detectie via pointer-events (werkt voor muis én touch).
   * Timer start op pointerdown, cancelt bij beweging > drempel of pointerup.
   * Bij vuren: enter selection-mode (of toggle als al actief). Het daarop
   * volgende click-event wordt in capture-phase opgegeten zodat de
   * normale klik-handlers niet ook nog vuren.
   */
  private attachLongPress(cardEl: HTMLElement, path: string): void {
    let timer: number | null = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const cancel = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    cardEl.addEventListener("pointerdown", (e: PointerEvent) => {
      // Alleen primaire knop / touch / pen — rechts-klik laten met rust.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      startX = e.clientX;
      startY = e.clientY;
      fired = false;
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        if (this.selectionMode) this.toggleSelect(path);
        else this.enterSelection(path);
      }, LONG_PRESS_MS);
    });

    cardEl.addEventListener("pointermove", (e: PointerEvent) => {
      if (timer === null) return;
      if (
        Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_THRESHOLD_PX ||
        Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_THRESHOLD_PX
      ) {
        cancel();
      }
    });
    cardEl.addEventListener("pointerup", cancel);
    cardEl.addEventListener("pointercancel", cancel);
    cardEl.addEventListener("pointerleave", cancel);

    cardEl.addEventListener(
      "click",
      (e) => {
        if (fired) {
          // Long-press heeft al actie ondernomen; eet de daaropvolgende click.
          fired = false;
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  private reportBulkResult(successKey: string, ok: number, fail: number): void {
    if (fail === 0) {
      new Notice(t(successKey, String(ok)));
    } else if (ok === 0) {
      new Notice(t("notice_error", t("notice_bulk_partial", "0", String(fail))));
    } else {
      new Notice(t("notice_bulk_partial", String(ok), String(fail)));
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  applyCardWidth(): void {
    if (this.gridEl) {
      this.gridEl.style.setProperty("--obsidrop-card-width", `${this.plugin.settings.cardWidth}px`);
    }
  }

  async render(): Promise<void> {
    if (!this.gridEl) return;
    this.applyCardWidth();
    this.gridEl.empty();

    const cards = await this.collectCards();
    this.renderFilterBar(cards);

    // Drop selected-tags die door note-mutaties niet meer bestaan, zodat
    // de gebruiker niet vast komt te zitten met een "dood" filter.
    const tagFreq = computeTagFrequency(cards);
    for (const sel of Array.from(this.selectedTags)) {
      if (!tagFreq.has(sel)) this.selectedTags.delete(sel);
    }

    const filtered = cards.filter((c) => this.matchesFilters(c));
    this.lastFiltered = filtered;

    // Drop selected-paths die buiten de huidige filtered-set vallen of
    // niet meer bestaan, anders telt "N geselecteerd" verkeerd na een filter-
    // wijziging of file-delete. (Selection-mode zelf blijft staan tot de
    // gebruiker × of Escape gebruikt.)
    const allPaths = new Set(cards.map((c) => c.file.path));
    for (const p of Array.from(this.selectedPaths)) {
      if (!allPaths.has(p)) this.selectedPaths.delete(p);
    }
    if (this.selectionMode) this.updateSelectionToolbar();

    if (filtered.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "obsidrop-empty" });
      if (cards.length === 0) {
        empty.createEl("h3", { text: t("empty_no_notes_title") });
        empty.createEl("p", { text: t("empty_no_notes_desc") });
      } else {
        empty.createEl("h3", { text: t("empty_no_results") });
        const clearBtn = empty.createEl("button", {
          cls: "obsidrop-empty-clear",
          text: t("empty_no_results_clear"),
        });
        clearBtn.addEventListener("click", () => this.clearAllFilters());
      }
      return;
    }

    const pinned = filtered.filter((c) => c.meta.pinned);
    const rest = filtered.filter((c) => !c.meta.pinned);

    if (pinned.length > 0) {
      const pinnedSection = this.gridEl.createDiv({ cls: "obsidrop-section" });
      pinnedSection.createDiv({ cls: "obsidrop-section-label", text: t("section_pinned") });
      const pinnedGrid = pinnedSection.createDiv({ cls: "obsidrop-grid-inner" });
      for (const c of pinned) this.renderCard(pinnedGrid, c);

      const restSection = this.gridEl.createDiv({ cls: "obsidrop-section" });
      restSection.createDiv({ cls: "obsidrop-section-label", text: t("section_other") });
      const restGrid = restSection.createDiv({ cls: "obsidrop-grid-inner" });
      for (const c of rest) this.renderCard(restGrid, c);
    } else {
      const inner = this.gridEl.createDiv({ cls: "obsidrop-grid-inner" });
      for (const c of rest) this.renderCard(inner, c);
    }
  }

  /**
   * Bouwt de tag-chip-strip onder de toolbar: top-N op frequentie + altijd
   * óók geselecteerde tags die buiten de top vallen (anders zou een
   * geselecteerde tag verdwijnen na een nieuwe note met andere tags).
   * Toon "+N meer"-chip wanneer er nog tags overblijven; opent TagPickerModal.
   */
  private renderFilterBar(cards: CardData[]): void {
    if (!this.filterBarEl) return;
    this.filterBarEl.empty();

    const tagFreq = computeTagFrequency(cards);
    if (tagFreq.size === 0) {
      this.filterBarEl.toggleClass("is-hidden", true);
      return;
    }
    this.filterBarEl.toggleClass("is-hidden", false);

    const byFreqDesc = Array.from(tagFreq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = byFreqDesc.slice(0, TAG_CHIPS_TOP_N).map(([tag]) => tag);
    const topSet = new Set(top);
    const extraSelected = Array.from(this.selectedTags)
      .filter((t) => !topSet.has(t) && tagFreq.has(t))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const visibleTags = [...top, ...extraSelected];
    const overflowCount = Math.max(0, tagFreq.size - visibleTags.length);

    for (const tag of visibleTags) {
      this.renderTagChip(tag, this.selectedTags.has(tag));
    }

    if (overflowCount > 0) {
      const more = this.filterBarEl.createEl("button", {
        cls: "obsidrop-filter-chip is-overflow",
        text: t("tag_overflow_more", String(overflowCount)),
      });
      more.addEventListener("click", () => {
        const items: TagItem[] = byFreqDesc
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) =>
            a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()),
          );
        new TagPickerModal(
          this.app,
          items,
          this.selectedTags,
          (tag) => this.toggleTagFilter(tag),
        ).open();
      });
    }

    if (this.selectedTags.size > 0) {
      const clear = this.filterBarEl.createEl("button", {
        cls: "obsidrop-filter-clear",
        text: t("tag_filter_clear"),
      });
      clear.addEventListener("click", () => {
        this.selectedTags.clear();
        void this.render();
      });
    }
  }

  private renderTagChip(tag: string, isSelected: boolean): void {
    const chip = this.filterBarEl.createEl("button", {
      cls: `obsidrop-filter-chip${isSelected ? " is-selected" : ""}`,
    });
    // Expliciet ✓-symbool — kleur alléén volstaat niet (kleurenblind-pariteit
    // met de Android-FilterChip die ook een Done-icon toont).
    const check = chip.createSpan({ cls: "obsidrop-filter-chip-check" });
    check.setText(isSelected ? "✓" : "");
    chip.createSpan({ cls: "obsidrop-filter-chip-label", text: `#${tag}` });
    chip.addEventListener("click", () => this.toggleTagFilter(tag));
  }

  private toggleTagFilter(tag: string): void {
    if (this.selectedTags.has(tag)) this.selectedTags.delete(tag);
    else this.selectedTags.add(tag);
    void this.render();
  }

  private clearAllFilters(): void {
    this.selectedTags.clear();
    this.query = "";
    if (this.searchEl) this.searchEl.value = "";
    void this.render();
  }

  private async collectCards(): Promise<CardData[]> {
    const folder = normalizePath(this.plugin.settings.notesFolder);
    const archive = normalizePath(this.plugin.settings.archiveFolder);
    const showArchived = this.plugin.settings.showArchived;

    const all = this.app.vault.getMarkdownFiles().filter((f) => {
      const inArchive = isUnder(f.path, archive);
      const inFolder = isUnder(f.path, folder);
      if (!inFolder) return false;
      if (inArchive && !showArchived) return false;
      return true;
    });

    const sorted = sortFiles(all, this.plugin.settings.sortMode);

    const cards: CardData[] = [];
    for (const file of sorted) {
      const content = await this.app.vault.cachedRead(file);
      const meta = readMeta(this.app, file);
      cards.push({
        file,
        content,
        meta,
        archived: isUnder(file.path, archive),
      });
    }
    return cards;
  }

  /**
   * AND tussen zoektekst en tag-filter; OR binnen geselecteerde tags
   * (een notitie matched zodra één van de geselecteerde tags er op zit).
   */
  private matchesFilters(card: CardData): boolean {
    const q = this.query;
    const matchesQuery =
      !q ||
      card.file.basename.toLowerCase().includes(q) ||
      card.content.toLowerCase().includes(q) ||
      card.meta.tags.some((t) => t.toLowerCase().includes(q));
    if (!matchesQuery) return false;

    if (this.selectedTags.size === 0) return true;
    return card.meta.tags.some((t) => this.selectedTags.has(t));
  }

  private renderCard(parent: HTMLElement, card: CardData): void {
    const { file, content, meta, archived } = card;
    const isSelected = this.selectedPaths.has(file.path);
    const cardEl = parent.createDiv({
      cls: [
        "obsidrop-card",
        archived ? "is-archived" : "",
        meta.pinned ? "is-pinned" : "",
        isSelected ? "is-selected" : "",
      ].filter(Boolean).join(" "),
    });
    cardEl.dataset.path = file.path;
    if (meta.color !== "default") {
      cardEl.dataset.color = meta.color;
    }

    this.attachLongPress(cardEl, file.path);

    // Selectie-marker overlay (rechtsboven). Shape-based (gevuld vs leeg
    // cirkel-icoon) zodat ook zonder kleurperceptie zichtbaar is welke
    // kaart geselecteerd is. Verschijnt alleen in selection-mode via CSS.
    const marker = cardEl.createSpan({ cls: "obsidrop-card-select-marker" });
    setIcon(marker, isSelected ? "check-circle-2" : "circle");

    const titleText = extractTitle(content, file.basename);
    const previewText = extractPreview(content);
    const urls = extractUrls(content);

    const body = cardEl.createDiv({ cls: "obsidrop-card-body" });

    const thumbnailBasename = extractFirstEmbeddedImage(content);
    const attachment = thumbnailBasename
      ? this.resolveAttachmentResource(file, thumbnailBasename)
      : null;

    // Body-klik = altijd bewerken (of: toggle wanneer in selection-mode).
    // Thumbnail krijgt z'n eigen handler met stopPropagation voor de
    // lightbox, anders kan de gebruiker niet meer bij de tekst van de kaart.
    body.addEventListener("click", () => {
      if (this.selectionMode) { this.toggleSelect(file.path); return; }
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    if (attachment) {
      const thumbWrap = body.createDiv({ cls: "obsidrop-card-thumbnail" });
      const img = thumbWrap.createEl("img");
      img.src = attachment.resourcePath;
      img.alt = "";
      img.loading = "lazy";
      // Als het bestand niet bestaat (broken link), verberg de thumbnail-wrap.
      img.addEventListener("error", () => thumbWrap.remove());
      thumbWrap.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.selectionMode) { this.toggleSelect(file.path); return; }
        new LightboxModal(
          this.app,
          this.plugin,
          file,
          attachment.resourcePath,
          attachment.file,
          attachment.vaultPath,
        ).open();
      });
    }

    body.createEl("h3", { cls: "obsidrop-card-title", text: titleText });

    if (meta.reminder) {
      const ms = parseReminderMs(meta.reminder);
      if (Number.isFinite(ms)) {
        const overdue = ms < Date.now();
        const badge = body.createDiv({
          cls: `obsidrop-card-reminder${overdue ? " is-overdue" : ""}`,
        });
        badge.createSpan({
          cls: "obsidrop-card-reminder-label",
          text: overdue ? t("reminder_badge_overdue") : t("reminder_badge_due"),
        });
        badge.createSpan({
          cls: "obsidrop-card-reminder-rel",
          text: formatReminderShort(meta.reminder),
        });
      }
    }

    if (previewText) {
      const preview = body.createDiv({ cls: "obsidrop-card-preview" });
      preview.innerHTML = renderInlinePreviewHtml(previewText);
      preview.addEventListener("click", (e) => {
        if (this.selectionMode) {
          e.stopPropagation();
          this.toggleSelect(file.path);
          return;
        }
        this.handlePreviewClick(e);
      });
    }

    if (urls.length > 0) {
      const linkWrap = body.createDiv({ cls: "obsidrop-card-links" });
      for (const url of urls.slice(0, LINK_CHIPS_VISIBLE)) {
        const chip = linkWrap.createEl("a", {
          cls: "obsidrop-card-link",
          text: hostnameOf(url),
          attr: { href: url, rel: "noopener noreferrer", title: url },
        });
        chip.addEventListener("click", (e) => {
          // Klik op chip = link openen, niet de edit-modal triggeren.
          // In selection-mode wordt 'ie alsnog een toggle voor de kaart.
          e.stopPropagation();
          e.preventDefault();
          if (this.selectionMode) { this.toggleSelect(file.path); return; }
          window.open(url, "_blank", "noopener,noreferrer");
        });
      }
      if (urls.length > LINK_CHIPS_VISIBLE) {
        const more = linkWrap.createSpan({
          cls: "obsidrop-card-link-more",
          text: `+${urls.length - LINK_CHIPS_VISIBLE}`,
          attr: { title: t("link_chip_more_tooltip") },
        });
        more.addEventListener("click", (e) => {
          // "+N" doorgeven aan kaart-klik → edit-modal toont volledige inhoud.
          // Niet stoppen.
          void e;
        });
      }
    }

    if (meta.tags.length > 0) {
      const tagWrap = body.createDiv({ cls: "obsidrop-card-tags" });
      for (const tag of meta.tags) {
        tagWrap.createSpan({ cls: "obsidrop-card-tag", text: `#${tag}` });
      }
    }

    const actions = cardEl.createDiv({ cls: "obsidrop-card-actions" });

    const pinBtn = actions.createEl("button", {
      cls: `obsidrop-card-action${meta.pinned ? " is-active" : ""}`,
      attr: { "aria-label": meta.pinned ? t("action_unpin") : t("action_pin") },
    });
    setIcon(pinBtn, meta.pinned ? "pin-off" : "pin");
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await updateMeta(this.app, file, { pinned: !meta.pinned });
      this.plugin.refreshViews();
    });

    const colorBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": t("action_color") },
    });
    setIcon(colorBtn, "palette");
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showColorMenu(e, file, meta, cardEl);
    });

    const editBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": t("action_edit") },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      new EditNoteModal(this.app, this.plugin, file).open();
    });

    const archiveBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": archived ? t("action_unarchive") : t("action_archive") },
    });
    setIcon(archiveBtn, archived ? "archive-restore" : "archive");
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.toggleArchive(file, archived);
    });

    const moreBtn = actions.createEl("button", {
      cls: "obsidrop-card-action",
      attr: { "aria-label": t("action_more") },
    });
    setIcon(moreBtn, "more-vertical");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle(t("action_open_in_tab"))
          .setIcon("file-plus")
          .onClick(async () => {
            await this.app.workspace.getLeaf("tab").openFile(file);
          })
      );
      menu.addItem((i) =>
        i
          .setTitle(t("action_move_to_folder"))
          .setIcon("folder-output")
          .onClick(() => {
            new FolderPickerModal(
              this.app,
              t("folder_picker_move_placeholder"),
              (folder) => { void this.moveNote(file, folder.path); },
            ).open();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle(t("action_copy_to_folder"))
          .setIcon("copy")
          .onClick(() => {
            new FolderPickerModal(
              this.app,
              t("folder_picker_copy_placeholder"),
              (folder) => { void this.copyNote(file, folder.path); },
            ).open();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle(t("action_delete"))
          .setIcon("trash-2")
          .onClick(async () => {
            await this.app.vault.trash(file, true);
            new Notice(t("notice_deleted", file.basename));
            this.plugin.refreshViews();
          })
      );
      menu.showAtMouseEvent(e);
    });
  }

  private handlePreviewClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const wiki = target.closest(".obsidrop-wikilink") as HTMLElement | null;
    if (wiki) {
      e.preventDefault();
      e.stopPropagation();
      const href = wiki.dataset.href;
      if (!href) return;
      const dest = this.app.metadataCache.getFirstLinkpathDest(href, "");
      if (dest) {
        void this.app.workspace.getLeaf(false).openFile(dest);
      } else {
        new Notice(t("notice_note_not_found", href));
      }
      return;
    }
    const url = target.closest(".obsidrop-url") as HTMLElement | null;
    if (url) {
      e.preventDefault();
      e.stopPropagation();
      const href = url.dataset.href;
      if (href) this.showLinkBar(url, href);
    }
  }

  private showLinkBar(anchor: HTMLElement, href: string): void {
    document.body.querySelectorAll(".obsidrop-link-bar").forEach((el) => el.remove());

    const bar = document.body.createDiv({ cls: "obsidrop-link-bar" });
    const urlSpan = bar.createSpan({ cls: "obsidrop-link-bar-url" });
    urlSpan.setText(href.length > 60 ? `${href.slice(0, 57)}…` : href);
    const openBtn = bar.createEl("button", {
      cls: "obsidrop-link-bar-open",
      text: t("action_open_link"),
    });
    const closeBtn = bar.createEl("button", {
      cls: "obsidrop-link-bar-close",
      attr: { "aria-label": t("action_close") },
      text: "×",
    });

    const dismiss = () => {
      if (bar.isConnected) bar.remove();
      document.removeEventListener("click", outsideHandler, true);
      window.clearTimeout(timer);
    };
    openBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      window.open(href, "_blank", "noopener,noreferrer");
      dismiss();
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dismiss();
    });

    const outsideHandler = (ev: MouseEvent) => {
      if (!bar.contains(ev.target as Node)) dismiss();
    };
    setTimeout(() => document.addEventListener("click", outsideHandler, true), 0);
    const timer = window.setTimeout(dismiss, 4500);

    const rect = anchor.getBoundingClientRect();
    bar.style.position = "fixed";
    bar.style.zIndex = "9999";
    // Tijdelijk renderen om de bar-breedte te kennen, dan correct positioneren.
    const barRect = bar.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(window.innerWidth - barRect.width - 8, rect.left),
    );
    const top = rect.bottom + 6 + barRect.height > window.innerHeight
      ? rect.top - barRect.height - 6
      : rect.bottom + 6;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  private showColorMenu(event: MouseEvent, file: TFile, meta: NoteMeta, cardEl: HTMLElement): void {
    const menu = new Menu();
    for (const name of COLOR_NAMES) {
      menu.addItem((i) =>
        i
          .setTitle(colorLabel(name))
          .setIcon(name === meta.color ? "check" : "circle")
          .onClick(async () => {
            // In-place update: voorkomt dat re-rendering de kaart bovenaan zet
            // doordat updateMeta de mtime bumpt en de grid hersorteert.
            this.plugin.suppressModifyOnce(file.path);
            await updateMeta(this.app, file, { color: name });
            meta.color = name;
            if (name === "default") {
              delete cardEl.dataset.color;
            } else {
              cardEl.dataset.color = name;
            }
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  /**
   * Resolveer een ingebedde afbeelding naar een resource-path dat als `<img src>` werkt.
   *
   * 1. Probeer Obsidian's metadataCache (vindt standaard-attachments via vault-zoek).
   * 2. Fall back op `<note-folder>/.attachments/<basename>` — Obsidian's metadataCache
   *    slaat dot-prefixed mappen over (`.attachments/`, `.trash/`), maar de adapter zelf
   *    kan ze wél lezen. Android-deelflow gebruikt deze conventie.
   * 3. Fall back op `<notesFolder>/.attachments/<basename>` (geconfigureerde notitiemap).
   */
  private resolveAttachmentResource(
    noteFile: TFile,
    basename: string,
  ): { resourcePath: string; file: TFile | null; vaultPath: string } | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(basename, noteFile.path);
    if (dest) {
      return {
        resourcePath: this.app.vault.getResourcePath(dest),
        file: dest,
        vaultPath: dest.path,
      };
    }
    const candidates: string[] = [];
    const noteFolder = noteFile.parent?.path ?? "";
    if (noteFolder) candidates.push(`${noteFolder}/.attachments/${basename}`);
    else candidates.push(`.attachments/${basename}`);
    const configured = this.plugin.settings.notesFolder;
    if (configured && configured !== noteFolder) {
      candidates.push(`${configured}/.attachments/${basename}`);
    }
    for (const p of candidates) {
      const normalized = normalizePath(p);
      // Adapter-resource werkt ook voor dot-prefixed mappen die metadataCache overslaat.
      // Bestaan-check is async — img.onerror ruimt op bij fail.
      return {
        resourcePath: this.app.vault.adapter.getResourcePath(normalized),
        file: null,
        vaultPath: normalized,
      };
    }
    return null;
  }

  /**
   * Verplaatst de notitie naar een andere map. Daarna valt 'ie buiten
   * `notesFolder` → verdwijnt automatisch uit de view bij refresh.
   */
  private async moveNote(file: TFile, targetFolder: string): Promise<void> {
    const target = normalizePath(`${targetFolder}/${file.name}`);
    if (target === file.path) return;
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(t("notice_target_exists"));
      return;
    }
    try {
      await this.app.fileManager.renameFile(file, target);
      new Notice(t("notice_moved", targetFolder || "/"));
    } catch (err) {
      new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
    }
    this.plugin.refreshViews();
  }

  /**
   * Maakt een kopie van de notitie in een andere map. Origineel blijft in
   * `notesFolder` staan; embedded attachments worden NIET mee-gekopieerd
   * (de wikilinks blijven werken omdat het dezelfde vault is).
   */
  private async copyNote(file: TFile, targetFolder: string): Promise<void> {
    const target = normalizePath(`${targetFolder}/${file.name}`);
    if (target === file.path) return;
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(t("notice_target_exists"));
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      if (!this.app.vault.getAbstractFileByPath(targetFolder) && targetFolder) {
        await this.app.vault.createFolder(targetFolder);
      }
      await this.app.vault.create(target, content);
      new Notice(t("notice_copied", targetFolder || "/"));
    } catch (err) {
      new Notice(t("notice_error", err instanceof Error ? err.message : String(err)));
    }
    this.plugin.refreshViews();
  }

  private async toggleArchive(file: TFile, currentlyArchived: boolean): Promise<void> {
    const archiveFolder = normalizePath(this.plugin.settings.archiveFolder);
    const notesFolder = normalizePath(this.plugin.settings.notesFolder);
    try {
      if (currentlyArchived) {
        const newPath = normalizePath(`${notesFolder}/${file.name}`);
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`Hersteld uit archief: ${file.basename}`);
      } else {
        if (!this.app.vault.getAbstractFileByPath(archiveFolder)) {
          await this.app.vault.createFolder(archiveFolder);
        }
        const newPath = normalizePath(`${archiveFolder}/${file.name}`);
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`Gearchiveerd: ${file.basename}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Fout: ${message}`);
    }
    this.plugin.refreshViews();
  }
}

function computeTagFrequency(cards: CardData[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const c of cards) {
    for (const tag of c.meta.tags) {
      freq.set(tag, (freq.get(tag) ?? 0) + 1);
    }
  }
  return freq;
}

function isUnder(filePath: string, folderPath: string): boolean {
  if (!folderPath) return false;
  const f = folderPath.replace(/\/+$/, "");
  return filePath === f || filePath.startsWith(`${f}/`);
}

function sortFiles(files: TFile[], mode: string): TFile[] {
  const sorted = [...files];
  switch (mode) {
    case "modified-asc":
      sorted.sort((a, b) => a.stat.mtime - b.stat.mtime);
      break;
    case "created-desc":
      sorted.sort((a, b) => b.stat.ctime - a.stat.ctime);
      break;
    case "created-asc":
      sorted.sort((a, b) => a.stat.ctime - b.stat.ctime);
      break;
    case "title-asc":
      sorted.sort((a, b) => a.basename.localeCompare(b.basename));
      break;
    case "modified-desc":
    default:
      sorted.sort((a, b) => b.stat.mtime - a.stat.mtime);
      break;
  }
  return sorted;
}

/**
 * Title-source: eerste niet-blanke, niet-embed regel. Markdown heading-markers
 * (`#`, `*`, `_`, `` ` ``, `>`) worden gestript. Resultaat wordt afgekapt op
 * `TITLE_MAX_WORDS` met "…". Lege titel → val terug op `fallback` (filename).
 */
function extractTitle(content: string, fallback: string): string {
  const body = stripFrontmatter(content);
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    if (/^!\[\[[^\]]+\]\]$/.test(line)) continue;
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line)) continue;
    if (/^<!--/.test(line)) continue;
    const cleaned = line.replace(/^#+\s*/, "").replace(/^[*_`>]+\s*/, "").trim();
    if (!cleaned) continue;
    return truncateWords(cleaned, TITLE_MAX_WORDS);
  }
  return fallback;
}

/**
 * Body voor de kaart: zonder frontmatter, embeds, heading-regels, URL's,
 * preview-comment-markers. Afgekapt op `PREVIEW_MAX_WORDS` met "…".
 * URL's worden weggehaald omdat ze als chips onderaan apart getoond worden.
 */
function extractPreview(content: string): string {
  const body = stripFrontmatter(content);
  const stripped = body
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<!--\s*(?:obsidrop|diexar)-preview:.*?-->/g, "")
    .replace(/^\s{0,3}#+\s+.*$/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "");
  const lines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rest = lines.join("\n");
  if (!rest) return "";
  return truncateWords(rest, PREVIEW_MAX_WORDS);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * Verzamelt alle unieke `http(s)://`-URL's uit de body (na strippen van
 * embed-syntax zodat lokale image-paden niet meelopen). Behoudt invoegvolgorde.
 */
function extractUrls(content: string): string[] {
  const body = stripFrontmatter(content)
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  const matches = body.match(/https?:\/\/[^\s)<>"']+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const clean = raw.replace(/[.,)\]}"'!?;:]+$/, "");
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Vindt de basenaam van de eerste ingebedde afbeelding in de notitie.
 * Ondersteunt zowel Obsidian-wikilinks `![[bestand.jpg]]` als markdown `![](path)`.
 */
function extractFirstEmbeddedImage(content: string): string | null {
  const body = stripFrontmatter(content);
  const wiki = body.match(/!\[\[([^\]|]+?)\]\]/);
  if (wiki) {
    return wiki[1].trim().split("|")[0].trim();
  }
  const md = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (md) {
    const url = md[1].trim();
    // Voor lokale paden: pak de basename. Voor http(s) doen we niets (geen lokale resolve).
    if (/^https?:\/\//i.test(url)) return null;
    const clean = url.split("#")[0].split("?")[0];
    const parts = clean.split("/");
    return parts[parts.length - 1] || null;
  }
  return null;
}

// Houden voor backwards-compat in case main.ts importeerde dit. Niet meer gebruikt.
export { DEFAULT_META };
