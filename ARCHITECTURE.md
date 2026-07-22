# Spark Clip Agent — Architecture & Build Spec

**Owner:** Jeff (No Loss Leads)
**Purpose:** A Slack-driven agent that takes a product brief and produces 5 avatar-free product-video ads (15 "Spark Clips" total), with a storyboard-approval loop and a per-video approval loop, logging everything to a Notion Project Tracker and delivering final files via a Google Drive folder.
**Deployment target:** Node.js service on a Hostinger VPS. Slack is the primary interface. An optional React dashboard shows live project status.

---

## 1. What the agent does (plain-English recap)

1. A project is **initiated from a Slack channel** (slash command or a message in a dedicated channel).
2. The agent **opens a Slack thread** and gathers the brief: product, website, product images, rough storyline/details, and options (avatar-free, model = Seedance 2 by default).
3. It generates a **storyboard for all 5 videos** (15 Spark Clips, 3 per video) using **Gemini image generation**, primarily using the supplied product photos.
4. The storyboard is **posted to the thread for review** — **Approve** or **give feedback**. Feedback → storyboard is revised → re-posted.
5. On storyboard approval, the agent renders **video 1** using **Higgsfield (Seedance 2 by default)**.
6. The **v1 link is posted to the thread**.
7. **Approve or feedback.** Feedback → agent confirms the interpreted changes → on acceptance, **re-renders**.
8. On video approval, the user can **render all remaining 4 at once** or **continue one-by-one** (default: **one-by-one**).
9. When all 5 are approved, the agent posts a **final set of preview links** plus a **Google Drive folder link** containing all videos.

Everything is **logged to Notion** at each state change.

---

## 2. The "15 Spark Clips" model

- **5 videos** per project.
- **3 clips per video** = **15 clips**.
- Seedance 2 supports up to ~15s per shot and multi-shot composition, so each "video" is assembled from 3 clip-shots. The storyboard defines all 15 clips grouped under their 5 parent videos so the whole set is reviewed in one pass (per the spec: "the storyboard for all 5 videos created").

> If your intended ratio is different (e.g. 5 clips × 3 videos), it's a single config constant — `CLIPS_PER_VIDEO` — so the pipeline doesn't need rewriting.

---

## 3. High-level architecture

```
                 ┌───────────────────────────────────────────────┐
                 │                 Hostinger VPS                  │
                 │                                                │
  Slack  ──────► │  nginx (TLS)  ─►  Node service (Slack Bolt +   │
  (events,       │                   Express receiver)            │
   buttons)      │                        │                       │
                 │                        ▼                       │
  Higgsfield ──► │  /webhooks/higgsfield  ─►  State Machine       │
  (render done)  │                        │                       │
                 │                        ├─► SQLite (projects)   │
                 │                        │                       │
                 │                        ├─► Gemini API (storyb.)│
                 │                        ├─► Higgsfield SDK (vid)│
                 │                        ├─► Notion API (tracker)│
                 │                        └─► Google Drive (files)│
                 │                                                │
                 │  React dashboard (static build, optional) ◄────┤
                 └───────────────────────────────────────────────┘
```

**Runtime pieces**

- **Slack Bolt (HTTP mode)** on an Express receiver — handles the slash command, thread replies, and Block Kit button clicks (Approve / Request changes).
- **State machine** — one record per project, keyed by the Slack `thread_ts`. Drives every transition.
- **Integration clients** — thin wrappers for Gemini, Higgsfield, Notion, Google Drive.
- **Persistence** — SQLite via `better-sqlite3` (simple, file-based, survives restarts). Swappable for Postgres.
- **Background worker** — polls in-flight Higgsfield jobs as a fallback to webhooks; also handles retries.
- **React dashboard (optional)** — read-only view of all projects and their current state; served as a static build behind the same nginx.

---

## 4. Interaction design in Slack

**Initiation** — `/spark-clip` slash command (or posting in the dedicated `#spark-clips` channel). The agent replies in-channel, creating the project thread.

**Brief intake** — the agent asks for the brief in the thread. Two supported input styles:
- **Form (recommended):** a Slack modal opened from the slash command, capturing product name, website URL, storyline/details, avatar-free toggle, model dropdown (default Seedance 2), and image uploads/URLs.
- **Conversational:** the agent asks follow-up questions in-thread until all required fields are present.

**Approvals** — every review step posts a message with two Block Kit buttons: **✅ Approve** and **✏️ Request changes**, plus a note that they can just reply with feedback in the thread. Free-text replies in the thread are always treated as feedback for the current review item.

**Video feedback confirmation (step 7)** — when feedback is given on a video, the agent replies with its interpreted change list ("Here's what I'll change: …") and an **Confirm & re-render** / **Not quite** button pair. Only on Confirm does it re-render (saves render credits).

**Batch choice (step 8)** — after video 1 is approved, the agent posts **"Render all remaining 4"** vs **"Continue one-by-one"** (default one-by-one if they just say "next").

---

## 5. State machine

One project = one record keyed by `thread_ts`. States:

| State | Meaning | Exits |
|---|---|---|
| `INTAKE` | Collecting the brief | all fields present → `STORYBOARD_GENERATING` |
| `STORYBOARD_GENERATING` | Gemini building 15-clip storyboard | done → `STORYBOARD_REVIEW` |
| `STORYBOARD_REVIEW` | Awaiting approve/feedback | approve → `VIDEO_GENERATING`; feedback → `STORYBOARD_REVISING` |
| `STORYBOARD_REVISING` | Applying feedback via Gemini | done → `STORYBOARD_REVIEW` |
| `VIDEO_GENERATING` | Higgsfield rendering video *n* | done → `VIDEO_REVIEW` |
| `VIDEO_REVIEW` | Awaiting approve/feedback on video *n* | approve → next video or `COMPILING`; feedback → `VIDEO_FEEDBACK_CONFIRM` |
| `VIDEO_FEEDBACK_CONFIRM` | Agent posted interpreted changes | confirm → `VIDEO_REVISING`; reject → back to `VIDEO_REVIEW` |
| `VIDEO_REVISING` | Re-rendering video *n* | done → `VIDEO_REVIEW` |
| `COMPILING` | Uploading finals to Drive | done → `COMPLETE` |
| `COMPLETE` | Final links + Drive folder posted | terminal |
| `FAILED` | Unrecoverable error (credits, API) | manual retry |

**Per-project fields**: `thread_ts`, `channel_id`, `status`, `current_video_index` (1–5), `render_mode` (`one_by_one` | `batch`), `brief` (product, website, images[], storyline, avatar_free, model), `storyboard` (15 clips + image URLs + revision count), `videos[]` (per video: status, higgsfield request_id, url, revision count), `notion_page_id`, `drive_folder_id`.

---

## 6. Integrations

### 6.1 Gemini (storyboard)
- Model: **Gemini 2.5 Flash Image** (a.k.a. Nano Banana) via `:generateContent`, or Nano Banana 2 (Gemini 3.x Flash Image) for higher quality. Model name is a config value.
- Input: the product photos (as inline image parts) + a structured prompt describing all 15 clips. Because it's product-led and avatar-free, the prompt instructs "product hero shots, no human faces/avatars."
- Output: one storyboard image per clip (or a contact-sheet per video). Images are saved and posted to Slack.
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `x-goog-api-key`.

### 6.2 Higgsfield (video)
- Raw REST calls via `fetch` (no SDK dependency). Auth header: `Authorization: Key KEY_ID:KEY_SECRET`.
- Call: `POST https://platform.higgsfield.ai/{model}?hf_webhook={url}` — the model slug goes directly off the API root, there is **no** `/v1/image2video/` prefix. We prefer **webhook** delivery so the VPS isn't holding long HTTP calls; a polling worker (`GET /requests/{request_id}/status`) is the fallback.
- Model: **`seedance_2_0`** by default (Seedance 2.0; underscore-separated, confirmed against Higgsfield's own CLI docs and dashboard-generated code samples) — overridable per project (`brief.model`), stored in config as `HIGGSFIELD_DEFAULT_MODEL`.
- Input assembled from: approved storyboard frames + product images + per-clip prompt, sent as `image_url` (primary) + `image_references` (up to 9 more).
- Response: `{ request_id, status_url, cancel_url }` on submit; polling returns `{ status, video: { url } }`. On `completed`, we store the URL.

### 6.3 Notion (Project Tracker)
- SDK: `@notionhq/client`. A database ("Spark Clip Projects") with properties: Name, Status (select), Product, Website, Model, Videos Approved (number), Storyboard link, Video links (rich text/URLs), Drive folder (URL), Slack thread (URL), Created.
- A row is created at `INTAKE`; the Status property and links are updated on every transition.

### 6.4 Google Drive (delivery)
- SDK: `googleapis` with a **service account** (share the parent folder with the service account email). Create a per-project subfolder, upload the 5 final MP4s, set the folder link-shareable, return the folder URL.

### 6.5 Slack
- **For the deployed app, use Slack's own Bot (Bolt) — not the Cowork Slack connector.** The Cowork connector is only for this design session. The deployed agent needs its own Slack app with scopes: `commands`, `chat:write`, `files:read`, `files:write`, `channels:history`, `groups:history`, `reactions:read`, `im:history`, plus Event Subscriptions and Interactivity pointed at the VPS URL.

---

## 7. Deployment on Hostinger VPS

1. Ubuntu VPS, Node 20+, `pm2`, `nginx`, a domain/subdomain (e.g. `agent.nolossleads.com`) with Let's Encrypt TLS.
2. nginx reverse-proxies `443` → Node (`3000`). Public routes needed: `/slack/events`, `/slack/interactive`, `/slack/commands`, `/webhooks/higgsfield`.
3. `pm2 start ecosystem.config.js` keeps the service alive and restarts on boot.
4. Secrets in `.env` (never committed): Slack tokens, Gemini key, Higgsfield credentials, Notion token + DB id, Google service-account JSON path, Drive parent folder id.
5. Optional React dashboard: `npm run build` → nginx serves the static build at `/dashboard`.

---

## 8. Failure handling & credit safety

- **Confirm-before-render** on video feedback so credits are only spent on accepted changes.
- Every Higgsfield job stores its `request_id`; webhook + polling worker reconcile so a missed webhook never strands a project.
- `nsfw` / `failed` / `NotEnoughCredits` statuses post a clear message to the thread and set `FAILED` with a retry button.
- Idempotency: transitions check current state before acting, so a double-click on Approve can't double-render.

---

## 9. Build order (suggested)

1. Slack app + slash command + thread creation + intake modal.
2. SQLite store + state machine skeleton.
3. Notion row create/update.
4. Gemini storyboard generation + Slack posting + approval loop.
5. Higgsfield render (webhook) + Slack posting + approval loop + feedback-confirm.
6. Batch vs one-by-one + completion + Google Drive delivery.
7. Optional React dashboard.
8. Harden: retries, idempotency, logging, tests.

See `/src` for the runnable scaffold implementing steps 1–6.
