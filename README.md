# Spark Clip Agent

A Slack-driven agent that turns a product brief into **5 avatar-free product-video ads (15 Spark Clips)** using **Gemini** storyboards and **Higgsfield** video (DoP Standard by default), with **Notion** logging and **Google Drive** delivery.

> Read `ARCHITECTURE.md` first for the full design and the state machine.

## What it does

`/spark-clip` in Slack → intake modal → agent opens a project thread → generates a storyboard (15 clips across 5 videos) with Gemini → you **Approve** or give feedback in the thread → on approval it renders **Video 1** with Higgsfield → you approve/feedback each video → after video 1 you choose **render all remaining** or **one-by-one** (default one-by-one) → when all 5 are approved it uploads to a Google Drive folder and posts the final links. Every step is logged to Notion.

## Project layout

```
spark-clip-agent/
├─ ARCHITECTURE.md          full spec + state machine
├─ package.json
├─ .env.example             copy to .env and fill in
├─ ecosystem.config.js      pm2 process file
└─ src/
   ├─ index.js              server entry: Slack + Higgsfield webhook + reconciler
   ├─ config.js             env + state constants
   ├─ store.js              SQLite persistence (one row per Slack thread)
   ├─ stateMachine.js       the orchestration brain (all transitions)
   ├─ prompts.js            storyboard + clip prompt builders
   ├─ slack/
   │  ├─ app.js             Bolt: slash command, modal, buttons, thread replies
   │  └─ say.js             all Slack posting helpers (Block Kit)
   └─ integrations/
      ├─ gemini.js          storyboard image generation
      ├─ higgsfield.js      Higgsfield render submit + poll
      ├─ notion.js          project tracker create/update
      └─ gdrive.js          final delivery folder + uploads
```

## Local setup

```bash
npm install
cp .env.example .env        # fill in every value
npm run init-db
npm start
```

## Slack app configuration

Create a Slack app (api.slack.com/apps) and set:

- **Bot token scopes:** `commands`, `chat:write`, `files:read`, `files:write`, `channels:history`, `groups:history`, `im:history`, `reactions:read`
- **Slash command:** `/spark-clip` → Request URL `https://YOUR_DOMAIN/slack/commands`
- **Interactivity:** on → Request URL `https://YOUR_DOMAIN/slack/interactive`
- **Event Subscriptions:** on → Request URL `https://YOUR_DOMAIN/slack/events`; subscribe to `message.channels`, `message.groups`
- Install to workspace, copy the bot token + signing secret into `.env`.

## Notion setup

Create a database named **Spark Clip Projects** with properties: `Name` (title), `Status` (select), `Product` (text), `Website` (url), `Model` (text), `Videos Approved` (number), `Storyboard` (url), `Video Links` (text), `Drive Folder` (url), `Slack Thread` (url), `Created` (date). Share it with your Notion integration, then put the token + database id in `.env`.

## Google Drive setup

Create a Google Cloud **service account**, download its JSON key to `./secrets/`, and **share the parent Drive folder** with the service-account email. Put the JSON path + parent folder id in `.env`.

## Higgsfield setup

Get API credentials (`KEY_ID:KEY_SECRET`) from the Higgsfield dashboard. Default model is `higgsfield-ai/dop/standard` — **check the model gallery on `cloud.higgsfield.ai`** for which models are actually enabled for API access on your account before changing `HIGGSFIELD_DEFAULT_MODEL` (Seedance 2.0, for example, shows up in the regular web app but is not necessarily enabled for the public API). Renders return via the webhook at `/webhooks/higgsfield`; the background reconciler catches any missed webhooks.

### ⚠️ Hosting images for Higgsfield
Higgsfield needs **publicly reachable image URLs** for the storyboard frames and product photos it renders from. Slack file permalinks are not reliably public. In production, upload the Gemini frames to a public bucket (S3/R2/GCS or your VPS behind nginx) and store that URL as `frame.hostedUrl` / `productImages[].hostedUrl`. The scaffold marks exactly where these URLs are read (`stateMachine.renderVideo`) and written (`slack/say.postStoryboard`). This is the one piece you must wire to your own storage.

## Deploy to Hostinger VPS

```bash
# on the VPS (Ubuntu, Node 20+)
git clone <your repo> && cd spark-clip-agent
npm ci
cp .env.example .env && nano .env        # fill secrets
npm run init-db
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

nginx reverse proxy (TLS via certbot), proxying 443 → 127.0.0.1:3000, must expose:
`/slack/events`, `/slack/interactive`, `/slack/commands`, `/webhooks/higgsfield`, `/healthz`.

## Notes / next steps

- **Public image hosting** (above) is the only must-do wiring left before first render.
- **Auth on the webhook**: verify the `x-webhook-secret` header (stub is in `index.js`).
- **Optional React dashboard**: a read-only view over `store.list()`; serve its static build at `/dashboard`.
- The 15-clip layout is `TOTAL_VIDEOS` × `CLIPS_PER_VIDEO` in `.env` — change without touching code.
