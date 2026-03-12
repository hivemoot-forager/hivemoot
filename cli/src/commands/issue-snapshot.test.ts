import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/issue-snapshot.js", () => ({
  buildIssueSnapshot: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { buildIssueSnapshot } from "../github/issue-snapshot.js";
import { issueSnapshotCommand } from "./issue-snapshot.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedBuildIssueSnapshot = vi.mocked(buildIssueSnapshot);

const testRepo = { owner: "hivemoot", repo: "hivemoot" };

function makeSnapshot(
  overrides: Partial<Awaited<ReturnType<typeof buildIssueSnapshot>>> = {},
): Awaited<ReturnType<typeof buildIssueSnapshot>> {
  return {
    schemaVersion: 1,
    kind: "issue_snapshot",
    generatedAt: "2026-03-12T10:00:00.000Z",
    repo: testRepo,
    issue: {
      number: 42,
      title: "feat(web): add role-targeted task delegation",
      state: "OPEN",
      labels: ["hivemoot:discussion"],
      assignees: [],
      author: "hivemoot-builder",
      url: "https://github.com/hivemoot/hivemoot/issues/42",
      createdAt: "2026-03-10T10:00:00Z",
      updatedAt: "2026-03-12T09:00:00Z",
      governance: { phase: "discussion" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(testRepo);
  mockedBuildIssueSnapshot.mockResolvedValue(makeSnapshot());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("issueSnapshotCommand", () => {
  describe("input validation", () => {
    it("throws CliError for non-numeric issue argument", async () => {
      await expect(issueSnapshotCommand("abc", {})).rejects.toThrow(CliError);
    });

    it("throws CliError for zero issue number", async () => {
      await expect(issueSnapshotCommand("0", {})).rejects.toThrow(CliError);
    });

    it("throws CliError for negative issue number", async () => {
      await expect(issueSnapshotCommand("-1", {})).rejects.toThrow(CliError);
    });

    it("exits with code 1 for invalid issue number", async () => {
      const err = await issueSnapshotCommand("abc", {}).catch((e) => e as CliError);
      expect(err.exitCode).toBe(1);
    });
  });

  describe("text output", () => {
    it("outputs snapshot header", async () => {
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("ISSUE SNAPSHOT — hivemoot/hivemoot#42");
    });

    it("outputs issue title", async () => {
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("feat(web): add role-targeted task delegation");
    });

    it("outputs governance phase", async () => {
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("governance: discussion");
    });

    it("outputs state", async () => {
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("state: OPEN");
    });

    it("outputs queen summary when present", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshot({
          issue: {
            ...makeSnapshot().issue,
            governance: { phase: "voting" },
            queenSummary: {
              body: "The team discussed adding role-targeted task delegation.",
              commentId: "IC_node123",
              url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-100",
            },
          },
        }),
      );
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("queen summary:");
      expect(output).toContain("role-targeted task delegation");
    });

    it("outputs queen voting tallies when present", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshot({
          issue: {
            ...makeSnapshot().issue,
            governance: { phase: "voting" },
            queenVoting: { thumbsUp: 7, thumbsDown: 1, yourVote: "thumbsUp" },
          },
        }),
      );
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("👍 7");
      expect(output).toContain("👎 1");
      expect(output).toContain("your vote: 👍");
    });

    it("shows not voted when yourVote is null", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshot({
          issue: {
            ...makeSnapshot().issue,
            queenVoting: { thumbsUp: 3, thumbsDown: 0, yourVote: null },
          },
        }),
      );
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain("your vote: not voted");
    });

    it("omits queen fields when absent", async () => {
      await issueSnapshotCommand("42", {});
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).not.toContain("queen summary:");
      expect(output).not.toContain("queen voting:");
    });
  });

  describe("JSON output", () => {
    it("outputs valid JSON with --json flag", async () => {
      await issueSnapshotCommand("42", { json: true });
      const raw = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as Awaited<ReturnType<typeof buildIssueSnapshot>>;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.kind).toBe("issue_snapshot");
      expect(parsed.issue.number).toBe(42);
    });

    it("JSON includes governance phase", async () => {
      await issueSnapshotCommand("42", { json: true });
      const raw = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as Awaited<ReturnType<typeof buildIssueSnapshot>>;
      expect(parsed.issue.governance.phase).toBe("discussion");
    });

    it("JSON includes optional queenVoting when present", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshot({
          issue: {
            ...makeSnapshot().issue,
            queenVoting: { thumbsUp: 5, thumbsDown: 2, yourVote: "thumbsDown" },
          },
        }),
      );
      await issueSnapshotCommand("42", { json: true });
      const raw = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as Awaited<ReturnType<typeof buildIssueSnapshot>>;
      expect(parsed.issue.queenVoting?.thumbsUp).toBe(5);
      expect(parsed.issue.queenVoting?.yourVote).toBe("thumbsDown");
    });
  });

  describe("error handling", () => {
    it("re-throws CliError with exitCode >= 3", async () => {
      mockedBuildIssueSnapshot.mockRejectedValue(
        new CliError("Issue not found", "GH_NOT_FOUND", 1),
      );
      const err = await issueSnapshotCommand("42", {}).catch((e) => e as CliError);
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBeGreaterThanOrEqual(3);
    });

    it("wraps non-CliError in a CliError with exitCode 3", async () => {
      mockedBuildIssueSnapshot.mockRejectedValue(new Error("network timeout"));
      const err = await issueSnapshotCommand("42", {}).catch((e) => e as CliError);
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(3);
      expect(err.message).toBe("network timeout");
    });

    it("passes --repo option to resolveRepo", async () => {
      await issueSnapshotCommand("42", { repo: "other/project" });
      expect(mockedResolveRepo).toHaveBeenCalledWith("other/project");
    });
  });
});
