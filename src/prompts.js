import { config } from "./config.js";

// Builds the storyboard prompt for Gemini, for a single video at a time. Product-led, avatar-free.
export function buildStoryboardPrompt(brief, videoIndex, feedback = null) {
  const { totalVideos, clipsPerVideo } = config.app;
  const avatarRule = brief.avatar_free !== false
    ? "STRICT: avatar-free. No human faces, no people, no avatars. Product is the hero in every frame."
    : "People may appear but the product must remain the focal point.";

  const base = `You are a senior creative director building an advertising storyboard.

PRODUCT: ${brief.product || "(unnamed product)"}
WEBSITE: ${brief.website || "n/a"}
STORYLINE / DIRECTION: ${brief.storyline || "(none provided)"}
${avatarRule}

This product is getting ${totalVideos} short ad videos in total (${totalVideos * clipsPerVideo} Spark Clips
overall). Design ONLY Video ${videoIndex} of ${totalVideos} right now, with ${clipsPerVideo} clip-shots.
Use the supplied product photos as the visual basis.

Return:
  - video_title
  - hook (the scroll-stopping first-second idea)
  - for each of the ${clipsPerVideo} clips: { clip_no, shot_description, camera_move, on_screen_text, product_focus }

Then generate one storyboard frame image per clip that matches shot_description, styled as a clean
product ad frame. Keep the product true to the supplied photos (color, shape, branding).`;

  if (feedback) {
    return `${base}

REVISION REQUESTED. Apply this feedback precisely and regenerate the affected parts:
"${feedback}"`;
  }
  return base;
}

// Per-clip prompt handed to Higgsfield for video generation.
export function buildClipVideoPrompt(brief, video, clip, feedback = null) {
  const avatarRule = brief.avatar_free !== false
    ? "Avatar-free: no people or faces. Product-only cinematography."
    : "Product-focused cinematography.";
  let p = `Product ad clip for "${brief.product}". ${avatarRule}
Shot: ${clip.shot_description}. Camera: ${clip.camera_move}. On-screen text: ${clip.on_screen_text || "none"}.
Match the approved storyboard frame and the product's real appearance.`;
  if (feedback) p += `\nApply this change: "${feedback}".`;
  return p;
}
