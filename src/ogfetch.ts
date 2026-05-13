import { App, normalizePath, requestUrl } from "obsidian";

/**
 * OG-meta-fetcher voor de plugin. Spiegel van de Android-OgFetcher zodat
 * URL's die in de quick-capture zijn ingevoerd dezelfde thumbnail krijgen
 * als wanneer ze via de share-flow op de telefoon binnenkomen.
 *
 * Gebruikt Obsidian's `requestUrl` (geen CORS in Electron) en schrijft
 * gedownloade afbeeldingen naar `<notesFolder>/.attachments/<hash>.<ext>` —
 * exact dezelfde conventie en SHA-1-naamgeving als Android, dus Syncthing
 * deduplicates automatisch en de plugin's display-flow vindt de file.
 */

// Desktop Chrome — Cloudflare/WAF-stacks tweaken bot-scores hoger op mobile UA's
// dan op desktop, dus desktop voorop is bewust.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36";

// Volgorde matters: Telegraaf 403't iedereen behalve Twitterbot.
const FALLBACK_UAS = [
  "Twitterbot/1.0",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

const URL_REGEX = /https?:\/\/\S+/i;

export interface OgPreview {
  sourceUrl: string;
  title: string | null;
  description: string | null;
  imageBasename: string | null;
}

export function detectUrl(text: string): string | null {
  const match = text.match(URL_REGEX);
  if (!match) return null;
  return match[0].replace(/[.,)\]}"'!?;:]+$/, "");
}

/**
 * Alle unieke `http(s)://`-URL's in volgorde van voorkomen, na strippen van
 * embed-syntax zodat lokale image-paden niet matchen. Wordt door de capture-flow
 * gebruikt om OG-fallback te doen: probeer eerste URL → bij geen image, probeer
 * volgende, enz.
 */
export function detectAllUrls(text: string): string[] {
  const cleaned = text
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  const matches = cleaned.match(/https?:\/\/[^\s)<>"']+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const clean = raw.replace(/[.,)\]}"'!?;:]+$/, "");
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export async function fetchOg(
  app: App,
  attachmentsFolder: string,
  url: string,
): Promise<OgPreview | null> {
  try {
    if (/tiktok\.com/i.test(url)) {
      // vm./vt.-shortlinks accepteert het oEmbed-endpoint niet — die hangt dan
      // 10+ seconden voor 'ie opgeeft. Resolve eerst naar de canonieke URL via
      // de redirect-target's `<link rel="canonical">` of `og:url`.
      const canonical = /vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)
        ? await resolveCanonicalUrl(url)
        : url;
      return await fetchTikTokOEmbed(app, attachmentsFolder, canonical);
    }
    const fetchUrl = rewriteForScraping(url);

    let html: string | null = null;
    let rawImageCandidates: string[] = [];
    const errors: string[] = [];

    for (const ua of [CHROME_UA, ...FALLBACK_UAS]) {
      const attempt = await downloadHtml(fetchUrl, ua);
      if ("error" in attempt) {
        errors.push(`${ua.split(/[\s\/]/)[0]}=${attempt.error}`);
        continue;
      }
      if (!html) html = attempt.html;
      const candidates = findOgImageCandidates(attempt.html, fetchUrl);
      if (candidates.length > 0) {
        html = attempt.html;
        rawImageCandidates = candidates;
        break;
      }
    }

    if (!html) {
      console.warn(`ObsiDrop: kon geen HTML ophalen voor ${url} (${errors.join("; ")})`);
      return null;
    }

    const title =
      extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title") ||
      extractTitleTag(html);
    const description =
      extractMeta(html, "og:description") ||
      extractMeta(html, "twitter:description") ||
      extractMeta(html, "description");
    let imageBasename: string | null = null;
    for (const candidate of rawImageCandidates) {
      const absolute = absolutize(candidate, fetchUrl);
      const basename = await downloadImage(app, attachmentsFolder, absolute);
      if (basename) {
        imageBasename = basename;
        break;
      }
    }

    return { sourceUrl: url, title, description, imageBasename };
  } catch (e) {
    console.error("ObsiDrop: OG-fetch faalde:", e);
    return null;
  }
}

/**
 * Volgt vm./vt.tiktok.com-shortlinks naar de canonieke `/@user/video/<id>`-URL.
 * Obsidian's `requestUrl` volgt 3xx automatisch — we extraheren daarna de
 * canonical-link of og:url meta uit de uiteindelijke HTML.
 */
async function resolveCanonicalUrl(shortUrl: string): Promise<string> {
  try {
    const res = await requestUrl({
      url: shortUrl,
      method: "GET",
      headers: { "User-Agent": CHROME_UA },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return shortUrl;
    const html = res.text;
    const linkPattern1 = /<link[^>]+?rel\s*=\s*["']canonical["'][^>]*?href\s*=\s*["']([^"']+)["']/i;
    const linkPattern2 = /<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']canonical["']/i;
    const canon = html.match(linkPattern1) || html.match(linkPattern2);
    if (canon) {
      const decoded = decodeHtmlEntities(canon[1]).trim();
      if (decoded) return decoded;
    }
    const ogUrl = extractMeta(html, "og:url");
    if (ogUrl) return ogUrl;
    return shortUrl;
  } catch {
    return shortUrl;
  }
}

async function fetchTikTokOEmbed(
  app: App,
  attachmentsFolder: string,
  url: string,
): Promise<OgPreview | null> {
  try {
    const oembedUrl = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url);
    const res = await requestUrl({
      url: oembedUrl,
      method: "GET",
      headers: { "User-Agent": CHROME_UA },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const json = JSON.parse(res.text);
    const title = typeof json.title === "string" ? json.title : null;
    const author = typeof json.author_name === "string" ? json.author_name : null;
    const thumbnailUrl = typeof json.thumbnail_url === "string" ? json.thumbnail_url : null;
    const imageBasename = thumbnailUrl
      ? await downloadImage(app, attachmentsFolder, thumbnailUrl)
      : null;
    const description = author ? `via @${author}` : null;
    return { sourceUrl: url, title, description, imageBasename };
  } catch {
    return null;
  }
}

type DownloadResult = { html: string } | { error: string };

/**
 * Chrome-fingerprint headers — Cloudflare/WAF-stacks weigeren sobere requests
 * (alleen UA + Accept) en geven 403 terug voordat de bytes überhaupt geserveerd
 * worden. Met de volledige `sec-ch-ua-*` + `sec-fetch-*` set passeren we de
 * default-bot-regels. Wordt voor zowel HTML-scrapes als image-downloads gebruikt.
 *
 * Accept-Encoding zetten we *niet*: Electron's requestUrl regelt decompressie
 * automatisch, en handmatig zetten levert op sommige builds gzipped bytes op.
 */
function browserHeaders(
  userAgent: string,
  opts: { accept: string; secFetchDest: "document" | "image" },
): Record<string, string> {
  const isChrome = userAgent.includes("Chrome/") && !userAgent.includes("Googlebot");
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: opts.accept,
    "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: "https://www.google.com/",
  };
  if (opts.secFetchDest === "document") {
    headers["Upgrade-Insecure-Requests"] = "1";
  }
  if (isChrome) {
    headers["sec-ch-ua"] = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"';
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = '"Windows"';
    headers["sec-fetch-dest"] = opts.secFetchDest;
    headers["sec-fetch-mode"] = opts.secFetchDest === "document" ? "navigate" : "no-cors";
    headers["sec-fetch-site"] = "cross-site";
    if (opts.secFetchDest === "document") headers["sec-fetch-user"] = "?1";
  }
  return headers;
}

async function downloadHtml(url: string, userAgent: string): Promise<DownloadResult> {
  const headers = browserHeaders(userAgent, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    secFetchDest: "document",
  });
  try {
    const res = await requestUrl({ url, method: "GET", headers, throw: false });
    if (res.status < 200 || res.status >= 300) {
      return { error: `HTTP ${res.status}` };
    }
    return { html: res.text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function downloadImage(
  app: App,
  attachmentsFolder: string,
  imageUrl: string,
): Promise<string | null> {
  try {
    const folder = normalizePath(attachmentsFolder);
    try {
      await app.vault.adapter.mkdir(folder);
    } catch {
      // Bestaat al — adapter.mkdir gooit op sommige builds, negeren is veilig.
    }

    const base = await hashName(imageUrl);
    const ext = guessExtensionFromUrl(imageUrl) || "jpg";
    const filename = `${base}.${ext}`;
    const path = normalizePath(`${folder}/${filename}`);

    if (await app.vault.adapter.exists(path)) {
      return filename;
    }

    const headers = browserHeaders(CHROME_UA, {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      secFetchDest: "image",
    });
    const res = await requestUrl({ url: imageUrl, method: "GET", headers, throw: false });
    if (res.status < 200 || res.status >= 300) {
      console.warn(`ObsiDrop: image-download faalde voor ${imageUrl} (HTTP ${res.status})`);
      return null;
    }

    await app.vault.adapter.writeBinary(path, res.arrayBuffer);
    return filename;
  } catch (e) {
    console.error("ObsiDrop: image-download faalde:", e);
    return null;
  }
}

function rewriteForScraping(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const shouldMirror =
      host === "twitter.com" ||
      host === "www.twitter.com" ||
      host === "x.com" ||
      host === "www.x.com" ||
      host === "mobile.twitter.com" ||
      host === "mobile.x.com";
    if (shouldMirror) {
      u.host = "fxtwitter.com";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Verzamelt álle image-kandidaten in prioriteitsvolgorde. Sites zetten soms
 * een `og:image` die 404't (zie holagestoria.es) — we moeten dan kunnen
 * terugvallen op twitter:image, JSON-LD of de apple-touch-icon. Duplicates
 * worden eruit gefilterd zodat we niet twee keer dezelfde 404 ophalen.
 */
function findOgImageCandidates(html: string, pageUrl: string): string[] {
  const sources = [
    extractMeta(html, "og:image"),
    extractMeta(html, "og:image:url"),
    extractMeta(html, "og:image:secure_url"),
    extractMeta(html, "twitter:image"),
    extractMeta(html, "twitter:image:src"),
    extractLinkImageSrc(html),
    extractJsonLdImage(html),
    extractAppleTouchIcon(html),
    extractFirstBodyImage(html, pageUrl),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

/**
 * Schema.org JSON-LD-blokken kunnen een `image`-veld bevatten — string, object
 * met `url`, of een array van een van beide. We wandelen de boom recursief af
 * tot de eerste string-URL.
 */
function extractJsonLdImage(html: string): string | null {
  const scriptRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1].trim());
      const found = walkForJsonLdImage(json);
      if (found) return found;
    } catch {
      // Invalid JSON-LD — skip.
    }
  }
  return null;
}

function walkForJsonLdImage(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForJsonLdImage(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const image = obj.image;
    if (typeof image === "string") return image;
    if (Array.isArray(image)) {
      for (const item of image) {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const url = (item as Record<string, unknown>).url;
          if (typeof url === "string") return url;
        }
      }
    } else if (image && typeof image === "object") {
      const url = (image as Record<string, unknown>).url;
      if (typeof url === "string") return url;
    }
    for (const key of Object.keys(obj)) {
      if (key === "image") continue;
      const found = walkForJsonLdImage(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Allerlaatste redmiddel — sommige sites (zie holagestoria.es) hebben
 * álle meta-images kapot of niet-bestaand. Dan pakken we de eerste
 * niet-triviale `<img>` uit de body, wat meestal het logo of de hero-image
 * is. Filters tegen ruis: data-URIs (inline base64), SVG's (geen JPG/PNG
 * dus onze extension-guesser werkt niet), tracking-pixels en spinners.
 *
 * We zoeken eerst in `<body>` om te voorkomen dat een favicon uit `<head>`
 * als img wordt teruggegeven.
 */
function extractFirstBodyImage(html: string, pageUrl: string): string | null {
  const bodyMatch = html.match(/<body\b[\s\S]*$/i);
  const body = bodyMatch ? bodyMatch[0] : html;
  const imgRe = /<img\b[^>]*?(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(body)) !== null) {
    const src = decodeHtmlEntities(m[1]).trim();
    if (!src) continue;
    if (src.startsWith("data:")) continue;
    if (/\.svg(\?|#|$)/i.test(src)) continue;
    if (/\b(spinner|loader|placeholder|pixel|tracking|spacer|blank|transparent)\b/i.test(src)) continue;
    if (/\b1x1\b|\b1px\b/i.test(src)) continue;
    if (!isSameSite(src, pageUrl)) continue;
    return src;
  }
  return null;
}

/**
 * Filtert third-party img-tags (Google-loginknoppen, Facebook-pixels, etc.) uit
 * de body-scrape. Relatieve URL's zijn per definitie same-site. Voor absolute
 * URL's vergelijken we hostnames met `www.`-prefix gestript, en accepteren we
 * subdomeinen (een CDN op `cdn.holagestoria.es` is nog steeds van die site).
 */
function isSameSite(imageSrc: string, pageUrl: string): boolean {
  if (!/^https?:\/\//i.test(imageSrc)) return true;
  try {
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
    const imgHost = strip(new URL(imageSrc).host);
    const pageHost = strip(new URL(pageUrl).host);
    if (imgHost === pageHost) return true;
    if (imgHost.endsWith("." + pageHost)) return true;
    if (pageHost.endsWith("." + imgHost)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Laatste redmiddel voor sites zonder OG/Twitter-meta: de apple-touch-icon.
 * WordPress genereert die standaard op 180x180, dus ziet er nog acceptabel uit
 * als card-thumbnail. Beter dan een lege kaart.
 */
function extractAppleTouchIcon(html: string): string | null {
  const p1 = /<link[^>]+?rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["'][^>]*?href\s*=\s*["']([^"']+)["']/i;
  const p2 = /<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']apple-touch-icon(?:-precomposed)?["']/i;
  const m = html.match(p1) || html.match(p2);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim() || null;
}

function extractMeta(html: string, propertyName: string): string | null {
  const esc = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const p1 = new RegExp(
    `<meta[^>]+?(?:property|name)\\s*=\\s*["']${esc}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const p2 = new RegExp(
    `<meta[^>]+?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${esc}["']`,
    "i",
  );
  const m = html.match(p1) || html.match(p2);
  if (!m) return null;
  const decoded = decodeHtmlEntities(m[1]).trim();
  return decoded || null;
}

function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim() || null;
}

function extractLinkImageSrc(html: string): string | null {
  const p1 = /<link[^>]+?rel\s*=\s*["']image_src["'][^>]*?href\s*=\s*["']([^"']+)["']/i;
  const p2 = /<link[^>]+?href\s*=\s*["']([^"']+)["'][^>]*?rel\s*=\s*["']image_src["']/i;
  const m = html.match(p1) || html.match(p2);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim() || null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function absolutize(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

async function hashName(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-1", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function guessExtensionFromUrl(url: string): string | null {
  const m = url.match(/\.(jpe?g|png|webp|gif|avif)(?:\?|#|$)/i);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/**
 * Bouw een markdown-notitie uit een OG-preview. Spiegel van Android's `buildLinkNote`.
 * Als `userContent` exact gelijk is aan de URL (gebruiker plakte alleen een URL),
 * vervangen we 'm door een volledige link-notitie. Anders prependen we alleen
 * het image-embed (indien gevonden) zodat user-tekst behouden blijft.
 */
export function buildLinkNote(url: string, preview: OgPreview, userContent: string): string {
  const trimmedUser = userContent.trim();
  const title = (preview.title || "").trim() || url;
  const isJustUrl = trimmedUser === url;

  if (isJustUrl) {
    let s = `# ${title}\n\n`;
    if (preview.imageBasename) s += `![[${preview.imageBasename}]]\n\n`;
    s += `[${title}](${url})`;
    if (preview.description) s += `\n\n${preview.description}`;
    return s;
  }
  if (preview.imageBasename) {
    return `![[${preview.imageBasename}]]\n\n${userContent}`;
  }
  return userContent;
}
