import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { buildIssueSnapshot, type IssueSnapshotResult } from "../github/issue-snapshot.js";

export interface IssueSnapshotOptions {
  repo?: string;
  json?: boolean;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatSnapshot(snapshot: IssueSnapshotResult): string {
  const { issue } = snapshot;

  const lines = [
    `ISSUE SNAPSHOT — ${formatRepo(snapshot.repo)}#${issue.number}`,
    issue.title,
    `state: ${issue.state}`,
    `labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "none"}`,
    `governance: ${issue.governance.phase}`,
  ];

  if (issue.author) {
    lines.push(`author: ${issue.author}`);
  }

  if (issue.assignees.length > 0) {
    lines.push(`assignees: ${issue.assignees.join(", ")}`);
  }

  if (issue.queenSummary) {
    const preview = issue.queenSummary.body.slice(0, 200);
    const suffix = issue.queenSummary.body.length > 200 ? "…" : "";
    lines.push(`queen summary: ${preview}${suffix}`);
  }

  if (issue.queenVoting) {
    const { thumbsUp, thumbsDown, yourVote } = issue.queenVoting;
    const voteStr = yourVote === "thumbsUp" ? "👍" : yourVote === "thumbsDown" ? "👎" : "not voted";
    lines.push(`queen voting: 👍 ${thumbsUp}  👎 ${thumbsDown}  your vote: ${voteStr}`);
  }

  return lines.join("\n");
}

export async function issueSnapshotCommand(
  issueArg: string,
  options: IssueSnapshotOptions,
): Promise<void> {
  const issueNumber = parseInt(issueArg, 10);
  if (isNaN(issueNumber) || issueNumber <= 0) {
    throw new CliError(
      `Invalid issue number: "${issueArg}". Expected a positive integer.`,
      "GH_ERROR",
      1,
    );
  }

  const repo = await resolveRepo(options.repo);

  let snapshot: IssueSnapshotResult;
  try {
    snapshot = await buildIssueSnapshot(repo, issueNumber);
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(err.message, err.code, Math.max(err.exitCode, 3));
    }
    throw new CliError(
      err instanceof Error ? err.message : String(err),
      "GH_ERROR",
      3,
    );
  }

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(formatSnapshot(snapshot));
}
