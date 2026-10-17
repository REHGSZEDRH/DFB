import { getStore } from "@netlify/blobs";

const STORE = "spell-formal";
const IMAGE_STORE = "spell-images";
const KEY = "all";
const MAX_TEXT = 600000;
const MAX_BYTES = 3000000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cleanRecord(record) {
  if (!record || typeof record !== "object") return null;
  const text = String(record.text || "").replace(/\u0000/g, "").trim();
  if (!text) return null;
  return {
    text: text.slice(0, MAX_TEXT),
    num: String(record.num || "").slice(0, 16),
    zh: String(record.zh || "").slice(0, 80),
    en: String(record.en || "").slice(0, 160),
    updated: new Date().toISOString()
  };
}

function cleanKey(key) {
  const value = String(key || "");
  if (!value || value.length > 500 || /[\u0000-\u001f]/.test(value)) return "";
  return value;
}

function blobId(url) {
  try {
    const params = new URL(url, "https://local.invalid").searchParams;
    const id = params.get("file") || params.get("image") || params.get("id") || "";
    return /^[a-f0-9]{24}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function brand(bytes, start) {
  return String.fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]).toLowerCase();
}

function sniffImage(bytes) {
  if (!bytes || bytes.length < 4) return "";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return "image/x-icon";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && brand(bytes, 8) === "webp") return "image/webp";
  if (bytes.length >= 12 && brand(bytes, 4) === "ftyp") {
    const kind = brand(bytes, 8);
    if (kind === "avif" || kind === "avis") return "image/avif";
    if (kind.indexOf("hei") === 0 || kind === "mif1" || kind === "msf1") return "image/heic";
  }
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) return "image/tiff";
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) return "image/tiff";
  const head = Buffer.from(bytes.subarray(0, 500)).toString("utf8").replace(/^\uFEFF/, "").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

function safeName(name) {
  return String(name || "file").replace(/[\u0000-\u001f"\\]/g, "").slice(0, 80) || "file";
}

function serveBlob(saved) {
  if (!saved || !saved.data) return new Response("找不到檔案", { status: 404 });
  const bytes = Buffer.from(String(saved.data), "base64");
  if (!bytes.length) return new Response("找不到檔案", { status: 404 });
  const type = sniffImage(bytes);
  const headers = {
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=31536000, immutable"
  };
  if (type && type !== "image/svg+xml") {
    headers["content-type"] = type;
    return new Response(bytes, { headers });
  }
  if (type === "image/svg+xml") {
    headers["content-type"] = "image/svg+xml";
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    return new Response(bytes, { headers });
  }
  headers["content-type"] = "application/octet-stream";
  headers["content-disposition"] = "attachment; filename*=UTF-8''" + encodeURIComponent(safeName(saved.name));
  return new Response(bytes, { headers });
}

async function saveBlob(body) {
  const data = String(body && body.data || "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return json({ ok: false, error: "檔案內容不正確" }, 400);
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES) return json({ ok: false, error: "檔案要在 3 MB 以內" }, 400);
  const sniffed = sniffImage(bytes);
  const claimed = String(body && body.type || "").split(";")[0].trim().toLowerCase().slice(0, 80);
  const id = newId();
  const store = getStore({ name: IMAGE_STORE, consistency: "strong" });
  await store.setJSON(id, {
    type: sniffed || claimed || "application/octet-stream",
    data,
    name: safeName(body && body.name)
  });
  return json({ ok: true, url: "/api/settings?file=" + id, image: !!sniffed, type: sniffed || claimed || "application/octet-stream" });
}

function newId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function updateAll(mutate) {
  const store = getStore({ name: STORE, consistency: "strong" });
  for (let i = 0; i < 6; i++) {
    const got = await store.getWithMetadata(KEY, { type: "json", consistency: "strong" });
    const current = got && got.data && typeof got.data === "object" ? got.data : {};
    mutate(current);
    if (got && got.etag) {
      const result = await store.setJSON(KEY, current, { onlyIfMatch: got.etag });
      if (result && result.modified) return current;
      continue;
    }
    const created = await store.setJSON(KEY, current, { onlyIfNew: true });
    if (!created || created.modified !== false) return current;
  }
  throw new Error("busy");
}

export default async (req) => {
  if (req.method === "GET") {
    const id = blobId(req.url);
    if (id) {
      const store = getStore({ name: IMAGE_STORE, consistency: "strong" });
      const saved = await store.get(id, { type: "json", consistency: "strong" });
      return serveBlob(saved);
    }
    const store = getStore({ name: STORE, consistency: "strong" });
    const settings = (await store.get(KEY, { type: "json", consistency: "strong" })) || {};
    return json({ ok: true, settings });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "不是有效的內容" }, 400);
    }
    if (body && body.image) return saveBlob(body);
    return json({ ok: false, error: "不支援這個動作" }, 405);
  }

  if (req.method === "PUT") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "不是有效的內容" }, 400);
    }
    const key = cleanKey(body && body.key);
    if (!key) return json({ ok: false, error: "沒有這條" }, 400);
    const record = cleanRecord(body && body.record);
    try {
      const settings = await updateAll(current => {
        if (record) current[key] = record;
        else delete current[key];
      });
      return json({ ok: true, settings });
    } catch {
      return json({ ok: false, error: "沒寫上，請再存一次" }, 503);
    }
  }

  return json({ ok: false, error: "不支援這個動作" }, 405);
};
