// Unit tests for the pure body-builder and the ActiveStorage direct-upload flow.
// Run against the built output (dist/src/client.js) via `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildCommentBody, FizzyClient } from "../dist/src/client.js";

test("buildCommentBody: text-only body is unchanged (regression)", () => {
  assert.equal(buildCommentBody("<p>hello</p>"), "<p>hello</p>");
  assert.equal(buildCommentBody("<p>hello</p>", []), "<p>hello</p>");
});

test("buildCommentBody: remote-image attachment renders a well-formed node", () => {
  const body = buildCommentBody("<p>chart</p>", [
    { kind: "remote-image", url: "https://cdn.example.com/a.png", contentType: "image/png", caption: "a.png" },
  ]);
  assert.match(body, /^<p>chart<\/p><action-text-attachment /);
  assert.match(body, /url="https:\/\/cdn\.example\.com\/a\.png"/);
  assert.match(body, /content-type="image\/png"/);
  assert.match(body, /caption="a\.png"/);
  assert.match(body, /<\/action-text-attachment>$/);
});

test("buildCommentBody: sgid attachment renders sgid node", () => {
  const body = buildCommentBody("<p>report</p>", [{ kind: "sgid", sgid: "BAh7CEki" }]);
  assert.match(body, /<action-text-attachment sgid="BAh7CEki"><\/action-text-attachment>/);
});

test("buildCommentBody: attribute values are escaped (no injection / breakout)", () => {
  const body = buildCommentBody("<p>x</p>", [
    {
      kind: "remote-image",
      url: 'https://e.com/a.png"><script>evil()</script>',
      contentType: "image/png",
      caption: 'cap"&<>',
    },
  ]);
  // The hostile quote/angle brackets must not survive as raw chars inside attrs.
  assert.ok(!body.includes('<script>'), "raw <script> must not appear");
  assert.match(body, /&quot;/);
  assert.match(body, /&lt;/);
  assert.match(body, /&gt;/);
  assert.match(body, /&amp;/);
  // Exactly one attachment tag — the injected sibling did not break out.
  assert.equal((body.match(/<action-text-attachment/g) || []).length, 1);
});

test("buildCommentBody: attachment-only reply drops the empty caption paragraph", () => {
  const body = buildCommentBody("<p></p>", [{ kind: "sgid", sgid: "S" }]);
  assert.equal(body, '<action-text-attachment sgid="S"></action-text-attachment>');
});

const account = {
  baseUrl: "https://fizzy.test",
  accountSlug: "acct",
  apiToken: "tok",
};

test("uploadFile: happy path returns sgid, sends base64-MD5 checksum, forwards PUT headers", async () => {
  const bytes = Buffer.from("hello world");
  const expectedChecksum = crypto.createHash("md5").update(bytes).digest("base64");
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/rails/active_storage/direct_uploads")) {
      const parsed = JSON.parse(init.body);
      assert.equal(parsed.blob.filename, "f.txt");
      assert.equal(parsed.blob.byte_size, bytes.length);
      assert.equal(parsed.blob.checksum, expectedChecksum);
      assert.equal(parsed.blob.content_type, "text/plain");
      return {
        ok: true,
        json: async () => ({
          attachable_sgid: "SGID123",
          signed_id: "SIGNED",
          direct_upload: { url: "https://storage.test/put/1", headers: { "Content-MD5": expectedChecksum } },
        }),
      };
    }
    // PUT step
    assert.equal(init.method, "PUT");
    assert.equal(init.headers["Content-MD5"], expectedChecksum);
    return { ok: true };
  };
  try {
    const client = new FizzyClient(account);
    const sgid = await client.uploadFile(bytes, "f.txt", "text/plain");
    assert.equal(sgid, "SGID123");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://storage.test/put/1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("uploadFile: throws when the create step is non-2xx", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 422, text: async () => "bad" });
  try {
    const client = new FizzyClient(account);
    await assert.rejects(() => client.uploadFile(Buffer.from("x"), "f", "text/plain"), /create failed: HTTP 422/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("uploadFile: throws when the PUT step is non-2xx", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/direct_uploads")) {
      return {
        ok: true,
        json: async () => ({ attachable_sgid: "S", direct_upload: { url: "https://storage.test/put", headers: {} } }),
      };
    }
    return { ok: false, status: 500 };
  };
  try {
    const client = new FizzyClient(account);
    await assert.rejects(() => client.uploadFile(Buffer.from("x"), "f", "text/plain"), /PUT failed: HTTP 500/);
  } finally {
    global.fetch = originalFetch;
  }
});
