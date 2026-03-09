import { NextRequest, NextResponse } from "next/server";
import { parseContentLength } from "@/server/request-utils";
import { extractTaskId } from "@/server/task-route-utils";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  appendTaskArtifacts,
  getTask,
  verifyTaskClaimToken,
  TASK_ID_PATTERN,
  MAX_ARTIFACTS_PER_TASK,
  type TaskArtifact,
} from "@/server/task-store";

const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_ARTIFACT_TITLE_CHARS = 200;
const textEncoder = new TextEncoder();

const VALID_ARTIFACT_TYPES = new Set<TaskArtifact["type"]>([
  "pull_request",
  "issue",
  "issue_comment",
  "commit",
]);

function isAllowedArtifactUrl(url: string, taskRepos: string[]): boolean {
  const base = "https://github.com/";
  if (!url.startsWith(base)) return false;
  const afterBase = url.slice(base.length);
  return taskRepos.some(
    (repo) => afterBase === repo || afterBase.startsWith(repo + "/"),
  );
}

// Returns a parsed artifact array on success, or an error string on failure.
function parseArtifacts(raw: unknown, taskRepos: string[]): TaskArtifact[] | string {
  if (!Array.isArray(raw)) return "artifacts must be an array";
  if (raw.length === 0) return "artifacts must not be empty";
  if (raw.length > MAX_ARTIFACTS_PER_TASK) {
    return `artifacts must contain at most ${MAX_ARTIFACTS_PER_TASK} entries per request`;
  }

  const artifacts: TaskArtifact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "each artifact must be an object";
    }

    const obj = item as Record<string, unknown>;

    if (!VALID_ARTIFACT_TYPES.has(obj.type as TaskArtifact["type"])) {
      return `artifact type must be one of: ${[...VALID_ARTIFACT_TYPES].join(", ")}`;
    }

    if (typeof obj.url !== "string" || !obj.url.trim()) {
      return "each artifact must have a url string";
    }

    if (!isAllowedArtifactUrl(obj.url.trim(), taskRepos)) {
      return "artifact url must be a GitHub URL scoped to one of the task repos";
    }

    if (
      obj.number !== undefined
      && (typeof obj.number !== "number" || !Number.isInteger(obj.number))
    ) {
      return "artifact number must be an integer";
    }

    if (obj.title !== undefined && typeof obj.title !== "string") {
      return "artifact title must be a string";
    }

    const artifact: TaskArtifact = {
      type: obj.type as TaskArtifact["type"],
      url: obj.url.trim(),
    };
    if (typeof obj.number === "number") artifact.number = obj.number;
    if (typeof obj.title === "string") {
      artifact.title = obj.title.slice(0, MAX_ARTIFACT_TITLE_CHARS);
    }
    artifacts.push(artifact);
  }

  return artifacts;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateTaskExecutorRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 32KB)", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 32KB)", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, "Body must be a JSON object", 400);
  }

  const existingTask = await getTask(auth.installationId, taskId, auth.redis);
  if (!existingTask) {
    return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
  }

  const claimToken = request.headers.get("x-task-claim-token")?.trim() ?? "";
  if (!claimToken) {
    return taskError(TASK_ERROR.FORBIDDEN, "Missing task claim token", 403);
  }

  const validClaimToken = await verifyTaskClaimToken(
    auth.installationId,
    taskId,
    claimToken,
    auth.redis,
  );
  if (!validClaimToken) {
    return taskError(TASK_ERROR.FORBIDDEN, "Invalid or expired task claim token", 403);
  }

  const obj = body as Record<string, unknown>;
  const parsedArtifacts = parseArtifacts(obj.artifacts, existingTask.repos);
  if (typeof parsedArtifacts === "string") {
    return taskError(TASK_ERROR.VALIDATION_FAILED, parsedArtifacts, 400);
  }

  const result = await appendTaskArtifacts(
    auth.installationId,
    taskId,
    parsedArtifacts,
    auth.redis,
  );

  if (!result.ok) {
    if (result.reason === "not_found") {
      return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
    }
    if (result.reason === "limit_exceeded") {
      return taskError(
        TASK_ERROR.VALIDATION_FAILED,
        `Artifact limit reached (max ${MAX_ARTIFACTS_PER_TASK} per task)`,
        422,
      );
    }
    return taskError(
      TASK_ERROR.LOCK_TIMEOUT,
      "Task state is temporarily busy, retry shortly",
      429,
    );
  }

  return NextResponse.json({ artifacts: result.artifacts });
}
