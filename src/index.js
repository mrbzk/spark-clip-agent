// Entry point: starts the Slack Bolt server, mounts the Higgsfield webhook,
// serves storyboard frames publicly, and runs a background reconciler.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, STATES } from "./config.js";
import { app, receiver } from "./slack/app.js";
import { store } from "./store.js";
import { onRenderComplete } from "./stateMachine.js";
import { pollRequest } from "./integrations/higgsfield.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Public frame hosting (Higgsfield needs real URLs, not Slack permalinks) ───
const framesDir = path.resolve("./data/frames");
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
receiver.router.use("/frames", express.static(framesDir));

// ── Higgsfield webhook (Higgsfield POSTs here when a render finishes) ─────────
receiver.router.use(express.json());
receiver.router.post("/webhooks/higgsfield", async (req, res) => {
  // Higgsfield doesn't send a secret header — skip check unless you embed
  // the secret in the webhook URL path itself for obscurity.

  const body = req.body || {};
  console.log("Higgsfield webhook received:", JSON.stringify(body));
  const requestId = body.request_id || body.id;
  const status = body.status;
  const videoUrl = body.video?.url || body.results?.raw?.url || null;
  res.sendStatus(200); // ack fast

  if (!requestId) return;

  const failed = status === "failed" || status === "nsfw";
  if (!(status === "completed" && videoUrl) && !failed) return; // intermediate status (queued/processing) — wait for a later call or the poller

  try { await onRenderComplete(requestId, failed ? null : videoUrl, !failed); }
  catch (e) { console.error("webhook handler error:", e.message); }
});

// health check for nginx / uptime monitors
receiver.router.get("/healthz", (_req, res) => res.json({ ok: true }));

// ── Background reconciler: catch renders whose webhook was missed ────────────
const RECONCILE_MS = 30_000;
setInterval(async () => {
  const inFlight = store.list().filter((p) =>
    [STATES.VIDEO_GENERATING, STATES.VIDEO_REVISING].includes(p.status)
  );
  for (const p of inFlight) {
    const pending = (p.videos || []).filter((v) => v.status === "rendering" && v.request_id);
    for (const v of pending) {
      try {
        const r = await pollRequest(v.request_id);
        if (r.status === "completed" && r.url) await onRenderComplete(v.request_id, r.url, true);
        else if (r.status === "failed") await onRenderComplete(v.request_id, null, false);
      } catch (e) { /* transient; try again next tick */ }
    }
  }
}, RECONCILE_MS);

(async () => {
  await app.start(config.app.port);
  console.log(`⚡ Spark Clip Agent running on :${config.app.port}`);
})();
