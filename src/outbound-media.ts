// Turn outbound agent media (a remote URL or a local/generated file path) into a
// Fizzy comment body with real ActionText attachments, shared by both outbound
// reply paths (the core-driven adapter in channel.ts and the inbound webhook/poll
// reply in inbound.ts).
//
// Hybrid strategy (validated live against a dev Fizzy):
//   - image already at a public http(s) URL -> remote-image attachment (no upload;
//     Fizzy embeds the URL verbatim);
//   - local/generated media, and any non-image file -> ActiveStorage direct upload
//     -> embed the returned attachable_sgid (Fizzy self-hosts the bytes and renders
//     an inline image / a downloadable file attachment);
//   - load/upload failure -> keep the reply, degrade to a text link + note.
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";

import type { FizzyAccount } from "./config.js";
import { buildCommentBody, type FizzyClient, type OutboundAttachment } from "./client.js";
import { textToHtml } from "./text.js";

// Media loading policy carried by the outbound context / agent run, forwarded to
// the SSRF- and size-guarded SDK loader. Kept loose: the SDK owns the exact shape.
export type OutboundMediaPolicy = {
  mediaAccess?: unknown;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
};

export type ResolvedAttachment = {
  attachment?: OutboundAttachment;
  // Human-readable reason we could not embed the media (disabled / load / upload
  // failure). When set, the caller degrades to a text note (and a link, if known).
  fallbackNote?: string;
  // Best-effort source URL to surface as a link in the fallback path.
  sourceUrl?: string;
};

// Injectable loader so the resolver is unit-testable without network / the SDK.
type Deps = { loadMedia: typeof loadOutboundMediaFromUrl };
const defaultDeps: Deps = { loadMedia: loadOutboundMediaFromUrl };

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function baseName(url: string): string | undefined {
  try {
    const path = isHttpUrl(url) ? new URL(url).pathname : url;
    const name = path.split(/[\\/]/).filter(Boolean).pop();
    return name && name.trim() ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

// Resolve one outbound media URL into an attachment descriptor, or a fallback note.
// Never throws: a load/upload failure degrades to a fallback so the reply still posts.
export async function resolveOutboundAttachment(
  api: any,
  account: FizzyAccount,
  client: FizzyClient,
  mediaUrl: string,
  policy: OutboundMediaPolicy = {},
  deps: Deps = defaultDeps,
): Promise<ResolvedAttachment> {
  const url = String(mediaUrl ?? "").trim();
  if (!url) return {};

  if (!account.sendOutboundImages) {
    api.logger?.info?.(`[fizzy] outbound media ${url}: attachment sending disabled`);
    return { fallbackNote: "attachment sending disabled", sourceUrl: isHttpUrl(url) ? url : undefined };
  }

  let media: Awaited<ReturnType<typeof loadOutboundMediaFromUrl>>;
  try {
    media = await deps.loadMedia(url, {
      maxBytes: account.maxImageBytes,
      mediaAccess: policy.mediaAccess as any,
      mediaLocalRoots: policy.mediaLocalRoots,
      mediaReadFile: policy.mediaReadFile,
      workspaceDir: policy.workspaceDir,
    });
  } catch (err: any) {
    api.logger?.warn?.(`[fizzy] outbound media ${url} could not be loaded: ${err?.message ?? err}`);
    return { fallbackNote: "attachment could not be loaded", sourceUrl: isHttpUrl(url) ? url : undefined };
  }

  const contentType = (media.contentType || "").split(";")[0].trim();
  const isImage = contentType.toLowerCase().startsWith("image/") || media.kind === "image";

  // Image already at a public URL: embed it directly, no bytes to Fizzy. Needs an
  // image/* content-type (RemoteImage.from_node requires it); otherwise upload.
  if (isImage && isHttpUrl(url) && contentType.toLowerCase().startsWith("image/")) {
    api.logger?.info?.(`[fizzy] outbound media ${url}: embedded as remote image (${contentType})`);
    return {
      attachment: { kind: "remote-image", url, contentType, caption: media.fileName || undefined },
    };
  }

  // Everything else (local/generated image, or any non-image file): upload the
  // bytes and embed the returned sgid so Fizzy self-hosts and renders it.
  const fileName = media.fileName || baseName(url) || "attachment";
  try {
    const sgid = await client.uploadFile(media.buffer, fileName, contentType || "application/octet-stream");
    api.logger?.info?.(`[fizzy] outbound media ${url}: uploaded as ${fileName} (${contentType || "unknown"}) -> sgid`);
    return { attachment: { kind: "sgid", sgid } };
  } catch (err: any) {
    api.logger?.warn?.(`[fizzy] outbound media ${url} upload failed: ${err?.message ?? err}`);
    return { fallbackNote: "attachment upload failed — shown as link", sourceUrl: isHttpUrl(url) ? url : undefined };
  }
}

// Build a full comment body from a caption plus zero or more media URLs, running
// each URL through resolveOutboundAttachment and folding any fallbacks into the
// caption as a link line + note. This is the single shared shape both outbound
// paths use, so inbound and core-driven replies render identically.
export async function buildOutboundCommentBody(
  api: any,
  account: FizzyAccount,
  client: FizzyClient,
  opts: { caption: string; mediaUrls: string[]; policy?: OutboundMediaPolicy },
  deps: Deps = defaultDeps,
): Promise<string> {
  const attachments: OutboundAttachment[] = [];
  const notes: string[] = [];
  const linkLines: string[] = [];

  for (const mediaUrl of opts.mediaUrls) {
    const resolved = await resolveOutboundAttachment(api, account, client, mediaUrl, opts.policy ?? {}, deps);
    if (resolved.attachment) {
      attachments.push(resolved.attachment);
    } else if (resolved.fallbackNote) {
      notes.push(resolved.fallbackNote);
      if (resolved.sourceUrl) linkLines.push(resolved.sourceUrl);
    }
  }

  let text = String(opts.caption ?? "");
  if (linkLines.length) text = [text, ...linkLines].filter(Boolean).join("\n\n");
  if (notes.length) text = `${text}\n\n[Note: ${notes.join("; ")}.]`.trim();

  return buildCommentBody(textToHtml(text), attachments);
}
