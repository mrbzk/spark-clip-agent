import fetch from "node-fetch";
import { config } from "../config.js";

const BASE_URL = "https://platform.higgsfield.ai";

function authHeader() {
  return `Key ${config.higgsfield.credentials}`;
}

// Submit a render job. Uses the first imageUrl as the primary frame, remaining as
// image_references (up to 9). Webhook fires back to /webhooks/higgsfield on completion.
export async function submitVideoRender({ prompt, imageUrls, model, generateAudio = false }) {
  const modelSlug = model || config.higgsfield.defaultModel;
  const webhookUrl = `${config.app.publicBaseUrl}/webhooks/higgsfield`;
  const endpoint = `${BASE_URL}/${modelSlug}?hf_webhook=${encodeURIComponent(webhookUrl)}`;

  const [primaryImage, ...rest] = imageUrls.filter(Boolean);
  if (!primaryImage) throw new Error("No image URL provided for Higgsfield render.");

  const body = {
    image_url: primaryImage,
    prompt,
    duration: 5,
    aspect_ratio: "9:16",
    resolution: "720p",
    mode: "std",
    generate_audio: generateAudio,
    ...(rest.length > 0 && {
      image_references: rest.slice(0, 9).map((u) => ({ type: "image_url", image_url: u })),
    }),
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Higgsfield submit error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { request_id: data.request_id, status: data.status || "queued" };
}

// Fallback poller used by the background reconciler if the webhook is missed.
export async function pollRequest(requestId) {
  const res = await fetch(`${BASE_URL}/requests/${requestId}/status`, {
    headers: {
      Accept: "application/json",
      Authorization: authHeader(),
    },
  });

  if (!res.ok) throw new Error(`Higgsfield poll error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const failed = data.status === "failed" || data.status === "nsfw";
  return {
    status: data.status === "completed" ? "completed" : failed ? "failed" : "pending",
    url: data.video?.url || null,
  };
}
