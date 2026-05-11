import { App, Modal, Notice, SuggestModal, TFile, normalizePath } from "obsidian";
import type DiexarKeepPlugin from "./main";
import {
  COLOR_LABELS_NL,
  COLOR_NAMES,
  ColorName,
  getAllVaultTags,
  isColorName,
  readMeta,
  stripFrontmatter,
  updateMeta,
} from "./metadata";

interface EditableNote {
  file?: TFile;
  body: string;
  color: ColorName;
  tags: string[];
  pinned: boolean;
}

/**
 * Bewerk-modal voor een bestaande notitie. Toont kleur-pille, pin-toggle, tag-chips
 * met autocomplete, link-invoeg-knop en de body-editor. Slaat op via processFrontMatter
 * voor metadata en vault.modify voor body.
 */
export class EditNoteModal extends Modal {
  private plugin: DiexarKeepPlugin;
  private file: TFile;
  private state!: EditableNote;
  private originalBody = "";
  private bodyEl!: HTMLTextAreaElement;
  private chipsEl!: HTMLElement;

  constructor(app: App, plugin: DiexarKeepPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(this.file.basename);
    this.contentEl.addClass("diexar-keep-edit-modal");

    const raw = await this.app.vault.read(this.file);
    const body = stripFrontmatter(raw).replace(/^\n+/, "");
    const meta = readMeta(this.app, this.file);

    this.state = {
      file: this.file,
      body,
      color: meta.color,
      tags: [...meta.tags],
      pinned: meta.pinned,
    };
    this.originalBody = body;

    this.buildLayout();
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();

    const controls = root.createDiv({ cls: "diexar-keep-edit-controls" });
    this.renderControls(controls);

    this.bodyEl = root.createEl("textarea", {
      cls: "diexar-keep-edit-body",
    });
    this.bodyEl.rows = 12;
    this.bodyEl.value = this.state.body;
    this.bodyEl.addEventListener("input", () => {
      this.state.body = this.bodyEl.value;
    });

    const footer = root.createDiv({ cls: "diexar-keep-edit-footer" });
    const cancel = footer.createEl("button", { text: "Annuleren" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { text: "Opslaan", cls: "mod-cta" });
    save.addEventListener("click", () => void this.save());

    this.bodyEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void this.save();
      }
    });
  }

  private renderControls(parent: HTMLElement): void {
    parent.empty();

    // Kleurkiezer — wijzigingen worden direct opgeslagen
    const colorWrap = parent.createDiv({ cls: "diexar-keep-edit-colorrow" });
    colorWrap.createSpan({ text: "Kleur:", cls: "diexar-keep-edit-label" });
    const swatches = colorWrap.createDiv({ cls: "diexar-keep-edit-swatches" });
    for (const name of COLOR_NAMES) {
      const sw = swatches.createDiv({
        cls: `diexar-keep-edit-swatch${name === this.state.color ? " is-active" : ""}`,
        attr: { "aria-label": COLOR_LABELS_NL[name], title: COLOR_LABELS_NL[name] },
      });
      sw.dataset.color = name;
      if (name === this.state.color) {
        sw.createSpan({ cls: "diexar-keep-edit-swatch-check", text: "✓" });
      }
      sw.addEventListener("click", async () => {
        if (this.state.color === name) return;
        this.state.color = name;
        this.renderControls(parent);
        try {
          await updateMeta(this.app, this.file, { color: name });
          this.plugin.refreshViews();
        } catch (err) {
          new Notice(`Fout: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Pin-toggle — direct opslaan
    const pinWrap = parent.createDiv({ cls: "diexar-keep-edit-row" });
    const pinBtn = pinWrap.createEl("button", {
      cls: `diexar-keep-edit-pin${this.state.pinned ? " is-active" : ""}`,
      text: this.state.pinned ? "📌 Vastgezet" : "📍 Vastzetten",
    });
    pinBtn.addEventListener("click", async () => {
      this.state.pinned = !this.state.pinned;
      this.renderControls(parent);
      try {
        await updateMeta(this.app, this.file, { pinned: this.state.pinned });
        this.plugin.refreshViews();
      } catch (err) {
        new Notice(`Fout: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Link-invoegen
    const linkBtn = pinWrap.createEl("button", {
      cls: "diexar-keep-edit-linkbtn",
      text: "🔗 Link invoegen",
    });
    linkBtn.addEventListener("click", () => {
      new InsertLinkModal(this.app, (path) => this.insertLinkAtCursor(path)).open();
    });

    // Tags + chip-input
    const tagWrap = parent.createDiv({ cls: "diexar-keep-edit-tagrow" });
    tagWrap.createSpan({ text: "Tags:", cls: "diexar-keep-edit-label" });
    this.chipsEl = tagWrap.createDiv({ cls: "diexar-keep-edit-chips" });
    this.renderChips();

    const tagInput = tagWrap.createEl("input", {
      cls: "diexar-keep-edit-taginput",
      attr: { type: "text", placeholder: "Voeg tag toe…" },
    });
    const datalistId = `diexar-keep-tagcompletion-${Date.now()}`;
    const datalist = tagWrap.createEl("datalist", { attr: { id: datalistId } });
    tagInput.setAttribute("list", datalistId);
    for (const t of getAllVaultTags(this.app)) {
      datalist.createEl("option", { attr: { value: t } });
    }
    const commit = () => {
      const value = tagInput.value.replace(/^#/, "").trim();
      if (value && !this.state.tags.includes(value)) {
        this.state.tags.push(value);
        this.renderChips();
      }
      tagInput.value = "";
    };
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
        if (tagInput.value.trim()) {
          e.preventDefault();
          commit();
        }
      } else if (e.key === "Backspace" && tagInput.value === "" && this.state.tags.length > 0) {
        this.state.tags.pop();
        this.renderChips();
      }
    });
    tagInput.addEventListener("blur", commit);
  }

  private renderChips(): void {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    for (const tag of this.state.tags) {
      const chip = this.chipsEl.createSpan({ cls: "diexar-keep-edit-chip" });
      chip.createSpan({ text: `#${tag}` });
      const x = chip.createSpan({ cls: "diexar-keep-edit-chip-x", text: "×" });
      x.addEventListener("click", () => {
        this.state.tags = this.state.tags.filter((t) => t !== tag);
        this.renderChips();
      });
    }
  }

  private insertLinkAtCursor(linkPath: string): void {
    const ta = this.bodyEl;
    const insert = `[[${linkPath}]]`;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = `${before}${insert}${after}`;
    const caret = start + insert.length;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus();
    this.state.body = ta.value;
  }

  private async save(): Promise<void> {
    try {
      const bodyChanged = this.state.body !== this.originalBody;
      await updateMeta(this.app, this.file, {
        color: this.state.color,
        tags: this.state.tags,
        pinned: this.state.pinned,
      });
      if (bodyChanged) {
        // Lees opnieuw zodat onze nieuwe frontmatter behouden blijft
        const current = await this.app.vault.read(this.file);
        const fmMatch = current.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const fm = fmMatch ? fmMatch[0] : "";
        const newContent = `${fm}${this.state.body.replace(/^\n+/, "")}`;
        await this.app.vault.modify(this.file, newContent);
      }
      new Notice(`Opgeslagen: ${this.file.basename}`);
      this.plugin.refreshViews();
      this.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Fout bij opslaan: ${message}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Suggest-modal met autocomplete uit alle markdown-bestanden in de vault.
 * Geeft het gekozen pad (zonder .md) terug via callback.
 */
export class InsertLinkModal extends SuggestModal<TFile> {
  private onPick: (linkPath: string) => void;

  constructor(app: App, onPick: (linkPath: string) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Zoek notitie om naar te linken…");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase().trim();
    const files = this.app.vault.getMarkdownFiles();
    if (!q) return files.slice(0, 50);
    return files
      .filter((f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 50);
  }

  renderSuggestion(value: TFile, el: HTMLElement): void {
    el.createDiv({ text: value.basename });
    el.createDiv({ cls: "diexar-keep-suggest-path", text: value.path });
  }

  onChooseSuggestion(item: TFile): void {
    // Obsidian-conventie: link met de basename als 'ie uniek is, anders het pad zonder .md.
    const matches = this.app.vault.getMarkdownFiles().filter((f) => f.basename === item.basename);
    const linkPath = matches.length === 1 ? item.basename : item.path.replace(/\.md$/, "");
    this.onPick(linkPath);
  }
}
