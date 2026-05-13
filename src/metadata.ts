import { App, TFile } from "obsidian";

export type ColorName =
  | "default"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "purple"
  | "pink"
  | "brown"
  | "gray";

export const COLOR_NAMES: ColorName[] = [
  "default",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
  "gray",
];

import { t } from "./i18n";

/** Localized display label for a note color (looks up `color_<name>`). */
export function colorLabel(name: ColorName): string {
  return t(`color_${name}`);
}

export interface NoteMeta {
  color: ColorName;
  tags: string[];
  pinned: boolean;
  /** ISO 8601 local datetime string ("YYYY-MM-DDTHH:mm") of een herinnering, of null. */
  reminder: string | null;
}

export const DEFAULT_META: NoteMeta = {
  color: "default",
  tags: [],
  pinned: false,
  reminder: null,
};

export function isColorName(value: unknown): value is ColorName {
  return typeof value === "string" && (COLOR_NAMES as string[]).includes(value);
}

/**
 * Leest metadata uit de Obsidian metadataCache. Werkt zonder eigen YAML-parser.
 */
export function readMeta(app: App, file: TFile): NoteMeta {
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter ?? {};

  const color = isColorName(fm.color) ? fm.color : "default";

  const tags: string[] = [];
  const seen = new Set<string>();
  const pushTag = (t: string) => {
    const clean = t.replace(/^#/, "").trim();
    if (!clean) return;
    if (seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    tags.push(clean);
  };
  if (Array.isArray(fm.tags)) {
    for (const t of fm.tags) {
      if (typeof t === "string") pushTag(t);
    }
  } else if (typeof fm.tags === "string") {
    for (const t of fm.tags.split(/[\s,]+/)) pushTag(t);
  }
  // Bewust GÉÉN inline #hashtags meegenomen. Anders pollueren tags uit
  // gedeelde social-media-posts (#fyp, #trending) de kaart-chips én de
  // vault-brede graph-view. User-tags komen via de capture/edit-chip-UI
  // en belanden netjes in frontmatter.

  const pinned = fm.pinned === true || fm.pinned === "true";

  let reminder: string | null = null;
  if (typeof fm.reminder === "string" && fm.reminder.trim().length > 0) {
    // Accepteer zowel "YYYY-MM-DDTHH:mm" als volledige ISO. We bewaren de
    // ingevoerde lokale datetime-string letterlijk; conversie naar epoch
    // gebeurt pas in de scheduler.
    reminder = fm.reminder.trim();
  }

  return { color, tags, pinned, reminder };
}

/**
 * Past metadata aan in een notitie via processFrontMatter (read-modify-write veilig).
 */
export async function updateMeta(
  app: App,
  file: TFile,
  patch: Partial<NoteMeta>,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (patch.color !== undefined) {
      if (patch.color === "default") delete fm.color;
      else fm.color = patch.color;
    }
    if (patch.pinned !== undefined) {
      if (patch.pinned) fm.pinned = true;
      else delete fm.pinned;
    }
    if (patch.tags !== undefined) {
      const cleaned = patch.tags
        .map((t) => t.replace(/^#/, "").trim())
        .filter((t) => t.length > 0);
      if (cleaned.length === 0) delete fm.tags;
      else fm.tags = Array.from(new Set(cleaned));
    }
    if (patch.reminder !== undefined) {
      if (patch.reminder === null || patch.reminder === "") {
        delete fm.reminder;
      } else {
        fm.reminder = patch.reminder;
      }
    }
  });
}

/**
 * Parseert een reminder-string naar epoch-ms. Geeft NaN bij ongeldige input.
 * Accepteert "YYYY-MM-DDTHH:mm" (lokale tijd) en volledige ISO 8601.
 */
export function parseReminderMs(reminder: string | null): number {
  if (!reminder) return NaN;
  const ms = Date.parse(reminder);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Formatteert een reminder kort relatief t.o.v. nu. Geeft labels in de UI-taal
 * van de plugin terug via `t()`. Bewust kleurloos — kleurenblind-vriendelijk:
 * verlopen reminders herken je aan het label "Verlopen" / "Overdue", niet aan
 * een rode kleur alleen.
 */
export function formatReminderShort(reminder: string | null, now: number = Date.now()): string {
  const ms = parseReminderMs(reminder);
  if (!Number.isFinite(ms)) return "";
  const diff = ms - now;
  const absMin = Math.abs(diff) / 60000;
  const overdue = diff < 0;
  if (absMin < 1) return t(overdue ? "reminder_just_overdue" : "reminder_now");
  if (absMin < 60) {
    const n = Math.round(absMin);
    return t(overdue ? "reminder_min_overdue" : "reminder_in_min", String(n));
  }
  const absHr = absMin / 60;
  if (absHr < 24) {
    const n = Math.round(absHr);
    return t(overdue ? "reminder_hr_overdue" : "reminder_in_hr", String(n));
  }
  const absDay = absHr / 24;
  if (absDay < 30) {
    const n = Math.round(absDay);
    return t(overdue ? "reminder_day_overdue" : "reminder_in_day", String(n));
  }
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Geeft alle bekende tags in de vault als gesorteerde lijst (voor autocomplete).
 */
export function getAllVaultTags(app: App): string[] {
  const raw = (app.metadataCache as unknown as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
  return Object.keys(raw)
    .map((t) => t.replace(/^#/, ""))
    .filter((t) => t.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Geeft de body van een notitie zonder frontmatter-blok.
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * Escape inline `#hashtag`-syntax in vrije tekst zodat Obsidian ze NIET
 * indexeert als tag. `#fyp` → `\#fyp`. In reading view rendert het nog
 * steeds als `#fyp`, maar graph-view en tag-pane blijven schoon.
 *
 * Werkt buiten code-fences en inline-code. Slaat heading-markers (`# Title`),
 * wiki-link-anchors (`[[Note#Heading]]`) en URL-anchors (`example.com#x`) over
 * via lookbehind op `[\\\w/]`. Niet idempotent uitvoeren is veilig: al-geescapete
 * `\#` matcht niet opnieuw.
 */
export function neutralizeInlineHashtags(text: string): string {
  const fenceParts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return fenceParts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(/(`[^`\n]+`)/g)
        .map((seg, j) => {
          if (j % 2 === 1) return seg;
          return seg.replace(/(?<![\\\w/])#([A-Za-z_/][\w/-]*)/g, "\\#$1");
        })
        .join("");
    })
    .join("");
}

/**
 * Past `neutralizeInlineHashtags` toe op alleen de body van een markdown-document.
 * Frontmatter-blok blijft onaangeroerd.
 */
export function neutralizeBodyHashtags(content: string): string {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fmMatch) {
    const fm = fmMatch[0];
    const body = content.slice(fm.length);
    return fm + neutralizeInlineHashtags(body);
  }
  return neutralizeInlineHashtags(content);
}

/**
 * Heel beperkte HTML-render voor previews: escapet HTML, rendert `[[link]]` en `[[link|alias]]`
 * als gestileerde spans, en zet `[text](url)` plus losse http(s)-URL's om naar klikbare
 * `<a class="obsidrop-url">`-tags. Klikken worden afgevangen door de view via delegation.
 */
export function renderInlinePreviewHtml(text: string): string {
  // Checklist-syntax aan begin van een regel wordt vervangen door vorm-glyphs.
  // Vorm i.p.v. kleur, dus ook leesbaar zonder kleur-onderscheid (kleurenblind-vriendelijk).
  const withChecks = text
    .replace(/^- \[ \] /gm, "☐ ")
    .replace(/^- \[[xX]\] /gm, "☑ ");

  const escaped = escapeHtml(withChecks);

  // Wikilinks → spans. target/alias komen uit reeds geescapete tekst,
  // dus geen tweede escape-laag toepassen.
  const withWiki = escaped.replace(
    /\[\[([^\]\|\n]+)(?:\|([^\]\n]+))?\]\]/g,
    (_match, target: string, alias?: string) => {
      const safeTarget = target.trim();
      const display = (alias ?? target).trim();
      return `<span class="obsidrop-wikilink" data-href="${safeTarget}">${display}</span>`;
    },
  );

  // Markdown-links eerst naar placeholders zodat de bare-URL-pass hun href-deel niet opnieuw matcht.
  const placeholders: string[] = [];
  const withMd = withWiki.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      const idx = placeholders.length;
      // url komt al door de buitenste escapeHtml-pass; niet nogmaals escapen,
      // anders krijg je &amp;amp; in href en knappen Telegraaf-URLs af op 404.
      placeholders.push(
        `<a class="obsidrop-url" data-href="${url}" rel="noopener noreferrer">${label}</a>`,
      );
      return `L${idx}`;
    },
  );

  // Losse URL's
  const withUrls = withMd.replace(
    /https?:\/\/\S+/g,
    (raw: string) => {
      const tailMatch = raw.match(/[).,;:!?\]"']+$/);
      const trail = tailMatch ? tailMatch[0] : "";
      const clean = trail ? raw.slice(0, raw.length - trail.length) : raw;
      if (!clean) return raw;
      return `<a class="obsidrop-url" data-href="${clean}" rel="noopener noreferrer">${clean}</a>${trail}`;
    },
  );

  return withUrls.replace(/L(\d+)/g, (_m, idx: string) => placeholders[Number(idx)]);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
