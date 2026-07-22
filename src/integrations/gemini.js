import fetch from "node-fetch";
import { config } from "../config.js";
import { buildStoryboardPrompt } from "../prompts.js";

const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image ${url}: ${res.status}`);
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buffer = await res.arrayBuffer();
  return { mimeType, base64: Buffer.from(buffer).toString("base64") };
}

async function resolveImages(productImages) {
  return (await Promise.all(
    (productImages || []).map(async (img) => {
      if (img.mimeType && img.base64) return img;
      if (img.hostedUrl) return urlToBase64(img.hostedUrl).catch(() => null);
      return null;
    })
  )).filter(Boolean);
}

async function generateOneFrame(promptText, productImages) {
  const parts = [{ text: promptText }];
  for (const img of productImages || []) {
    if (img.mimeType && img.base64) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
    }
  }

  const res = await fetch(ENDPOINT(config.gemini.imageModel), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.gemini.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const out = { text: "", images: [] };
  for (const p of data.candidates?.[0]?.content?.parts || []) {
    if (p.text) out.text += p.text;
    const inline = p.inline_data || p.inlineData;
    if (inline?.data) out.images.push({ mimeType: inline.mime_type || inline.mimeType, base64: inline.data });
  }
  return out;
}

// Step 1: Generate the full storyboard plan (text-only, fast).
// Returns { plan: { videos: [{ video_title, hook, clips: [{ clip_no, shot_description, camera_move }] }] } }
export async function generatePlan(brief, feedback = null) {
  const prompt = buildStoryboardPrompt(brief, feedback) +
    "\n\nOutput ONLY valid JSON matching: { \"videos\": [{ \"video_title\", \"hook\", \"clips\": [{ \"clip_no\", \"shot_description\", \"camera_move\" }] }] }";

  const res = await fetch(ENDPOINT(config.gemini.textModel), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.gemini.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) throw new Error(`Gemini plan error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  let plan;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    plan = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    plan = { raw: text };
  }

  return { plan };
}

// Step 2: Generate 3 frames for one video. Call once per video, on demand.
// Returns { frames: [{ video, clip, mimeType, base64 }] }
export async function generateFramesForVideo(brief, plan, videoIndex) {
  const resolvedImages = await resolveImages(brief.productImages);
  const v = (plan.videos || [])[videoIndex - 1];
  if (!v) return { frames: [] };

  const frames = await Promise.all(
    (v.clips || []).map(async (clip) => {
      const prompt =
        `Storyboard frame. Video: "${v.video_title}". Clip ${clip.clip_no}. ` +
        `${clip.shot_description}. Camera: ${clip.camera_move}. ` +
        `${brief.avatar_free !== false ? "No people/faces, product-only." : ""}`;
      const r = await generateOneFrame(prompt, resolvedImages);
      return r.images[0]
        ? { video: v.video_title, clip: clip.clip_no, mimeType: r.images[0].mimeType, base64: r.images[0].base64 }
        : null;
    })
  );

  return { frames: frames.filter(Boolean) };
}
