// Slack Bolt wiring: slash command → intake modal → thread; buttons + thread
// replies drive the state machine. HTTP mode (Express receiver) so the same
// server can host the Higgsfield webhook.
import bolt from "@slack/bolt";
import { config, STATES } from "../config.js";
import { store } from "../store.js";
import * as say from "./say.js";
import * as fsm from "../stateMachine.js";

const { App, ExpressReceiver } = bolt;

export const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  endpoints: { events: "/slack/events", commands: "/slack/commands", interactive: "/slack/interactive" },
});

export const app = new App({ token: config.slack.botToken, receiver });
say.setClient(app.client);

// ── /spark-clip : open the intake modal ──────────────────────────────────────
app.command("/spark-clip", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "intake_modal",
      private_metadata: JSON.stringify({ channel_id: body.channel_id }),
      title: { type: "plain_text", text: "New Spark Clip project" },
      submit: { type: "plain_text", text: "Start" },
      blocks: [
        input("product", "Product name", false),
        input("website", "Website URL", false),
        input("storyline", "Rough storyline / direction", true),
        input("images", "Product image URLs (comma-separated)", true),
        {
          type: "input", block_id: "model", label: { type: "plain_text", text: "Video model" },
          element: {
            type: "static_select", action_id: "v",
            initial_option: opt("Seedance 2 (default)", "seedance-2"),
            options: [opt("Seedance 2 (default)", "seedance-2"), opt("Other (set in config)", "other")],
          },
        },
        {
          type: "input", block_id: "avatar", label: { type: "plain_text", text: "Avatar-free?" },
          element: {
            type: "static_select", action_id: "v",
            initial_option: opt("Yes — product only", "yes"),
            options: [opt("Yes — product only", "yes"), opt("No — people allowed", "no")],
          },
        },
      ],
    },
  });
});

app.view("intake_modal", async ({ ack, view, body, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata || "{}");
  const v = view.state.values;
  const val = (b) => v[b]?.v?.value || v[b]?.v?.selected_option?.value || "";

  // Open the project thread with a root message.
  const root = await client.chat.postMessage({
    channel: meta.channel_id,
    text: `🆕 Spark Clip project: *${val("product") || "Untitled"}* started by <@${body.user.id}>`,
  });

  const project = store.create({ thread_ts: root.ts, channel_id: meta.channel_id });
  const brief = {
    product: val("product"),
    website: val("website"),
    storyline: val("storyline"),
    model: val("model") === "other" ? config.higgsfield.defaultModel : "seedance-2",
    avatar_free: val("avatar") !== "no",
    productImages: (val("images") || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((u) => ({ hostedUrl: u })), // URLs already public; base64 path handled elsewhere
  };
  await fsm.onBriefComplete(project, brief);
});

// ── Button interactions ──────────────────────────────────────────────────────
app.action("storyboard_approve", withProject(async (p) => fsm.onStoryboardApproved(p)));
app.action("storyboard_changes", ackOnly("Reply in the thread with the changes you'd like."));
app.action("video_approve", withProject(async (p) => fsm.onVideoApproved(p)));
app.action("video_changes", ackOnly("Reply in the thread with the changes you'd like."));
app.action("video_feedback_confirm", withProject(async (p) => fsm.onVideoFeedbackConfirmed(p, true)));
app.action("video_feedback_reject", withProject(async (p) => fsm.onVideoFeedbackConfirmed(p, false)));
app.action("render_batch", withProject(async (p) => fsm.setRenderMode(p, "batch")));
app.action("render_one_by_one", withProject(async (p) => fsm.setRenderMode(p, "one_by_one")));

// ── Free-text thread replies = feedback for the current review item ───────────
app.event("message", async ({ event }) => {
  if (event.subtype || event.bot_id || !event.thread_ts) return;
  const project = store.get(event.thread_ts);
  if (!project) return;
  const text = (event.text || "").trim();
  const approve = /^(approve|approved|looks good|lgtm|👍|✅|ship it)$/i.test(text);

  if (project.status === STATES.STORYBOARD_REVIEW) {
    if (approve) return fsm.onStoryboardApproved(project);
    return fsm.generateStoryboardStep(project, text);
  }
  if (project.status === STATES.VIDEO_REVIEW) {
    if (approve) return fsm.onVideoApproved(project);
    return fsm.onVideoFeedback(project, text);
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
function input(id, label, multiline) {
  return {
    type: "input", block_id: id, optional: id !== "product",
    label: { type: "plain_text", text: label },
    element: { type: "plain_text_input", action_id: "v", multiline },
  };
}
function opt(text, value) { return { text: { type: "plain_text", text }, value }; }

function withProject(fn) {
  return async ({ ack, body, respond }) => {
    await ack();
    const threadTs = body.message?.thread_ts || body.message?.ts;
    const project = store.get(threadTs);
    if (!project) return respond({ text: "Couldn't find that project.", replace_original: false });
    try { await fn(project); } catch (e) { console.error(e); }
  };
}
function ackOnly(msg) {
  return async ({ ack, respond }) => { await ack(); await respond({ text: msg, replace_original: false }); };
}
