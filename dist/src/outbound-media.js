import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { buildCommentBody } from "./client.js";
import { textToHtml } from "./text.js";
const defaultDeps = { loadMedia: loadOutboundMediaFromUrl };
function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}
function baseName(url) {
  try {
    const path = isHttpUrl(url) ? new URL(url).pathname : url;
    const name = path.split(/[\\/]/).filter(Boolean).pop();
    return name && name.trim() ? decodeURIComponent(name) : void 0;
  } catch {
    return void 0;
  }
}
async function resolveOutboundAttachment(api, account, client, mediaUrl, policy = {}, deps = defaultDeps) {
  const url = String(mediaUrl ?? "").trim();
  if (!url) return {};
  if (!account.sendOutboundImages) {
    api.logger?.info?.(`[fizzy] outbound media ${url}: attachment sending disabled`);
    return { fallbackNote: "attachment sending disabled", sourceUrl: isHttpUrl(url) ? url : void 0 };
  }
  let media;
  try {
    media = await deps.loadMedia(url, {
      maxBytes: account.maxImageBytes,
      mediaAccess: policy.mediaAccess,
      mediaLocalRoots: policy.mediaLocalRoots,
      mediaReadFile: policy.mediaReadFile,
      workspaceDir: policy.workspaceDir
    });
  } catch (err) {
    api.logger?.warn?.(`[fizzy] outbound media ${url} could not be loaded: ${err?.message ?? err}`);
    return { fallbackNote: "attachment could not be loaded", sourceUrl: isHttpUrl(url) ? url : void 0 };
  }
  const contentType = (media.contentType || "").split(";")[0].trim();
  const isImage = contentType.toLowerCase().startsWith("image/") || media.kind === "image";
  if (isImage && isHttpUrl(url) && contentType.toLowerCase().startsWith("image/")) {
    api.logger?.info?.(`[fizzy] outbound media ${url}: embedded as remote image (${contentType})`);
    return {
      attachment: { kind: "remote-image", url, contentType, caption: media.fileName || void 0 }
    };
  }
  const fileName = media.fileName || baseName(url) || "attachment";
  try {
    const sgid = await client.uploadFile(media.buffer, fileName, contentType || "application/octet-stream");
    api.logger?.info?.(`[fizzy] outbound media ${url}: uploaded as ${fileName} (${contentType || "unknown"}) -> sgid`);
    return { attachment: { kind: "sgid", sgid } };
  } catch (err) {
    api.logger?.warn?.(`[fizzy] outbound media ${url} upload failed: ${err?.message ?? err}`);
    return { fallbackNote: "attachment upload failed \u2014 shown as link", sourceUrl: isHttpUrl(url) ? url : void 0 };
  }
}
async function buildOutboundCommentBody(api, account, client, opts, deps = defaultDeps) {
  const attachments = [];
  const notes = [];
  const linkLines = [];
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
  if (notes.length) text = `${text}

[Note: ${notes.join("; ")}.]`.trim();
  return buildCommentBody(textToHtml(text), attachments);
}
export {
  buildOutboundCommentBody,
  resolveOutboundAttachment
};
