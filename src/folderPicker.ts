import { App, SuggestModal, TFolder } from "obsidian";
import { t } from "./i18n";

/**
 * Suggest-modal die alle mappen in de vault toont (op pad gesorteerd). Geeft
 * via callback het pad van de gekozen map terug. Gebruikt voor "Verplaats naar
 * map…" en "Kopieer naar map…"-acties op kaarten.
 */
export class FolderPickerModal extends SuggestModal<TFolder> {
  private onPick: (folder: TFolder) => void;

  constructor(app: App, placeholder: string, onPick: (folder: TFolder) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase().trim();
    const all: TFolder[] = [];
    const root = this.app.vault.getRoot();
    collectFolders(root, all);
    if (!q) return all.slice(0, 80);
    return all.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 80);
  }

  renderSuggestion(value: TFolder, el: HTMLElement): void {
    el.createDiv({ text: value.path || "/" });
    el.createDiv({
      cls: "jotdrop-suggest-path",
      text: value.parent ? value.parent.path || "/" : t("folder_root_label"),
    });
  }

  onChooseSuggestion(item: TFolder): void {
    this.onPick(item);
  }
}

function collectFolders(folder: TFolder, out: TFolder[]): void {
  out.push(folder);
  for (const child of folder.children) {
    if (child instanceof TFolder) collectFolders(child, out);
  }
}
