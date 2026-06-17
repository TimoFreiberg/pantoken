// Minimal service worker — enough to make pilot installable as a PWA and to host
// future Web Push handlers (see OPEN-QUESTIONS OQ5). Deliberately NOT caching the
// app shell yet: Vite emits hashed asset names, so a precache list would go stale
// every build. Network-first passthrough keeps it correct until we add Workbox.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", () => {
  // passthrough — let the network handle everything for now
});

// Web Push: deliver a notification even when every tab is closed. Payload is the
// JSON the server sends in PushService.sendToAll ({title, body, tag, url}).
self.addEventListener("push", (event) => {
  let data = { title: "pilot", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    /* malformed payload — fall back to defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "pilot", {
      body: data.body || "",
      tag: data.tag || "pilot",
      icon: "/icon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

// Focus an existing window if one is open, otherwise open the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const c of clients) {
          if ("focus" in c) return c.focus();
        }
        return self.clients.openWindow
          ? self.clients.openWindow(url)
          : undefined;
      }),
  );
});
