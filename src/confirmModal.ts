import { App, Modal } from "obsidian";
import { t } from "./i18n";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}

/**
 * Eenvoudige ja/nee-bevestigingsmodal. Sluit met Cancel of confirm; bij
 * confirm wordt de callback aangeroepen. Pendant van Android's AlertDialog
 * met "Annuleren" + actie-knop.
 */
export class ConfirmModal extends Modal {
  private opts: ConfirmOptions;
  private onConfirm: () => void;

  constructor(app: App, opts: ConfirmOptions, onConfirm: () => void) {
    super(app);
    this.opts = opts;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title);
    contentEl.createEl("p", { text: this.opts.message });

    const footer = contentEl.createDiv({ cls: "obsidrop-confirm-footer" });
    const cancel = footer.createEl("button", {
      cls: "obsidrop-confirm-cancel",
      text: t("action_cancel"),
    });
    cancel.addEventListener("click", () => this.close());

    const confirm = footer.createEl("button", {
      cls: `obsidrop-confirm-ok${this.opts.destructive ? " is-destructive" : ""}`,
      text: this.opts.confirmLabel,
    });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    setTimeout(() => confirm.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
