import { getStore } from "@netlify/blobs";

const STORE = "spell-formal";
const IMAGE_STORE = "spell-images";
const KEY = "all";
const MAX_TEXT = 600000;
const MAX_IMAGE = 1500000;
const TYPES = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46],
  "image/webp": [0x52, 0x49, 0x46, 0x46]
};

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

function imageId(url) {
  const id = new URL(url).searchParams.get("image") || "";
  return /^[a-f0-9]{24}$/.test(id) ? id : "";
}

function matches(bytes, type) {
  const sig = TYPES[type];
  if (!sig || bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  if (type === "image/webp") return String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return true;
}

function newId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function serveImage(id) {
  const store = getStore({ name: IMAGE_STORE, consistency: "strong" });
  const saved = await store.get(id, { type: "json", consistency: "strong" });
  if (!saved || !TYPES[saved.type] || !saved.data) return new Response("找不到圖", { status: 404 });
  const bytes = Buffer.from(String(saved.data), "base64");
  if (!matches(bytes, saved.type)) return new Response("找不到圖", { status: 404 });
  return new Response(bytes, {
    headers: {
      "content-type": saved.type,
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}

async function saveImage(body) {
  const type = String(body && body.type || "");
  const data = String(body && body.data || "").replace(/\s/g, "");
  if (!TYPES[type] || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return json({ ok: false, error: "只收 png、jpeg、gif、webp" }, 400);
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE || !matches(bytes, type)) {
    return json({ ok: false, error: "圖要是 1.5 MB 以內的 png、jpeg、gif 或 webp" }, 400);
  }
  const id = newId();
  const store = getStore({ name: IMAGE_STORE, consistency: "strong" });
  await store.setJSON(id, { type, data });
  return json({ ok: true, url: "/api/settings?image=" + id });
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
    const id = imageId(req.url);
    if (id) return serveImage(id);
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
    if (body && body.image) return saveImage(body);
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
