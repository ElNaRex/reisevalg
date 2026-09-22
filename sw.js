// Nedlagt. Denne adressen serverer ikke Reisevalg lenger; appen ligger paa Enturs Cloud Run.
// Jobben til denne filen er aa fjerne seg selv, saa ingen enhet blir sittende fast i et bufret skall
// fra den gamle installasjonen. Ingen fetch-handler: alt gaar rett paa nett, slik at index.html
// (som er en henvisning videre) faktisk blir sett.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.clients.claim();
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => {});
    await self.registration.unregister();
  })());
});
