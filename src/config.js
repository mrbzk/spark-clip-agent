import "dotenv/config";

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    channel: process.env.SPARK_CLIP_CHANNEL,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    textModel: process.env.GEMINI_TEXT_MODEL || "gemini-flash-latest",
    imageModel: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
  },
  higgsfield: {
    credentials: process.env.HIGGSFIELD_CREDENTIALS,
    endpoint: process.env.HIGGSFIELD_ENDPOINT || "/higgsfield-ai/dop/standard",
    defaultModel: process.env.HIGGSFIELD_DEFAULT_MODEL || "higgsfield-ai/dop/standard",
    webhookSecret: process.env.HIGGSFIELD_WEBHOOK_SECRET,
  },
  notion: {
    token: process.env.NOTION_TOKEN,
    databaseId: process.env.NOTION_DATABASE_ID,
  },
  gdrive: {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    parentFolderId: process.env.GDRIVE_PARENT_FOLDER_ID,
  },
  app: {
    port: parseInt(process.env.PORT || "3001", 10),
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    clipsPerVideo: parseInt(process.env.CLIPS_PER_VIDEO || "3", 10),
    totalVideos: parseInt(process.env.TOTAL_VIDEOS || "5", 10),
    dbPath: process.env.DB_PATH || "./data/spark-clip.db",
  },
};

export const STATES = {
  INTAKE: "INTAKE",
  STORYBOARD_GENERATING: "STORYBOARD_GENERATING",
  STORYBOARD_REVIEW: "STORYBOARD_REVIEW",
  STORYBOARD_REVISING: "STORYBOARD_REVISING",
  VIDEO_GENERATING: "VIDEO_GENERATING",
  VIDEO_REVIEW: "VIDEO_REVIEW",
  VIDEO_FEEDBACK_CONFIRM: "VIDEO_FEEDBACK_CONFIRM",
  VIDEO_REVISING: "VIDEO_REVISING",
  AWAITING_NEXT_CHOICE: "AWAITING_NEXT_CHOICE",
  COMPILING: "COMPILING",
  COMPLETE: "COMPLETE",
  FAILED: "FAILED",
};
