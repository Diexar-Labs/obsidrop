import { App, Modal } from "obsidian";
import { t } from "./i18n";

export interface TagItem {
  tag: string;
  count: number;
}

/**
 * Multi-select tag-picker. Toont een doorzoekbaar alfabetisch lijstje van
 * álle tags in de huidige note-set met een ✓-marker per geselecteerde tag.
 * Klik = toggle; modal blijft open tot de gebruiker 'm sluit (zodat er
 * meerdere tags na elkaar aangevinkt kunnen worden). Pendant van de Android-
 * `TagPickerSheet`.
 */
export class TagPickerModal extends Modal {
  private items: TagItem[];
  private selected: Set<string>;
  private onToggle: (tag: string) => void;
  private listEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private query = "";

  constructor(
    app: App,
    items: TagItem[],
    selected: Set<string>,
    onToggle: (tag: string) => void,
  ) {
    super(app);
    this.items = items;
    // Eigen kopie zodat aan/uitvinken in de modal direct visueel klopt
    // zonder dat we de buitenwereld hoeven te herraadplegen.
    this.selected = new Set(selected);
    this.onToggle = onToggle;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t("tag_sheet_title"));
    contentEl.addClass("obsidrop-tagpicker");

    this.inputEl = contentEl.createEl("input", {
      cls: "obsidrop-tagpicker-search",
      attr: { type: "search", placeholder: t("tag_sheet_search") },
    });
    this.inputEl.addEventListener("input", () => {
      this.query = this.inputEl.value.toLowerCase().trim();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "obsidrop-tagpicker-list" });
    this.renderList();
    // Focus zoekveld zodat de gebruiker meteen kan filteren.
    setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderList(): void {
    this.listEl.empty();
    const filtered = this.query
      ? this.items.filter((i) => i.tag.toLowerCase().includes(this.query))
      : this.items;

    if (filtered.length === 0) {
      this.listEl.createDiv({
        cls: "obsidrop-tagpicker-empty",
        text: t("tag_sheet_empty"),
      });
      return;
    }

    for (const item of filtered) {
      const row = this.listEl.createDiv({ cls: "obsidrop-tagpicker-row" });
      const isSelected = this.selected.has(item.tag);
      if (isSelected) row.addClass("is-selected");

      const check = row.createSpan({ cls: "obsidrop-tagpicker-check" });
      check.setText(isSelected ? "✓" : "");
      row.createSpan({ cls: "obsidrop-tagpicker-name", text: `#${item.tag}` });
      row.createSpan({
        cls: "obsidrop-tagpicker-count",
        text: String(item.count),
      });

      row.addEventListener("click", () => {
        this.onToggle(item.tag);
        if (this.selected.has(item.tag)) this.selected.delete(item.tag);
        else this.selected.add(item.tag);
        this.renderList();
      });
    }
  }
}
