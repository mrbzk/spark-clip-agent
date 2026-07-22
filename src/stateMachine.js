// The orchestration brain. Pure-ish transitions: each function reads the
// project, does side effects (Gemini / Higgsfield / Notion / Drive / Slack),
// and persists the new state. Slack handlers call into these.
import { config, STATES } from "./config.js";
import { store } from "./store.js";
import { generatePlan, generateFramesForVideo } from "./integrations/gemini.js";
import { submitVideoRender } from "./integrations/higgsfield.js";
import { createProjectPage, updateProject, NOTION_STATUS } from "./integrations/notion.js";
import { createProjectFolder, uploadVideoFromUrl } from "./integrations/gdrive.js";
import { buildClipVideoPrompt } from "./prompts.js";
import * as slack from "./slack/say.js";

async function setStatus(project, status, notionExtra = {}) {
  const updated = store.update(project.thread_ts, { status });
  if (project.notion_page_id) {
    await updateProject(project.notion_page_id, { status: NOTION_STATUS[status], ...notionExtra }).catch(
      (e) => console.error("Notion update failed:", e.message)
    );
  }
  return updated;
}

// ── Step 1–2: brief complete → create Notion row, kick off storyboard ────────
export async function onBriefComplete(project, brief) {
  const threadUrl = slack.threadUrl(project.channel_id, project.thread_ts);
  const notionPageId = await createProjectPage(brief, threadUrl).catch((e) => {
    console.error("Notion create failed:", e.message);
    return null;
  });
  store.update(project.thread_ts, { brief, notion_page_id: notionPageId });
  const p = store.get(project.thread_ts);
  await generateStoryboardStep(p);
}

// ── Step 3–4: generate/regenerate storyboard for current video, post for review ─
export async function generateStoryboardStep(project, feedback = null) {
  if (!feedback && project.status === STATES.STORYBOARD_GENERATING) return;
  if (feedback && project.status === STATES.STORYBOARD_REVISING) return;

  await setStatus(project, feedback ? STATES.STORYBOARD_REVISING : STATES.STORYBOARD_GENERATING);

  const videoIndex = project.current_video || 1;

  try {
    let plan = project.storyboard?.plan;

    // First video: generate the full plan (text-only, fast) before generating frames
    if (!plan || videoIndex === 1) {
      await slack.post(project, feedback
        ? "✏️ Re-planning the storyboard with your feedback…"
        : `🎬 Planning ${config.app.totalVideos} videos — building Video 1's storyboard now…`);
      const result = await generatePlan(project.brief, feedback);
      plan = result.plan;
    } else {
      await slack.post(project, feedback
        ? `✏️ Revising Video ${videoIndex} storyboard with your feedback…`
        : `🎬 Building Video ${videoIndex} storyboard…`);
    }

    // Generate just this video's frames (3 clips)
    const { frames: newFrames } = await generateFramesForVideo(project.brief, plan, videoIndex);

    // Merge: replace any existing frames for this video, keep others
    const videoTitle = (plan.videos || [])[videoIndex - 1]?.video_title;
    const existingFrames = (project.storyboard?.frames || []).filter((f) => f.video !== videoTitle);
    const allFrames = [...existingFrames, ...newFrames];

    const prev = project.storyboard || {};
    store.update(project.thread_ts, {
      storyboard: { ...prev, plan, frames: allFrames, revision: (prev.revision || 0) + (feedback ? 1 : 0) },
      current_video: videoIndex,
    });

    const p = store.get(project.thread_ts);
    await slack.postStoryboard(p, videoIndex);
    await setStatus(p, STATES.STORYBOARD_REVIEW);
  } catch (e) {
    console.error(e);
    await setStatus(project, STATES.FAILED);
    await slack.post(project, `⚠️ Storyboard generation failed: ${e.message}`);
  }
}

// ── Step 5: storyboard for current video approved → render it ────────────────
export async function onStoryboardApproved(project) {
  if (project.status !== STATES.STORYBOARD_REVIEW) return; // idempotency guard
  const videoIndex = project.current_video || 1;
  await slack.post(project, `✅ Storyboard approved. Rendering Video ${videoIndex}…`);
  await renderVideo(store.get(project.thread_ts), videoIndex);
}

export async function renderVideo(project, videoIndex, feedback = null) {
  await setStatus(project, feedback ? STATES.VIDEO_REVISING : STATES.VIDEO_GENERATING);
  store.update(project.thread_ts, { current_video: videoIndex });

  const videos = project.storyboard?.plan?.videos || [];
  const v = videos[videoIndex - 1] || { video_title: `Video ${videoIndex}`, clips: [] };

  // Public image URLs for this video's clips (frames must be hosted; see slack.postStoryboard).
  const frameUrls = (project.storyboard.frames || [])
    .filter((f) => f.video === v.video_title)
    .map((f) => f.hostedUrl)
    .filter(Boolean);
  const productUrls = (project.brief.productImages || []).map((i) => i.hostedUrl).filter(Boolean);

  const prompt = v.clips
    .map((c) => buildClipVideoPrompt(project.brief, v, c, feedback))
    .join("\n---\n");

  try {
    const { request_id } = await submitVideoRender({
      prompt,
      imageUrls: [...frameUrls, ...productUrls],
      model: project.brief.model || config.higgsfield.defaultModel,
      generateAudio: project.brief.generate_audio || false,
    });

    const list = [...(project.videos || [])];
    const existing = list.find((x) => x.index === videoIndex);
    const entry = {
      index: videoIndex,
      title: v.video_title,
      request_id,
      status: "rendering",
      url: null,
      revision: existing ? (existing.revision || 0) + 1 : 0,
    };
    if (existing) Object.assign(existing, entry);
    else list.push(entry);
    store.update(project.thread_ts, { videos: list });

    await slack.post(project, `🎥 Video ${videoIndex} ("${v.video_title}") is rendering with ${(project.brief.model || config.higgsfield.defaultModel)}…`);
  } catch (e) {
    console.error(e);
    await setStatus(project, STATES.FAILED);
    await slack.post(project, `⚠️ Video ${videoIndex} render failed: ${e.message}`);
  }
}

// ── Called by the Higgsfield webhook / poller when a render finishes ─────────
export async function onRenderComplete(requestId, videoUrl, ok = true) {
  const project = store.findByHiggsfieldRequest(requestId);
  if (!project) return;
  const list = [...(project.videos || [])];
  const entry = list.find((v) => v.request_id === requestId);
  if (!entry) return;

  if (!ok) {
    entry.status = "failed";
    store.update(project.thread_ts, { videos: list });
    await setStatus(store.get(project.thread_ts), STATES.FAILED);
    await slack.post(project, `⚠️ Video ${entry.index} failed to render.`);
    return;
  }

  entry.status = "ready";
  entry.url = videoUrl;
  store.update(project.thread_ts, { videos: list });
  const p = store.get(project.thread_ts);
  await setStatus(p, STATES.VIDEO_REVIEW);
  await slack.postVideoForReview(p, entry); // posts link + Approve / Request changes
}

// ── Step 7: feedback on a video → confirm interpreted changes ────────────────
export async function onVideoFeedback(project, feedbackText) {
  if (project.status !== STATES.VIDEO_REVIEW) return;
  store.update(project.thread_ts, {
    storyboard: { ...project.storyboard, pendingFeedback: feedbackText },
  });
  await setStatus(store.get(project.thread_ts), STATES.VIDEO_FEEDBACK_CONFIRM);
  await slack.postFeedbackConfirm(store.get(project.thread_ts), feedbackText);
}

export async function onVideoFeedbackConfirmed(project, confirmed) {
  if (project.status !== STATES.VIDEO_FEEDBACK_CONFIRM) return;
  const feedback = project.storyboard?.pendingFeedback;
  if (!confirmed) {
    await setStatus(project, STATES.VIDEO_REVIEW);
    await slack.post(project, "No problem — tell me what to change instead.");
    return;
  }
  await slack.post(project, `🔁 Re-rendering Video ${project.current_video} with your changes…`);
  await renderVideo(store.get(project.thread_ts), project.current_video, feedback);
}

// ── Step 8: rendered video approved → ask to add another or deliver ──────────
export async function onVideoApproved(project) {
  if (project.status !== STATES.VIDEO_REVIEW) return;
  const approvedCount = project.current_video;

  if (project.notion_page_id) {
    await updateProject(project.notion_page_id, { videosApproved: approvedCount }).catch(() => {});
  }

  await setStatus(project, STATES.AWAITING_NEXT_CHOICE);
  await slack.postNextVideoChoice(store.get(project.thread_ts));
}

// ── Add another video: generate its frames and show storyboard ───────────────
export async function onAddNextVideo(project) {
  if (project.status !== STATES.AWAITING_NEXT_CHOICE) return;
  const next = project.current_video + 1;
  store.update(project.thread_ts, { current_video: next });
  await generateStoryboardStep(store.get(project.thread_ts));
}

// ── Deliver now: compile and send whatever's been approved ───────────────────
export async function onDeliverNow(project) {
  if (project.status !== STATES.AWAITING_NEXT_CHOICE) return;
  await compileAndDeliver(store.get(project.thread_ts));
}

// ── Step 9: all approved → upload to Drive, post final links ─────────────────
export async function compileAndDeliver(project) {
  await setStatus(project, STATES.COMPILING);
  await slack.post(project, "📦 All 5 approved. Uploading finals to Google Drive…");
  try {
    const folder = await createProjectFolder(`${project.brief.product} — Spark Clips`);
    store.update(project.thread_ts, { drive_folder_id: folder.id });

    const ready = (project.videos || []).filter((v) => v.status === "ready" && v.url);
    for (const v of ready) {
      await uploadVideoFromUrl(folder.id, v.url, `video-${v.index}-${slack.slug(v.title)}.mp4`);
    }

    const links = ready.map((v) => `• Video ${v.index}: ${v.url}`).join("\n");
    if (project.notion_page_id) {
      await updateProject(project.notion_page_id, {
        status: NOTION_STATUS.COMPLETE,
        videosApproved: config.app.totalVideos,
        driveFolder: folder.url,
        videoLinks: ready.map((v) => v.url).join(" | "),
      }).catch(() => {});
    }
    await setStatus(project, STATES.COMPLETE);
    await slack.post(project,
      `🎉 *Done!* All ${config.app.totalVideos} videos approved.\n\n${links}\n\n📁 Google Drive folder: ${folder.url}`);
  } catch (e) {
    console.error(e);
    await setStatus(project, STATES.FAILED);
    await slack.post(project, `⚠️ Delivery failed: ${e.message}`);
  }
}
