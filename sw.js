// Service worker: receives the morning push and caches the shell for offline opening.
const CACHE = "reisevalg-v4";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./journey-profile.mjs", "./answer-queue.mjs", "./config.js", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => null)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.includes("/api/")) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && url.origin === location.origin) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match("./index.html"))));
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: "Reisevalg", body: e.data ? e.data.text() : "" }; }
  const title = data.title || "Reisevalg";
  const options = {
    body: data.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/badge-96.png",
    tag: data.tag || "reisevalg", // one card per slot per day; a newer one replaces it
    renotify: true,
    data: { url: data.url || "./", verdictId: data.verdictId || null, deviceId: data.deviceId || null },
    actions: data.state === "TOG_VINNER" ? [{ action: "trains", title: "Vis togavganger" }] : [],
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Confirms that this device processed the push and the OS accepted showNotification.
    // It does not prove that the person has read the notification.
    if (data.receiptToken) {
      // The API may live on another origin than the app (GitHub Pages + API on the Mac / Supabase); app.js passes it as ?api= on registration.
      const apiBase = new URL(self.location.href).searchParams.get("api") || new URL("api", self.registration.scope).href;
      await fetch(apiBase.replace(/\/$/, "") + "/push-receipts", { method: "POST", headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" }, body: JSON.stringify({ token: data.receiptToken }) }).catch(() => {});
    }
  })());
});

const apiBase = () => new URL(self.location.href).searchParams.get("api") || new URL("api", self.registration.scope).href;
const swEvent = (kind, meta) => fetch(apiBase().replace(/\/$/, "") + "/events", { method: "POST", headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" }, body: JSON.stringify({ deviceId: meta.deviceId || "sw-" + (self.registration.scope.length + 8), kind, meta }) }).catch(() => {});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(swEvent("notification_click", { verdictId: e.notification.data?.verdictId || "", deviceId: e.notification.data?.deviceId || "" }));
  const target = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    if (open) { open.focus(); open.postMessage({ type: "open-verdict", verdictId: e.notification.data?.verdictId }); return; }
    return self.clients.openWindow(target);
  }));
});

// The push service may rotate the subscription; re-register it with the server.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const sub = await self.registration.pushManager.subscribe(e.oldSubscription?.options || { userVisibleOnly: true });
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((c) => c.postMessage({ type: "resubscribe", subscription: sub.toJSON() }));
  })());
});
