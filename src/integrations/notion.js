// Notion Project Tracker logging.
// Database "Spark Clip Projects" needs these properties (create once, then reuse ids):
//   Name (title), Status (select), Product (rich_text), Website (url),
//   Model (rich_text), Videos Approved (number), Storyboard (url),
//   Video Links (rich_text), Drive Folder (url), Slack Thread (url), Created (date)
import { Client } from "@notionhq/client";
import { config } from "../config.js";

const notion = new Client({ auth: config.notion.token });

export async function createProjectPage(brief, slackThreadUrl) {
  const page = await notion.pages.create({
    parent: { database_id: config.notion.databaseId },
    properties: {
      Name: { title: [{ text: { content: brief.product || "Untitled Spark Clip project" } }] },
      Status: { select: { name: "Intake" } },
      Product: { rich_text: [{ text: { content: brief.product || "" } }] },
      Website: brief.website ? { url: brief.website } : { url: null },
      Model: { rich_text: [{ text: { content: brief.model || config.higgsfield.defaultModel } }] },
      "Videos Approved": { number: 0 },
      "Slack Thread": slackThreadUrl ? { url: slackThreadUrl } : { url: null },
      Created: { date: { start: new Date().toISOString() } },
    },
  });
  return page.id;
}

export async function updateProject(pageId, { status, videosApproved, storyboardUrl, videoLinks, driveFolder }) {
  const properties = {};
  if (status) properties.Status = { select: { name: status } };
  if (typeof videosApproved === "number") properties["Videos Approved"] = { number: videosApproved };
  if (storyboardUrl) properties.Storyboard = { url: storyboardUrl };
  if (driveFolder) properties["Drive Folder"] = { url: driveFolder };
  if (videoLinks) properties["Video Links"] = { rich_text: [{ text: { content: videoLinks } }] };
  await notion.pages.update({ page_id: pageId, properties });
}

// Human-readable status labels for the Notion Status select.
export const NOTION_STATUS = {
  INTAKE: "Intake",
  STORYBOARD_GENERATING: "Storyboard: generating",
  STORYBOARD_REVIEW: "Storyboard: in review",
  STORYBOARD_REVISING: "Storyboard: revising",
  VIDEO_GENERATING: "Video: rendering",
  VIDEO_REVIEW: "Video: in review",
  VIDEO_FEEDBACK_CONFIRM: "Video: confirming changes",
  VIDEO_REVISING: "Video: re-rendering",
  COMPILING: "Compiling deliverables",
  COMPLETE: "Complete",
  FAILED: "Failed",
};
