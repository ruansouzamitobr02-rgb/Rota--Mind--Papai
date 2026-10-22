const CACHE_NAME = "bot-rotas-shell-v8";
const SHELL_ASSETS = ["/manifest.webmanifest", "/br-skull-icon-192-v6.png", "/br-skull-icon-512-v6.png", "/br-skull-icon-maskable-512-v6.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("bot-rotas-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname === "/events" || url.pathname === "/qr.svg") return;
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate" || url.pathname === "/") {
    event.respondWith(networkFirst(event.request, "/"));
    return;
  }

  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request, fallbackUrl) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request) || (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    return cached || new Response("Sem conexão com o painel.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Bot Rotas", body: event.data?.text() || "Existe um aviso importante no painel." };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Bot Rotas", {
    body: data.body || "Existe um aviso importante no painel.",
    icon: data.icon || "/br-skull-icon-512-v6.png",
    badge: data.badge || "/br-skull-icon-maskable-512-v6.png",
    tag: data.tag || "bot-rotas-important",
    renotify: true,
    requireInteraction: Boolean(data.requireInteraction),
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || "/", self.location.origin);
  const targetUrl = requestedUrl.origin === self.location.origin ? requestedUrl.href : self.location.origin + "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.navigate(targetUrl);
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
