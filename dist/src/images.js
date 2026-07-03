const sentCardImages = /* @__PURE__ */ new Map();
const IMG_SRC = /<img\b[^>]*?\bsrc="([^"]+)"/gi;
async function collectTurnImages(api, account, client, opts) {
  const images = [];
  const notes = [];
  const seen = sentCardImages.get(opts.cardNumber) ?? /* @__PURE__ */ new Set();
  sentCardImages.set(opts.cardNumber, seen);
  const commentUrls = extractImgSrcs(opts.commentHtml).map((s) => resolveUrl(account.baseUrl, s));
  const cardUrls = [
    ...opts.card.image_url ? [String(opts.card.image_url)] : [],
    ...extractImgSrcs(opts.card.description_html)
  ].map((s) => resolveUrl(account.baseUrl, s)).filter((u) => !seen.has(u));
  const candidates = [
    ...dedupe(commentUrls).map((url, i) => ({ url, label: `comment image ${i + 1}`, source: "comment" })),
    ...dedupe(cardUrls).map((url, i) => ({ url, label: `card image ${i + 1}`, source: "card" }))
  ];
  if (candidates.length === 0) return { images, notes };
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
async function buildImage(api, account, client, url) {
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
async function tryResize(api, buffer, maxBytes) {
  const resizeToJpeg = api?.runtime?.media?.resizeToJpeg;
  if (typeof resizeToJpeg !== "function") return null;
  let current = buffer;
  for (const maxSide of [1568, 1024, 768]) {
    try {
      const out = await resizeToJpeg({ buffer: current, maxSide, quality: 80, withoutEnlargement: true });
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
async function detectImageMime(api, buffer, headerMime) {
  const detect = api?.runtime?.media?.detectMime;
  if (typeof detect === "function") {
    try {
      const mime = await detect({ buffer, headerMime });
      if (mime) return String(mime).toLowerCase();
    } catch {
    }
  }
  if (headerMime) return headerMime.split(";")[0].trim().toLowerCase();
  return sniffImageMime(buffer);
}
function sniffImageMime(b) {
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return "image/png";
  if (b.length >= 6 && b.toString("ascii", 0, 6).startsWith("GIF8")) return "image/gif";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return void 0;
}
function extractImgSrcs(html) {
  if (!html) return [];
  const out = [];
  let m;
  IMG_SRC.lastIndex = 0;
  while (m = IMG_SRC.exec(html)) out.push(decodeEntities(m[1]));
  return out;
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function resolveUrl(baseUrl, src) {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  return `${baseUrl}${src.startsWith("/") ? "" : "/"}${src}`;
}
function dedupe(urls) {
  return [...new Set(urls)];
}
export {
  collectTurnImages
};
