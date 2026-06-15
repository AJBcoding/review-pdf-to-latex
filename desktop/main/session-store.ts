// Persists the last-known session_id to disk so the next app launch can
// resume Claude's conversation context.
//
// File lives under Electron's userData dir (eg
// ~/Library/Application Support/agent-viewer/session.json on macOS).
// Single-session for now; multi-session lands at Project 3.

import { app } from "electron";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.js";

interface SessionFile {
  sessionId: string;
  savedAt: string;
}

function pathFor(): string {
  return join(app.getPath("userData"), "session.json");
}

export function loadSavedSessionId(): string | null {
  try {
    const p = pathFor();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as SessionFile;
    if (typeof data.sessionId === "string" && data.sessionId.length > 0) {
      return data.sessionId;
    }
    return null;
  } catch (err) {
    console.error("[session-store] failed to load session.json:", err);
    return null;
  }
}

// Async now that it routes through the shared atomic writer (tmp + rename),
// so a crash mid-write can't truncate session.json. Callers use it as a
// fire-and-forget `(sessionId) => void` callback; failures are swallowed and
// logged here, so the unawaited promise never rejects to the caller.
export async function saveSessionId(sessionId: string): Promise<void> {
  try {
    const data: SessionFile = {
      sessionId,
      savedAt: new Date().toISOString(),
    };
    await atomicWriteJson(pathFor(), data);
  } catch (err) {
    console.error("[session-store] failed to write session.json:", err);
  }
}

export function clearSavedSessionId(): void {
  try {
    const p = pathFor();
    if (existsSync(p)) unlinkSync(p);
  } catch (err) {
    console.error("[session-store] failed to remove session.json:", err);
  }
}
