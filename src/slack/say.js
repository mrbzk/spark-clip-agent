// All Slack posting helpers live here so the state machine stays clean.
// `app` (the Bolt client) is injected once at startup via setClient().
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { store } from "../store.js";

let client = null;
export function setClient(c) { client = c; }

// Frames saved here are served publicly at /frames/:filename (see index.js)
const framesDir = path.resolve("./data/frames");
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

export function slug(s = "") {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

export function threadUrl(channelId, threadTs) {
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${threadTs}`;
}

export async function post(project, text, blocks = null) {
  return client.chat.postMessage({
    channel: project.channel_id,
    thread_ts: project.thread_ts,
    text,
    ...(blocks ? { blocks } : {}),
  });
}

function reviewButtons(action) {
  return [
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "✅ Approve" }, action_id: `${action}_approve` },
        { type: "button", text: { type: "plain_text", text: "✏️ Request changes" }, action_id: `${action}_changes` },
      ],
    },
  ];
}

// Saves each frame to disk (served at /frames/:filename for Higgsfield),
// uploads to Slack thread for display, then persists hostedUrls to the store
// so renderVideo can read them after a server restart.
export async function postStoryboard(project) {
  const frames = project.storyboard?.frames || [];
  const updatedFrames = [];

  for (const f of frames) {
    // 1. Save to disk and derive a permanent public URL
    const ext = (f.mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
    const filename = `${crypto.randomUUID()}.${ext}`;
    const filepath = path.join(framesDir, filename);
    fs.writeFileSync(filepath, Buffer.from(f.base64, "base64"));
    const hostedUrl = `${config.app.publicBaseUrl}/frames/${filename}`;

    // 2. Upload to Slack thread for display
    await client.files.uploadV2({
      channel_id: project.channel_id,
      thread_ts: project.thread_ts,
      filename: `${slug(f.video)}-clip${f.clip}.${ext}`,
      file: Buffer.from(f.base64, "base64"),
      title: `${f.video} — Clip ${f.clip}`,
    });

    // Drop base64 from storage — the file on disk is the source of truth
    updatedFrames.push({ video: f.video, clip: f.clip, mimeType: f.mimeType, hostedUrl });
  }

  // Persist hostedUrls (without base64) so renderVideo can read them after a restart
  store.update(project.thread_ts, {
    storyboard: { ...project.storyboard, frames: updatedFrames },
  });

  const plan = project.storyboard?.plan;
  const summary = (plan?.videos || [])
    .map((v, i) => `*Video ${i + 1}: ${v.video_title}* — hook: ${v.hook || "n/a"}`)
    .join("\n");
  await post(project,
    `🎬 Storyboard ready (${frames.length} frames).\n${summary}\n\nApprove to start rendering, or request changes.`,
    [
      { type: "section", text: { type: "mrkdwn", text: `🎬 *Storyboard ready* — ${frames.length} frames.\n${summary}` } },
      ...reviewButtons("storyboard"),
    ]);
}

export async function postVideoForReview(project, entry) {
  await post(project,
    `🎥 Video ${entry.index} ("${entry.title}") is ready: ${entry.url}`,
    [
      { type: "section", text: { type: "mrkdwn", text: `🎥 *Video ${entry.index}: ${entry.title}* is ready.\n<${entry.url}|▶️ Preview>` } },
      ...reviewButtons("video"),
    ]);
}

export async function postFeedbackConfirm(project, feedbackText) {
  await post(project,
    `Here's what I'll change on Video ${project.current_video}: "${feedbackText}". Confirm to re-render?`,
    [
      { type: "section", text: { type: "mrkdwn", text: `*Proposed changes to Video ${project.current_video}:*\n> ${feedbackText}` } },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "🔁 Confirm & re-render" }, action_id: "video_feedback_confirm" },
          { type: "button", text: { type: "plain_text", text: "Not quite" }, action_id: "video_feedback_reject" },
        ],
      },
    ]);
}

export async function postBatchChoice(project) {
  const remaining = config.app.totalVideos - project.current_video;
  await post(project,
    `Video ${project.current_video} approved. Render all remaining ${remaining} now, or continue one-by-one?`,
    [
      { type: "section", text: { type: "mrkdwn", text: `✅ *Video ${project.current_video} approved.* How should I handle the remaining ${remaining}?` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: `⚡ Render all remaining ${remaining}` }, action_id: "render_batch" },
          { type: "button", style: "primary", text: { type: "plain_text", text: "➡️ One-by-one" }, action_id: "render_one_by_one" },
        ],
      },
    ]);
}
