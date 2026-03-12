import { access, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { CliError } from "../config/types.js";

const MAX_PROCESSED_IDS = 200;

export interface WatchState {
  lastChecked: string;           // ISO 8601 timestamp
  processedThreadIds: string[];  // rolling window of thread IDs already handled
  /**
   * Tracks in-flight review-request events: maps notification thread ID to the
   * integer ID of the last `review_requested` issue-event that was emitted for
   * this agent. While a thread ID is here, new polls check whether the latest
   * matching issue-event ID has advanced before re-emitting:
   *   - same event ID  → PR activity only (new commit/comment) → suppress
   *   - higher event ID → genuine re-request after review or ack → emit once
   *
   * Using a stable, monotonically increasing event ID means the cursor is tied
   * to the actual review-request action, not to the notification thread's
   * `updated_at` (which changes for all PR activity). This eliminates both
   * failure modes: thread-activity noise and dropped re-requests after ack.
   */
  activeReviewRequests?: Record<string, number>;
}

export interface LoadStateResult {
  state: WatchState;
  degraded: boolean;
  reason?: string;
}

async function assertNoSymlinkTraversal(filePath: string): Promise<void> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const root = parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);

  let currentPath = root;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new CliError(`State file path may not traverse symbolic links: ${currentPath}`, "GH_ERROR");
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue;
      throw err;
    }
  }
}

async function resolveStateFilePath(filePath: string): Promise<string> {
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  await assertNoSymlinkTraversal(resolvedPath);
  return resolvedPath;
}

async function ensureWritableParentDirectory(filePath: string): Promise<void> {
  const parentDir = dirname(filePath);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(parentDir);

  const parentStats = await lstat(parentDir);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new CliError(`State file parent path is not a directory: ${parentDir}`, "GH_ERROR");
  }

  try {
    await access(parentDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new CliError(`State file parent directory is not readable/writable: ${parentDir}${detail}`, "GH_ERROR");
  }
}

/** Load state from disk, or return a default initial state (since = 1 hour ago). */
export async function loadState(filePath: string): Promise<WatchState> {
  const result = await loadStateWithStatus(filePath);
  return result.state;
}

/** Load state with degradation signal for callers that need explicit warnings. */
export async function loadStateWithStatus(filePath: string): Promise<LoadStateResult> {
  const resolvedPath = await resolveStateFilePath(filePath);

  if (!existsSync(resolvedPath)) {
    return { state: defaultState(), degraded: false };
  }

  try {
    const raw = await readFile(resolvedPath, "utf-8");
    let parsed: Partial<WatchState>;

    try {
      parsed = JSON.parse(raw) as Partial<WatchState>;
    } catch {
      return {
        state: defaultState(),
        degraded: true,
        reason: "invalid JSON",
      };
    }

    if (typeof parsed.lastChecked !== "string" || !parsed.lastChecked) {
      return {
        state: defaultState(),
        degraded: true,
        reason: "missing required fields",
      };
    }

    if (!Array.isArray(parsed.processedThreadIds)) {
      return {
        state: defaultState(),
        degraded: true,
        reason: "missing required fields",
      };
    }

    const processedThreadIds = parsed.processedThreadIds.filter((id): id is string => typeof id === "string");

    // activeReviewRequests is optional and backward-compatible:
    //   current format: Record<string, number> (threadId → lastEmittedReviewRequestEventId)
    //   legacy format 1: string[] (notification IDs only — migrate to Record with sentinel 0)
    //   legacy format 2: Record<string, string> (notificationId → updatedAtAtEmission) — migrate to Record with sentinel 0
    // Use `unknown` to handle all formats safely.
    const rawActiveReviews: unknown = parsed.activeReviewRequests;
    let activeReviewRequests: Record<string, number> | undefined;
    if (Array.isArray(rawActiveReviews)) {
      // Legacy format 1: string[] — migrate to Record with sentinel value 0
      // Sentinel 0 means "we emitted but don't know the event ID" — will re-emit
      // on first new poll when the actual event ID is fetched and stored.
      const ids = (rawActiveReviews as unknown[]).filter(
        (id): id is string => typeof id === "string",
      );
      if (ids.length > 0) {
        activeReviewRequests = Object.fromEntries(ids.map((id) => [id, 0]));
      }
    } else if (rawActiveReviews !== null && typeof rawActiveReviews === "object") {
      // Could be: current format Record<string, number> or legacy Record<string, string>
      const entries = Object.entries(rawActiveReviews as Record<string, unknown>)
        .filter(([k]) => typeof k === "string")
        .map(([k, v]): [string, number] => [k, typeof v === "number" ? v : 0]);
      if (entries.length > 0) {
        activeReviewRequests = Object.fromEntries(entries);
      }
    }

    return {
      state: {
        lastChecked: parsed.lastChecked,
        processedThreadIds,
        ...(activeReviewRequests !== undefined
          ? { activeReviewRequests }
          : {}),
      },
      degraded: false,
    };
  } catch {
    return {
      state: defaultState(),
      degraded: true,
      reason: "read error",
    };
  }
}

/** Atomically save state to disk (write to temp, then rename). */
export async function saveState(filePath: string, state: WatchState): Promise<void> {
  const resolvedPath = await resolveStateFilePath(filePath);
  await ensureWritableParentDirectory(resolvedPath);

  const dir = dirname(resolvedPath);
  const tmpPath = join(dir, `.${Date.now()}.tmp`);

  const trimmed: WatchState = {
    lastChecked: state.lastChecked,
    processedThreadIds: state.processedThreadIds.slice(-MAX_PROCESSED_IDS),
    ...(state.activeReviewRequests && Object.keys(state.activeReviewRequests).length > 0
      ? { activeReviewRequests: state.activeReviewRequests }
      : {}),
  };

  try {
    await writeFile(tmpPath, JSON.stringify(trimmed, null, 2) + "\n", "utf-8");
    await rename(tmpPath, resolvedPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best effort cleanup of partial temp files.
    }
    throw err;
  }
}

/** Mark a thread ID as processed, maintaining the rolling window. */
export function addProcessedId(state: WatchState, threadId: string): WatchState {
  const ids = state.processedThreadIds.includes(threadId)
    ? state.processedThreadIds
    : [...state.processedThreadIds, threadId].slice(-MAX_PROCESSED_IDS);

  return { ...state, processedThreadIds: ids };
}

/**
 * Record that a review-request event has been emitted for the given thread,
 * keyed by the integer ID of the `review_requested` issue event that triggered
 * it. Subsequent polls compare the current latest event ID to this stored value
 * to distinguish genuine re-requests (higher ID) from PR-activity noise (same ID).
 *
 * Pass `eventId = 0` when the event ID is unknown (migration from older state format).
 */
export function addActiveReviewRequest(
  state: WatchState,
  threadId: string,
  eventId: number,
): WatchState {
  const existing = state.activeReviewRequests ?? {};
  return { ...state, activeReviewRequests: { ...existing, [threadId]: eventId } };
}

/**
 * Remove a thread from the active review-requests map once the request is
 * fulfilled or withdrawn.
 */
export function removeActiveReviewRequest(state: WatchState, threadId: string): WatchState {
  const existing = state.activeReviewRequests ?? {};
  const { [threadId]: _removed, ...remaining } = existing;
  return {
    ...state,
    activeReviewRequests: Object.keys(remaining).length > 0 ? remaining : undefined,
  };
}

function defaultState(): WatchState {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return {
    lastChecked: oneHourAgo.toISOString(),
    processedThreadIds: [],
  };
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Build a map of threadId → latest updatedAt from processedThreadIds.
 * Keys in processedThreadIds have the composite format `threadId:updatedAt`.
 * Used to skip already-processed notifications in both watch and notifications pull.
 */
export function buildLatestProcessedByThread(processedKeys: string[]): Map<string, string> {
  const byThread = new Map<string, string>();

  for (const key of processedKeys) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === key.length - 1) continue;

    const threadId = key.slice(0, separatorIndex);
    const updatedAt = key.slice(separatorIndex + 1);
    if (parseIsoMillis(updatedAt) === null) continue;

    const existing = byThread.get(threadId);
    if (!existing || updatedAt > existing) {
      byThread.set(threadId, updatedAt);
    }
  }

  return byThread;
}

/**
 * Atomically consume the ack journal file and merge its keys into state.
 *
 * Pattern: rename journal → read → merge → delete temp file.
 * Rename is atomic on POSIX, so concurrent appends by `appendAck` won't
 * lose data — they'll create a new journal file after the rename.
 */
export async function mergeAckJournal(stateFilePath: string, state: WatchState): Promise<WatchState> {
  const resolvedPath = await resolveStateFilePath(stateFilePath);
  const journalPath = `${resolvedPath}.acks`;
  const processingPath = `${resolvedPath}.acks.processing`;

  try {
    await rename(journalPath, processingPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      // No journal file — nothing to merge
      return state;
    }
    throw err;
  }

  try {
    const raw = await readFile(processingPath, "utf-8");
    const keys = raw.split("\n").filter((line) => line.length > 0);

    let merged = state;
    for (const key of keys) {
      merged = addProcessedId(merged, key);
    }

    return merged;
  } finally {
    // Always clean up the processing file.
    try {
      await unlink(processingPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") throw err;
    }
  }
}

/**
 * Append a key to the ack journal file.
 * Uses O_APPEND for safe concurrent writes from multiple ack invocations.
 */
export async function appendAck(stateFilePath: string, key: string): Promise<void> {
  const resolvedPath = await resolveStateFilePath(stateFilePath);
  await ensureWritableParentDirectory(resolvedPath);

  const journalPath = `${resolvedPath}.acks`;
  const fh = await open(journalPath, "a");
  try {
    await fh.write(`${key}\n`);
  } finally {
    await fh.close();
  }
}
