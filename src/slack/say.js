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

// Posts storyboard frames for one video at a time.
// Saves new frames (those with base64) to disk, uploads them bundled, then posts the brief.
export async function postStoryboard(project, videoIndex = 1) {
  const plan = project.storyboard?.plan;
  const videos = plan?.videos || [];
  const v = videos[videoIndex - 1];
  if (!v) return;

  const allFrames = project.storyboard?.frames || [];

  // Save only the new frames for this video (they still have base64)
  const newFrames = allFrames.filter((f) => f.video === v.video_title && f.base64);
  const savedFrames = [];
  const fileUploads = [];

  for (const f of newFrames) {
    const ext = (f.mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
    const filename = `${crypto.randomUUID()}.${ext}`;
    const filepath = path.join(framesDir, filename);
    fs.writeFileSync(filepath, Buffer.from(f.base64, "base64"));
    const hostedUrl = `${config.app.publicBaseUrl}/frames/${filename}`;

    fileUploads.push({
      file: Buffer.from(f.base64, "base64"),
      filename: `${slug(f.video)}-clip${f.clip}.${ext}`,
      title: `${f.video} — Clip ${f.clip}`,
    });

    savedFrames.push({ video: f.video, clip: f.clip, mimeType: f.mimeType, hostedUrl });
  }

  // Replace the base64 frames in the store with their hostedUrl versions
  if (savedFrames.length > 0) {
    const otherFrames = allFrames.filter((f) => f.video !== v.video_title || !f.base64);
    store.update(project.thread_ts, {
      storyboard: { ...project.storyboard, frames: [...otherFrames, ...savedFrames] },
    });
  }

  // Upload all frames for this video in one bundled message
  if (fileUploads.length > 0) {
    await client.files.uploadV2({
      channel_id: project.channel_id,
      thread_ts: project.thread_ts,
      file_uploads: fileUploads,
    });
  }

  // Brief for this video
  const brief = project.brief || {};
  const briefBlock = [
    `*🎬 Video ${videoIndex} of ${videos.length}: ${v.video_title}*`,
    `Hook: _${v.hook || "n/a"}_`,
    ...(v.clips || []).map((c) =>
      `  • Clip ${c.clip_no}: ${c.shot_description} _(${c.camera_move || "static"})_`
    ),
    ``,
    [
      brief.product  && `*Product:* ${brief.product}`,
      brief.platform && `*Platform:* ${brief.platform}`,
      brief.vibe     && `*Vibe:* ${brief.vibe}`,
    ].filter(Boolean).join("  |  "),
  ].filter(Boolean).join("\n");

  await post(project, briefBlock, [
    { type: "section", text: { type: "mrkdwn", text: briefBlock.slice(0, 3000) } },
    ...reviewButtons("storyboard"),
  ]);
}

export async function postNextVideoChoice(project) {
  const approvedCount = project.current_video;
  const next = approvedCount + 1;
  await post(project,
    `✅ Video ${approvedCount} approved. Add Video ${next}, or wrap up and deliver what you have?`,
    [
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: `➕ Add Video ${next}` }, action_id: "add_next_video" },
          { type: "button", text: { type: "plain_text", text: "✅ Deliver now" }, action_id: "deliver_now" },
        ],
      },
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

