// Google Drive delivery via a service account.
// Share the parent folder (GDRIVE_PARENT_FOLDER_ID) with the service-account email.
import { google } from "googleapis";
import fs from "node:fs";
import fetch from "node-fetch";
import { config } from "../config.js";

let _drive = null;
function driveClient() {
  if (!_drive) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.gdrive.serviceAccountJson,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    _drive = google.drive({ version: "v3", auth });
  }
  return _drive;
}

export async function createProjectFolder(name) {
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [config.gdrive.parentFolderId],
    },
    fields: "id, webViewLink",
  });
  // make link-shareable (anyone with the link can view)
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });
  return { id: res.data.id, url: res.data.webViewLink };
}

// Downloads a remote video URL and uploads it into the project folder.
export async function uploadVideoFromUrl(folderId, url, filename) {
  const drive = driveClient();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status}`);
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: "video/mp4", body: resp.body },
    fields: "id, webViewLink",
  });
  return { id: res.data.id, url: res.data.webViewLink };
}
