import { getStore } from "@netlify/blobs";

const STORE = "spell-images";
const MAX_BYTES = 1500000;
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

function imageId(url) {
  const id = new URL(url).searchParams.get("id") || "";
  return /^[a-f0-9]{24}$/.test(id) ? id : "";
}

function matches(bytes, type) {
  const sig = TYPES[type];
  if (!sig || bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  if (type === "image/webp") {
    const mark = String.fromCharCode(...bytes.slice(8, 12));
    return mark === "WEBP";
  }
  return true;
}

function newId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export default async (req) => {
  const store = getStore({ name: STORE, consistency: "strong" });

  if (req.method === "GET") {
    const id = imageId(req.url);
    if (!id) return new Response("找不到圖", { status: 404 });
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

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "不是有效的內容" }, 400);
    }
    const type = String(body && body.type || "");
    const data = String(body && body.data || "").replace(/\s/g, "");
    if (!TYPES[type] || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return json({ ok: false, error: "只收 png、jpeg、gif、webp" }, 400);
    }
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_BYTES || !matches(bytes, type)) {
      return json({ ok: false, error: "圖要是 1.5 MB 以內的 png、jpeg、gif 或 webp" }, 400);
    }
    const id = newId();
    await store.setJSON(id, { type, data });
    return json({ ok: true, url: "/api/images?id=" + id });
  }

  return json({ ok: false, error: "不支援這個動作" }, 405);
};
