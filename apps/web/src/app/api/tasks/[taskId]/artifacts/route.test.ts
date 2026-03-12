import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/task-executor-auth", () => ({
  authenticateTaskExecutorRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  MAX_ARTIFACTS_PER_TASK: 20,
  getTask: vi.fn(),
  verifyTaskClaimToken: vi.fn(),
  appendTaskArtifacts: vi.fn(),
}));

import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { type TaskArtifact, getTask, verifyTaskClaimToken, appendTaskArtifacts } from "@/server/task-store";
import { POST } from "./route";

const TASK_ID = "abc123abc123abc123abc123";
const BASE_TASK = {
  task_id: TASK_ID,
  status: "running" as const,
  prompt: "Open a PR",
  repos: ["hivemoot/hivemoot"],
  timeout_secs: 300,
  created_by: "queen",
  created_at: "2026-03-09T12:00:00.000Z",
  updated_at: "2026-03-09T12:01:00.000Z",
};

// The stored artifact: type and number are URL-derived by the route.
const STORED_ARTIFACT: TaskArtifact = {
  type: "pull_request",
  url: "https://github.com/hivemoot/hivemoot/pull/42",
  number: 42,
  title: "Add feature X",
};

// What the caller sends — type and number are ignored; route derives them from url.
const ARTIFACT_REQUEST = {
  url: "https://github.com/hivemoot/hivemoot/pull/42",
  title: "Add feature X",
};

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
    ok: true,
    installationId: "inst-1",
    redis: {} as never,
  });

  vi.mocked(getTask).mockResolvedValue(BASE_TASK);
  vi.mocked(verifyTaskClaimToken).mockResolvedValue(true);
  vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: true, artifacts: [STORED_ARTIFACT] });
});

function makeRequest(body: unknown, claimToken = "claim-token-1") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (claimToken) headers.set("x-task-claim-token", claimToken);
  return new NextRequest(`https://example.com/api/tasks/${TASK_ID}/artifacts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[taskId]/artifacts", () => {
  it("appends valid artifacts and returns artifact list", async () => {
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts).toEqual([STORED_ARTIFACT]);
    expect(appendTaskArtifacts).toHaveBeenCalledWith(
      "inst-1",
      TASK_ID,
      [STORED_ARTIFACT],
      expect.anything(),
    );
  });

  it("rejects missing claim token", async () => {
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }, ""));
    expect(res.status).toBe(403);
  });

  it("rejects invalid claim token", async () => {
    vi.mocked(verifyTaskClaimToken).mockResolvedValue(false);
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(403);
  });

  it("rejects task not found", async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated request", async () => {
    vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    } as never);
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(401);
  });

  it("rejects artifact with URL from a different repo", async () => {
    const res = await POST(
      makeRequest({
        artifacts: [{ url: "https://github.com/other/repo/pull/1" }],
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toMatch(/scoped/);
  });

  it("rejects artifact with non-GitHub URL", async () => {
    const res = await POST(
      makeRequest({
        artifacts: [{ url: "https://example.com/pr/1" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects URL that is in-repo but not a recognised GitHub object path", async () => {
    const res = await POST(
      makeRequest({
        // repo-scoped but unrecognised path (e.g. /releases/tag/...)
        artifacts: [{ url: "https://github.com/hivemoot/hivemoot/releases/tag/v1.0.0" }],
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toMatch(/recognised GitHub object path/);
  });

  it("derives type=pull_request and number from /pull/{N} URL", async () => {
    const res = await POST(
      makeRequest({ artifacts: [{ url: "https://github.com/hivemoot/hivemoot/pull/99" }] }),
    );
    expect(res.status).toBe(200);
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0]).toMatchObject({ type: "pull_request", number: 99 });
  });

  it("derives type=issue and number from /issues/{N} URL", async () => {
    const res = await POST(
      makeRequest({ artifacts: [{ url: "https://github.com/hivemoot/hivemoot/issues/10" }] }),
    );
    expect(res.status).toBe(200);
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0]).toMatchObject({ type: "issue", number: 10 });
  });

  it("derives type=issue_comment and number from /issues/{N}#issuecomment-{M} URL", async () => {
    const res = await POST(
      makeRequest({
        artifacts: [{ url: "https://github.com/hivemoot/hivemoot/issues/5#issuecomment-999" }],
      }),
    );
    expect(res.status).toBe(200);
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0]).toMatchObject({ type: "issue_comment", number: 999 });
  });

  it("derives type=commit with no number from /commit/{sha} URL", async () => {
    const res = await POST(
      makeRequest({
        artifacts: [{ url: "https://github.com/hivemoot/hivemoot/commit/abc1234" }],
      }),
    );
    expect(res.status).toBe(200);
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0].type).toBe("commit");
    expect(artifacts[0].number).toBeUndefined();
  });

  it("ignores caller-supplied type when URL unambiguously determines it", async () => {
    // Caller says type=issue but URL is a pull request — URL wins.
    const res = await POST(
      makeRequest({
        artifacts: [{ type: "issue", url: "https://github.com/hivemoot/hivemoot/pull/42" }],
      }),
    );
    expect(res.status).toBe(200);
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0].type).toBe("pull_request");
  });

  it("ignores caller-supplied number when URL provides it", async () => {
    // Caller says number=99 but URL encodes number=42.
    const res = await POST(
      makeRequest({
        artifacts: [{ number: 99, url: "https://github.com/hivemoot/hivemoot/pull/42" }],
      }),
    );
    expect(res.status).toBe(200);
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0].number).toBe(42);
  });

  it("rejects empty artifacts array", async () => {
    const res = await POST(makeRequest({ artifacts: [] }));
    expect(res.status).toBe(400);
  });

  it("rejects non-array artifacts field", async () => {
    const res = await POST(makeRequest({ artifacts: "not-an-array" }));
    expect(res.status).toBe(400);
  });

  it("returns 422 when artifact limit is exceeded", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "limit_exceeded" });
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.message).toMatch(/limit/);
  });

  it("returns 429 on lock timeout", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "lock_timeout" });
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(429);
  });

  it("truncates artifact title to 200 chars", async () => {
    const longTitle = "x".repeat(300);
    const res = await POST(
      makeRequest({
        artifacts: [{
          url: "https://github.com/hivemoot/hivemoot/pull/1",
          title: longTitle,
        }],
      }),
    );
    expect(res.status).toBe(200);
    const sent = vi.mocked(appendTaskArtifacts).mock.calls[0][0];
    const artifacts = vi.mocked(appendTaskArtifacts).mock.calls[0][2];
    expect(artifacts[0].title?.length).toBe(200);
    expect(sent).toBe("inst-1");
  });

  it("accepts artifact without title", async () => {
    const res = await POST(
      makeRequest({
        artifacts: [{ url: "https://github.com/hivemoot/hivemoot/issues/10" }],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 500 JSON when appendTaskArtifacts throws", async () => {
    vi.mocked(appendTaskArtifacts).mockRejectedValue(new Error("Redis connection lost"));
    const res = await POST(makeRequest({ artifacts: [ARTIFACT_REQUEST] }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.code).toBe("task_server_error");
  });
});
