// Higgsfield video generation (Seedance 2 by default) via the official v2 SDK.
// We submit with a webhook so the VPS isn't holding a long HTTP call; the
// webhook route (/webhooks/higgsfield) advances the state machine on completion.
import { higgsfield, config as hfConfig } from "@higgsfield/client/v2";
import { config } from "../config.js";

hfConfig({ credentials: config.higgsfield.credentials });

// Submit a render job for one video (assembled from its approved clip frames + product images).
// imageUrls: array of public image URLs (storyboard frames + product photos).
// Returns { request_id, status }.
export async function submitVideoRender({ prompt, imageUrls, model }) {
  const jobSet = await higgsfield.subscribe(config.higgsfield.endpoint, {
    input: {
      model: model || config.higgsfield.defaultModel, // "seedance-2" default
      prompt,
      input_images: imageUrls.map((u) => ({ type: "image_url", image_url: u })),
    },
    withPolling: false, // rely on webhook; fallback poller reconciles
    webhook: {
      url: `${config.app.publicBaseUrl}/webhooks/higgsfield`,
      secret: config.higgsfield.webhookSecret,
    },
  });

  return { request_id: jobSet.id || jobSet.request_id, status: jobSet.status || "queued" };
}

// Fallback: poll a single request's status (used by the background reconciler).
export async function pollRequest(requestId) {
  const jobSet = await higgsfield.subscribe(config.higgsfield.endpoint, {
    requestId,
    withPolling: true,
  });
  const job = jobSet.jobs?.[0];
  return {
    status: jobSet.isCompleted ? "completed" : jobSet.isFailed ? "failed" : jobSet.status,
    url: job?.results?.raw?.url || null,
  };
}
