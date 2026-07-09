// Gemini image generation for storyboard frames (Nano Banana family).
// Uses the REST generateContent endpoint so there's no extra SDK dependency.
import fetch from "node-fetch";
import { config } from "../config.js";
import { buildStoryboardPrompt } from "../prompts.js";

const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// productImages: [{ mimeType, base64 }]
async function generateOneFrame(promptText, productImages) {
  const parts = [{ text: promptText }];
  for (const img of productImages || []) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }

  const res = await fetch(`${ENDPOINT(config.gemini.imageModel)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.gemini.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      // image models return image parts in the candidate content
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const out = { text: "", images: [] };
  const cand = data.candidates?.[0]?.content?.parts || [];
  for (const p of cand) {
    if (p.text) out.text += p.text;
    const inline = p.inline_data || p.inlineData;
    if (inline?.data) out.images.push({ mimeType: inline.mime_type || inline.mimeType, base64: inline.data });
  }
  return out;
}

// Generates the full storyboard: a structured plan (text) + one frame per clip.
// Returns { plan, frames: [{ video, clip, mimeType, base64 }] }
export async function generateStoryboard(brief, feedback = null) {
  const masterPrompt = buildStoryboardPrompt(brief, feedback);

  // 1) Ask for the structured plan first (text).
  const planResp = await generateOneFrame(
    masterPrompt + "\n\nFirst, output ONLY the JSON plan (videos[].clips[]).",
    brief.productImages
  );

  let plan;
  try {
    const jsonMatch = planResp.text.match(/\{[\s\S]*\}/);
    plan = JSON.parse(jsonMatch ? jsonMatch[0] : planResp.text);
  } catch {
    plan = { raw: planResp.text }; // keep raw text if the model didn't return clean JSON
  }

  // 2) Generate one frame image per clip — parallelized in batches of 5.
  const videos = plan.videos || [];
  const allClipTasks = videos.flatMap((v) =>
    (v.clips || []).map((clip) => ({ v, clip }))
  );

  const CONCURRENCY = 5;
  const frames = [];
  for (let i = 0; i < allClipTasks.length; i += CONCURRENCY) {
    const batch = allClipTasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ v, clip }) => {
      const framePrompt =
        `Storyboard frame. Video: "${v.video_title}". Clip ${clip.clip_no}. ` +
        `${clip.shot_description}. Camera: ${clip.camera_move}. ` +
        `${brief.avatar_free !== false ? "No people/faces, product-only." : ""}`;
      const r = await generateOneFrame(framePrompt, brief.productImages);
      if (r.images[0]) {
        return {
          video: v.video_title,
          clip: clip.clip_no,
          mimeType: r.images[0].mimeType,
          base64: r.images[0].base64,
        };
      }
      return null;
    }));
    frames.push(...results.filter(Boolean));
  }

  return { plan, frames };
}
