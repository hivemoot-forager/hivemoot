import { NextRequest, NextResponse } from "next/server";
import { parseContentLength } from "@/server/request-utils";
import { extractTaskId } from "@/server/task-route-utils";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  appendTaskArtifacts,
  getTask,
  TASK_ID_PATTERN,
  verifyTaskClaimToken,
  type TaskArtifact,
} from "@/server/task-store";

const MAX_PAYLOAD_BYTES = 16 * 1024;
const textEncoder = new TextEncoder();

const VALID_ARTIFACT_TYPES = new Set<string>([
  "pull_request",
  "issue",
  "issue_comment",
  "commit",
]);

function validateArtifact(
  raw: unknown,
  taskRepos: string[],
): { ok: true; artifact: TaskArtifact } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "each artifact must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.type !== "string" || !VALID_ARTIFACT_TYPES.has(obj.type)) {
    return {
      ok: false,
      message: 'artifact type must be one of: pull_request, issue, issue_comment, commit',
    };
  }

  if (typeof obj.url !== "string" || obj.url.length === 0) {
    return { ok: false, message: "artifact url must be a non-empty string" };
  }

  const url = obj.url;

  if (!url.startsWith("https://github.com/")) {
    return { ok: false, message: "artifact url must start with https://github.com/" };
  }

  // URL must be scoped to one of the task's repos.
  const matchesRepo = taskRepos.some((repo) =>
    url.startsWith(`https://github.com/${repo}/`)
  );
  if (!matchesRepo) {
    return {
      ok: false,
      message: `artifact url must be for one of the task's repos: ${taskRepos.join(", ")}`,
    };
  }

  if (obj.number !== undefined) {
    if (
      typeof obj.number !== "number"
      || !Number.isInteger(obj.number)
      || obj.number < 1
    ) {
      return { ok: false, message: "artifact number must be a positive integer if present" };
    }
  }

  if (obj.title !== undefined) {
    if (typeof obj.title !== "string" || obj.title.length > 200) {
      return { ok: false, message: "artifact title must be a string of at most 200 characters if present" };
    }
  }

  const artifact: TaskArtifact = {
    type: obj.type as TaskArtifact["type"],
    url,
  };
  if (typeof obj.number === "number") artifact.number = obj.number;
  if (typeof obj.title === "string") artifact.title = obj.title;

  return { ok: true, artifact };
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
    return taskError(
      TASK_ERROR.PAYLOAD_TOO_LARGE,
      "Payload too large (max 16KB)",
      413,
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return taskError(
      TASK_ERROR.PAYLOAD_TOO_LARGE,
      "Payload too large (max 16KB)",
      413,
    );
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

  // Installation scoping from executor token enforces tenant isolation.
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

  if (!Array.isArray(obj.artifacts)) {
    return taskError(TASK_ERROR.MISSING_FIELDS, "artifacts must be an array", 400);
  }

  if (obj.artifacts.length === 0) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, "artifacts array must not be empty", 400);
  }

  const validated: TaskArtifact[] = [];
  for (let i = 0; i < obj.artifacts.length; i++) {
    const result = validateArtifact(obj.artifacts[i], existingTask.repos);
    if (!result.ok) {
      return taskError(
        TASK_ERROR.VALIDATION_FAILED,
        `artifacts[${i}]: ${result.message}`,
        400,
      );
    }
    validated.push(result.artifact);
  }

  const appendResult = await appendTaskArtifacts(
    auth.installationId,
    taskId,
    validated,
    auth.redis,
  );

  if (!appendResult.ok) {
    if (appendResult.reason === "not_found") {
      return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
    }
    // cap_exceeded
    return taskError(
      TASK_ERROR.VALIDATION_FAILED,
      "Maximum artifact count (20) would be exceeded",
      409,
    );
  }

  return NextResponse.json({ task: appendResult.task });
}
