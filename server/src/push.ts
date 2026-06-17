// Web Push fan-out: lets the server buzz a *closed* phone (or any installed PWA)
// via the Web Push protocol — the piece tab-open Notifications can't do. Keeps a
// file-backed subscription store + a persistent VAPID keypair under config.dataDir
// so subscriptions survive a server restart (a closed phone subscribes once).
//
// iOS caveat (the spike's real risk): Web Push only works for a PWA the user has
// installed to the home screen, on iOS 16.4+. The library crypto path is validated
// under Bun; on-device delivery is validated on the owner's actual iPhone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { config } from "./config.js";

export interface PushNotification {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class PushService {
  private subs = new Map<string, PushSubscription>();
  private readonly vapid: VapidKeys;
  private readonly subsFile: string;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.vapid = loadOrCreateVapid(join(config.dataDir, "vapid.json"));
    this.subsFile = join(config.dataDir, "push-subscriptions.json");
    this.loadSubs();
    webpush.setVapidDetails(
      config.vapidSubject,
      this.vapid.publicKey,
      this.vapid.privateKey,
    );
    // Apple rejects placeholder subjects with 403 BadJwtToken — warn loudly rather
    // than fail silently on the first real send.
    if (/localhost|example\.com/.test(config.vapidSubject))
      console.warn(
        `[push] VAPID subject is a placeholder (${config.vapidSubject}). iOS push will fail with BadJwtToken — set PILOT_VAPID_SUBJECT to your real https:// host or mailto:.`,
      );
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }
  get count(): number {
    return this.subs.size;
  }

  /** Idempotent — keyed by endpoint, so re-subscribing the same device is a no-op. */
  add(sub: PushSubscription): void {
    this.subs.set(sub.endpoint, sub);
    this.persist();
    console.log(`[push] subscription added (${this.subs.size} total)`);
  }

  remove(endpoint: string): void {
    if (this.subs.delete(endpoint)) this.persist();
  }

  /** Send to every stored subscription; prune the ones the push service reports gone. */
  async sendToAll(n: PushNotification): Promise<number> {
    if (this.subs.size === 0) return 0;
    const payload = JSON.stringify(n);
    const dead: string[] = [];
    let sent = 0;
    await Promise.all(
      [...this.subs.values()].map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // 404/410 = subscription expired or was revoked -> drop it.
          if (code === 404 || code === 410) dead.push(sub.endpoint);
          else
            console.error(
              `[push] send failed (${code ?? "?"})`,
              (e as { body?: string }).body ?? String(e),
            );
        }
      }),
    );
    if (dead.length) {
      for (const ep of dead) this.subs.delete(ep);
      this.persist();
      console.log(`[push] pruned ${dead.length} dead subscription(s)`);
    }
    return sent;
  }

  private loadSubs(): void {
    if (!existsSync(this.subsFile)) return;
    try {
      const arr = JSON.parse(
        readFileSync(this.subsFile, "utf8"),
      ) as PushSubscription[];
      for (const s of arr) this.subs.set(s.endpoint, s);
      if (arr.length)
        console.log(`[push] loaded ${arr.length} subscription(s)`);
    } catch (e) {
      console.error("[push] failed to load subscriptions", e);
    }
  }

  private persist(): void {
    writeFileSync(
      this.subsFile,
      JSON.stringify([...this.subs.values()], null, 2),
    );
  }
}

function loadOrCreateVapid(path: string): VapidKeys {
  if (existsSync(path))
    return JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys, null, 2));
  console.log(`[push] generated a new VAPID keypair at ${path}`);
  return keys;
}
