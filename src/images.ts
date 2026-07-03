// Collect images from a Fizzy card + comment and turn them into the base64
// `ImageContent[]` that runEmbeddedAgent accepts, so the agent can actually see
// screenshots/photos attached to a card, not just their (empty) plain text.
//
// Fizzy renders every attachment — uploaded or remote — as an <img src="...">
// inside the rich-text HTML (app/views/active_storage/blobs/web/_representation
// and action_text/attachables/_remote_image). So one <img> sweep covers all of
// them. Uploaded-image srcs are relative ActiveStorage paths; we resolve them
// against the base URL and fetch them authenticated as the bot.
import type { FizzyAccount } from "./config.js";
import type { FizzyCard, FizzyClient } from "./client.js";

// Shape runEmbeddedAgent wants (pi-ai ImageContent): base64 bytes + mime type.
export type ImageContent = { type: "image"; data: string; mimeType: string };

type Candidate = { url: string; label: string; source: "comment" | "card" };

// Card cover/description image URLs already sent per card, so we don't re-send
// the same description image on every turn. In-memory: a gateway restart re-sends
// them once (the same tradeoff as the card-context snapshot). Comment images are
// always fresh (a comment fires once), so they are never deduped.
const sentCardImages = new Map<string, Set<string>>();

const IMG_SRC = /<img\b[^>]*?\bsrc="([^"]+)"/gi;

export async function collectTurnImages(
  api: any,
  account: FizzyAccount,
  client: FizzyClient,
  opts: { commentHtml?: string; card: FizzyCard; cardNumber: string },
): Promise<{ images: ImageContent[]; notes: string[] }> {
  const images: ImageContent[] = [];
  const notes: string[] = [];

  const seen = sentCardImages.get(opts.cardNumber) ?? new Set<string>();
  sentCardImages.set(opts.cardNumber, seen);

  const commentUrls = extractImgSrcs(opts.commentHtml).map((s) => resolveUrl(account.baseUrl, s));
  const cardUrls = [
    ...(opts.card.image_url ? [String(opts.card.image_url)] : []),
    ...extractImgSrcs(opts.card.description_html),
  ]
    .map((s) => resolveUrl(account.baseUrl, s))
    .filter((u) => !seen.has(u));

  const candidates: Candidate[] = [
    ...dedupe(commentUrls).map((url, i) => ({ url, label: `comment image ${i + 1}`, source: "comment" as const })),
    ...dedupe(cardUrls).map((url, i) => ({ url, label: `card image ${i + 1}`, source: "card" as const })),
  ];
  if (candidates.length === 0) return { images, notes };

  // Record card images now so a failed fetch isn't retried every turn.
  for (const c of candidates) if (c.source === "card") seen.add(c.url);

  if (!account.sendImages) {
    for (const c of candidates) notes.push(`${c.label} (not shown: image sending is disabled)`);
    return { images, notes };
  }

  let taken = 0;
  for (const c of candidates) {
    if (taken >= account.maxImages) {
      notes.push(`${c.label} (not shown: over the ${account.maxImages}-image limit)`);
      continue;
    }
    const built = await buildImage(api, account, client, c.url).catch(() => null);
    if (!built) {
      notes.push(`${c.label} (not shown: could not be fetched)`);
    } else if (built.skipped) {
      notes.push(`${c.label} (not shown: ${built.skipped})`);
    } else if (built.image) {
      images.push(built.image);
      taken++;
    }
  }
  return { images, notes };
}

async function buildImage(
  api: any,
  account: FizzyAccount,
  client: FizzyClient,
  url: string,
): Promise<{ image?: ImageContent; skipped?: string } | null> {
  const fetched = await client.fetchBinary(url);
  if (!fetched) return null;

  let buffer = fetched.buffer;
  let mime = await detectImageMime(api, buffer, fetched.contentType);
  if (!mime || !mime.startsWith("image/")) return { skipped: "not an image" };

  if (buffer.length > account.maxImageBytes) {
    const resized = await tryResize(api, buffer, account.maxImageBytes);
    if (resized) {
      buffer = resized;
      mime = "image/jpeg";
    }
    if (buffer.length > account.maxImageBytes) {
      return { skipped: `too large (> ${Math.round(account.maxImageBytes / 1024)}KB)` };
    }
  }
  return { image: { type: "image", data: buffer.toString("base64"), mimeType: mime } };
}

// Downscale an oversized image to JPEG using the runtime's image ops (sharp),
// trying progressively smaller max sides. Best-effort: returns null if the
// runtime helper isn't available or fails.
async function tryResize(api: any, buffer: Buffer, maxBytes: number): Promise<Buffer | null> {
  const resizeToJpeg = api?.runtime?.media?.resizeToJpeg;
  if (typeof resizeToJpeg !== "function") return null;
  let current = buffer;
  for (const maxSide of [1568, 1024, 768]) {
    try {
      const out: Buffer = await resizeToJpeg({ buffer: current, maxSide, quality: 80, withoutEnlargement: true });
      if (out?.length) {
        current = out;
        if (out.length <= maxBytes) return out;
      }
    } catch {
      return current === buffer ? null : current;
    }
  }
  return current;
}

async function detectImageMime(api: any, buffer: Buffer, headerMime?: string): Promise<string | undefined> {
  const detect = api?.runtime?.media?.detectMime;
  if (typeof detect === "function") {
    try {
      const mime = await detect({ buffer, headerMime });
      if (mime) return String(mime).toLowerCase();
    } catch {
      // fall through to header / magic-byte sniffing
    }
  }
  if (headerMime) return headerMime.split(";")[0].trim().toLowerCase();
  return sniffImageMime(buffer);
}

// Minimal magic-byte sniff for the common image types, as a last resort.
function sniffImageMime(b: Buffer): string | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 6 && b.toString("ascii", 0, 6).startsWith("GIF8")) return "image/gif";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function extractImgSrcs(html: string | undefined | null): string[] {
  if (!html) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMG_SRC.lastIndex = 0;
  while ((m = IMG_SRC.exec(html))) out.push(decodeEntities(m[1]));
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function resolveUrl(baseUrl: string, src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  return `${baseUrl}${src.startsWith("/") ? "" : "/"}${src}`;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
