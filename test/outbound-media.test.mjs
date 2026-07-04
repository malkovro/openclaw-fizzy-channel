// Unit tests for the shared outbound-media resolver/builder. The SDK media loader
// is injected (last arg) so these run offline with no real fetch.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveOutboundAttachment, buildOutboundCommentBody } from "../dist/src/outbound-media.js";

const account = { sendOutboundImages: true, maxImageBytes: 5_000_000 };
const silentApi = { logger: {} };

function fakeLoader(result) {
  return async () => result;
}

function stubClient() {
  const calls = [];
  return {
    calls,
    uploadFile: async (bytes, filename, contentType) => {
      calls.push({ bytes, filename, contentType });
      return "SGID_UPLOADED";
    },
  };
}

test("resolveOutboundAttachment: public image URL -> remote-image, no upload", async () => {
  const client = stubClient();
  const res = await resolveOutboundAttachment(
    silentApi,
    account,
    client,
    "https://cdn.example.com/pic.png",
    {},
    { loadMedia: fakeLoader({ buffer: Buffer.from("x"), contentType: "image/png", kind: "image", fileName: "pic.png" }) },
  );
  assert.equal(res.attachment.kind, "remote-image");
  assert.equal(res.attachment.url, "https://cdn.example.com/pic.png");
  assert.equal(res.attachment.contentType, "image/png");
  assert.equal(client.calls.length, 0, "uploadFile must not be called for a public image URL");
});

test("resolveOutboundAttachment: local image path -> upload -> sgid", async () => {
  const client = stubClient();
  const res = await resolveOutboundAttachment(
    silentApi,
    account,
    client,
    "/tmp/generated/chart.png",
    {},
    { loadMedia: fakeLoader({ buffer: Buffer.from("bytes"), contentType: "image/png", kind: "image", fileName: "chart.png" }) },
  );
  assert.equal(res.attachment.kind, "sgid");
  assert.equal(res.attachment.sgid, "SGID_UPLOADED");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].filename, "chart.png");
  assert.equal(client.calls[0].contentType, "image/png");
});

test("resolveOutboundAttachment: non-image file (even public URL) -> upload -> sgid", async () => {
  const client = stubClient();
  const res = await resolveOutboundAttachment(
    silentApi,
    account,
    client,
    "https://x.com/report.pdf",
    {},
    { loadMedia: fakeLoader({ buffer: Buffer.from("%PDF"), contentType: "application/pdf", kind: "document", fileName: "report.pdf" }) },
  );
  assert.equal(res.attachment.kind, "sgid");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].contentType, "application/pdf");
});

test("resolveOutboundAttachment: loader failure -> fallback note, no throw", async () => {
  const client = stubClient();
  const res = await resolveOutboundAttachment(
    silentApi,
    account,
    client,
    "https://x.com/bad.png",
    {},
    { loadMedia: async () => { throw new Error("boom"); } },
  );
  assert.equal(res.attachment, undefined);
  assert.match(res.fallbackNote, /could not be loaded/);
  assert.equal(res.sourceUrl, "https://x.com/bad.png");
  assert.equal(client.calls.length, 0);
});

test("resolveOutboundAttachment: upload failure -> fallback note, no throw", async () => {
  const client = {
    uploadFile: async () => { throw new Error("upload 500"); },
  };
  const res = await resolveOutboundAttachment(
    silentApi,
    account,
    client,
    "https://x.com/report.pdf",
    {},
    { loadMedia: fakeLoader({ buffer: Buffer.from("x"), contentType: "application/pdf", kind: "document", fileName: "report.pdf" }) },
  );
  assert.equal(res.attachment, undefined);
  assert.match(res.fallbackNote, /upload failed/);
  assert.equal(res.sourceUrl, "https://x.com/report.pdf");
});

test("resolveOutboundAttachment: sendOutboundImages=false -> fallback, no load/upload", async () => {
  const client = stubClient();
  let loaded = false;
  const res = await resolveOutboundAttachment(
    silentApi,
    { sendOutboundImages: false, maxImageBytes: 5_000_000 },
    client,
    "https://x.com/pic.png",
    {},
    { loadMedia: async () => { loaded = true; return {}; } },
  );
  assert.equal(res.attachment, undefined);
  assert.match(res.fallbackNote, /disabled/);
  assert.equal(loaded, false);
  assert.equal(client.calls.length, 0);
});

test("buildOutboundCommentBody: caption + one remote image attachment", async () => {
  const client = stubClient();
  const html = await buildOutboundCommentBody(
    silentApi,
    account,
    client,
    { caption: "Here you go", mediaUrls: ["https://cdn.example.com/a.png"] },
    { loadMedia: fakeLoader({ buffer: Buffer.from("x"), contentType: "image/png", kind: "image", fileName: "a.png" }) },
  );
  assert.match(html, /<p>Here you go<\/p>/);
  assert.match(html, /<action-text-attachment url="https:\/\/cdn\.example\.com\/a\.png"/);
});

test("buildOutboundCommentBody: fallback folds a link line + note into the caption", async () => {
  const client = stubClient();
  const html = await buildOutboundCommentBody(
    silentApi,
    account,
    client,
    { caption: "See attached", mediaUrls: ["https://x.com/bad.png"] },
    { loadMedia: async () => { throw new Error("boom"); } },
  );
  assert.match(html, /See attached/);
  assert.match(html, /https:\/\/x\.com\/bad\.png/);
  assert.match(html, /Note:/);
  assert.ok(!html.includes("<action-text-attachment"), "no attachment node on fallback");
});
