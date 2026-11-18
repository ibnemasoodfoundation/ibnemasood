/* Jamia portal service worker: works without internet and syncs when the connection returns.
   - Pages you open are kept on this device, so they still open offline (the last copy you saw).
   - Forms saved offline (attendance, marks, progress, registrations…) wait in a queue on this device
     and are sent automatically, in order, as soon as the internet is back.
   - Signing out removes the saved pages from the device. */
"use strict";
const VERSION = "v1";
const STATIC = "jaabm-static-" + VERSION;
const PAGES = "jaabm-pages";
const PRECACHE = ["/assets/css/style.css", "/assets/css/app.css", "/assets/js/app.js", "/assets/js/offline.js", "/assets/images/logo-sm.jpg"];
// Never kept on the device or queued: private files, backups, sign-in, health checks
const NO_CACHE = [/^\/app\/files\//, /^\/app\/backup/, /^\/api\//, /^\/login/, /^\/signup/, /^\/lang\//, /^\/section\//];
const NO_QUEUE = [/^\/app\/backup/, /^\/login/, /^\/signup/, /^\/logout/];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("jaabm-static-") && k !== STATIC).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* ---------- Queue in IndexedDB ---------- */
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("jaabm-offline", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("queue", mode), s = tx.objectStore("queue");
    const out = fn(s);
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    tx.onerror = () => reject(tx.error);
  });
}
const queueAll = () => store("readonly", (s) => s.getAll());
const queueAdd = (item) => store("readwrite", (s) => s.add(item));
const queueDel = (id) => store("readwrite", (s) => s.delete(id));

async function tell(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

/* Sends queued forms in order. Stops at the first network failure and tries again later. */
let flushing = null;
function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0, failed = 0, login = false;
    for (const item of await queueAll()) {
      let res;
      try {
        res = await fetch(item.url, { method: "POST", body: item.body, headers: { "Content-Type": item.type }, credentials: "same-origin", redirect: "follow" });
      } catch { break; } // still offline
      if (res.redirected && new URL(res.url).pathname.startsWith("/login")) { login = true; break; } // signed out: keep it for later
      if (res.ok) { await queueDel(item.id); sent++; }
      else if (res.status >= 400 && res.status < 500) { await queueDel(item.id); failed++; } // refused by the server (expired form, not allowed)
      else break; // server trouble: try again later
    }
    const left = (await queueAll()).length;
    await tell({ type: "synced", sent, failed, left, login });
    return { sent, failed, left };
  })().finally(() => { flushing = null; });
  return flushing;
}

function page(title, text) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#FCFAF4;color:#1C2033;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem}
.box{max-width:460px;background:#fff;border:1px solid #E7DEC8;border-radius:14px;padding:1.6rem;text-align:center}h1{color:#0F1842;font-size:1.3rem}
a,button{display:inline-block;margin-top:.8rem;background:#0F1842;color:#E3BE62;border:0;border-radius:999px;padding:.6rem 1.2rem;font:inherit;text-decoration:none;cursor:pointer}</style>
<div class="box"><h1>${title}</h1><p>${text}</p><button onclick="history.length > 1 ? history.back() : location.assign('/app')">Back</button></div></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.method === "POST") {
    if (NO_QUEUE.some((r) => r.test(url.pathname)) || !url.pathname.startsWith("/app")) return;
    const copy = req.clone();
    e.respondWith(fetch(req).catch(async () => {
      await queueAdd({ url: req.url, type: copy.headers.get("Content-Type") || "application/x-www-form-urlencoded", body: await copy.arrayBuffer(), at: Date.now() });
      if (self.registration.sync) self.registration.sync.register("jaabm-sync").catch(() => {});
      const left = (await queueAll()).length;
      await tell({ type: "queued", left });
      return page("Saved on this device", `There is no internet right now, so this was saved on this device (${left} waiting). It will be sent automatically when the connection comes back. Keep this browser open or come back online later.`);
    }));
    return;
  }
  if (req.method !== "GET") return;

  // CSS, scripts and images: from the device, refreshed in the background
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(caches.open(STATIC).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (NO_CACHE.some((r) => r.test(url.pathname))) return;

  // Pages: the internet first; the saved copy when offline
  const isPage = req.mode === "navigate" || (req.headers.get("Accept") || "").includes("text/html") || url.pathname.startsWith("/app");
  if (!isPage) return;
  e.respondWith(fetch(req).then((r) => {
    const toLogin = r.redirected && new URL(r.url).pathname.startsWith("/login");
    if (r.ok && !toLogin) caches.open(PAGES).then((c) => c.put(req, r.clone()));
    return r;
  }).catch(async () => {
    const c = await caches.open(PAGES);
    return (await c.match(req)) || (await c.match(req, { ignoreSearch: true })) ||
      page("You are offline", "This page has not been opened on this device yet, so it is not available without internet. Pages you have opened before still work.");
  }));
});

self.addEventListener("sync", (e) => { if (e.tag === "jaabm-sync") e.waitUntil(flush()); });
self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type === "sync") e.waitUntil(flush());
  if (m.type === "count") e.waitUntil(queueAll().then((q) => e.source && e.source.postMessage({ type: "count", left: q.length })));
  if (m.type === "logout") e.waitUntil(caches.delete(PAGES));
});
