import type { RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";
import {
  GOVERNANCE_LABEL_ALIASES,
  hasGovernanceLabelName,
  type GovernanceLabelKey,
} from "../summary/utils.js";

// === Public result types ===

export interface IssueSnapshotGovernance {
  phase: string;
}

export interface IssueSnapshotQueenSummary {
  body: string;
  commentId: string;
  url: string;
}

export interface IssueSnapshotQueenVoting {
  thumbsUp: number;
  thumbsDown: number;
  yourVote: "thumbsUp" | "thumbsDown" | null;
}

export interface IssueSnapshotIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  assignees: string[];
  author: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  governance: IssueSnapshotGovernance;
  queenSummary?: IssueSnapshotQueenSummary;
  queenVoting?: IssueSnapshotQueenVoting;
}

export interface IssueSnapshotResult {
  schemaVersion: 1;
  kind: "issue_snapshot";
  generatedAt: string;
  repo: RepoRef;
  issue: IssueSnapshotIssue;
}

// === Internal types ===

interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  author: { login: string } | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface GraphQLReactionNode {
  content: string;
  user: { login: string } | null;
}

interface GraphQLComment {
  id: string;
  url: string;
  body: string;
  createdAt: string;
  author: { login: string } | null;
  reactions: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes: GraphQLReactionNode[];
  };
}

interface IssueCommentsConnection {
  pageInfo?: {
    hasPreviousPage?: boolean;
    startCursor?: string | null;
  };
  nodes: GraphQLComment[];
}

interface IssueSnapshotCommentsResponse {
  data: {
    repository: {
      issue: { comments: IssueCommentsConnection } | null;
    };
  };
}

// === Constants ===

const TRUSTED_QUEEN_LOGINS = new Set(["hivemoot", "hivemoot[bot]"]);
const METADATA_RE = /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/;

// Phase priority: first match wins; more active states take precedence.
const PHASE_LABEL_PRIORITY: Array<[GovernanceLabelKey, string]> = [
  ["VOTING", "voting"],
  ["EXTENDED_VOTING", "extended-voting"],
  ["READY_TO_IMPLEMENT", "ready-to-implement"],
  ["IMPLEMENTATION", "candidate"],
  ["MERGE_READY", "merge-ready"],
  ["DISCUSSION", "discussion"],
  ["IMPLEMENTED", "implemented"],
  ["REJECTED", "rejected"],
  ["INCONCLUSIVE", "inconclusive"],
  ["NEEDS_HUMAN", "needs-human"],
  ["STALE", "stale"],
];

// GraphQL query for paginated issue comments with reactions
const ISSUE_SNAPSHOT_COMMENTS_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!, $commentsCursor: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      comments(last: 100, before: $commentsCursor) {
        pageInfo {
          hasPreviousPage
          startCursor
        }
        nodes {
          id
          url
          body
          createdAt
          author { login }
          reactions(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              content
              user { login }
            }
          }
        }
      }
    }
  }
}`;

// === Helpers ===

function deriveGovernancePhase(labelNames: string[]): string {
  for (const [key, phase] of PHASE_LABEL_PRIORITY) {
    if (hasGovernanceLabelName(labelNames, key)) return phase;
  }
  return "none";
}

function parseMeta(body: string): Record<string, unknown> | undefined {
  const match = body.match(METADATA_RE);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stripMetadata(body: string): string {
  return body.replace(METADATA_RE, "").trim();
}

function isQueenSummaryComment(comment: GraphQLComment, issueNumber: number): boolean {
  if (!TRUSTED_QUEEN_LOGINS.has(comment.author?.login ?? "")) return false;
  const meta = parseMeta(comment.body);
  if (!meta) return false;
  return meta.type === "summary" && meta.issueNumber === issueNumber;
}

function isQueenVotingComment(comment: GraphQLComment, issueNumber: number): boolean {
  if (!TRUSTED_QUEEN_LOGINS.has(comment.author?.login ?? "")) return false;
  const meta = parseMeta(comment.body);
  if (!meta) return false;
  return meta.type === "voting" && meta.issueNumber === issueNumber;
}

function countVoteReactions(
  reactions: GraphQLReactionNode[],
): { thumbsUp: number; thumbsDown: number } {
  let thumbsUp = 0;
  let thumbsDown = 0;
  for (const r of reactions) {
    if (r.content === "THUMBS_UP") thumbsUp++;
    else if (r.content === "THUMBS_DOWN") thumbsDown++;
  }
  return { thumbsUp, thumbsDown };
}

function getUserVoteReaction(
  reactions: GraphQLReactionNode[],
  userLogin: string,
): "thumbsUp" | "thumbsDown" | null {
  for (const r of reactions) {
    if (r.user?.login === userLogin) {
      if (r.content === "THUMBS_UP") return "thumbsUp";
      if (r.content === "THUMBS_DOWN") return "thumbsDown";
    }
  }
  return null;
}

// === GitHub API calls ===

async function fetchIssueMetadata(repo: RepoRef, issueNumber: number): Promise<RawIssue> {
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--json",
    "number,title,state,labels,assignees,author,url,createdAt,updatedAt",
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("Failed to parse issue response from gh CLI", "GH_ERROR", 1);
  }

  const issue = parsed as RawIssue;
  if (typeof issue.number !== "number") {
    throw new CliError(`Issue #${issueNumber} not found`, "GH_NOT_FOUND", 1);
  }
  return issue;
}

async function fetchCommentsPage(
  repo: RepoRef,
  issueNumber: number,
  cursor: string | null,
): Promise<IssueCommentsConnection | undefined> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${ISSUE_SNAPSHOT_COMMENTS_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.repo}`,
    "-F",
    `number=${issueNumber}`,
  ];
  if (cursor) {
    args.push("-F", `commentsCursor=${cursor}`);
  } else {
    args.push("-f", "commentsCursor=");
  }

  const raw = await gh(args);
  const response: IssueSnapshotCommentsResponse = JSON.parse(raw);
  return response.data?.repository?.issue?.comments;
}

async function findQueenComments(
  repo: RepoRef,
  issueNumber: number,
): Promise<{ summaryComment?: GraphQLComment; votingComment?: GraphQLComment }> {
  let summaryComment: GraphQLComment | undefined;
  let votingComment: GraphQLComment | undefined;
  let cursor: string | null = null;

  while (true) {
    const connection = await fetchCommentsPage(repo, issueNumber, cursor);
    if (!connection) break;

    // Nodes are in ascending order (oldest first) within the page.
    // Overwrite to capture the latest match in this page.
    for (const comment of connection.nodes) {
      if (isQueenVotingComment(comment, issueNumber)) {
        votingComment = comment;
      }
      if (isQueenSummaryComment(comment, issueNumber)) {
        summaryComment = comment;
      }
    }

    // Both found — stop scanning.
    if (summaryComment && votingComment) break;

    if (!connection.pageInfo?.hasPreviousPage) break;
    cursor = connection.pageInfo.startCursor ?? null;
    if (!cursor) break;
  }

  return { summaryComment, votingComment };
}

// === Core exported function ===

export async function buildIssueSnapshot(
  repo: RepoRef,
  issueNumber: number,
): Promise<IssueSnapshotResult> {
  const generatedAt = new Date().toISOString();

  const [rawIssue, currentUser] = await Promise.all([
    fetchIssueMetadata(repo, issueNumber),
    fetchCurrentUser(),
  ]);

  const labelNames = rawIssue.labels.map((l) => l.name);
  const phase = deriveGovernancePhase(labelNames);

  const { summaryComment, votingComment } = await findQueenComments(repo, issueNumber);

  const issue: IssueSnapshotIssue = {
    number: rawIssue.number,
    title: rawIssue.title,
    state: rawIssue.state,
    labels: labelNames,
    assignees: rawIssue.assignees.map((a) => a.login),
    author: rawIssue.author?.login ?? null,
    url: rawIssue.url,
    createdAt: rawIssue.createdAt,
    updatedAt: rawIssue.updatedAt,
    governance: { phase },
  };

  if (summaryComment) {
    issue.queenSummary = {
      body: stripMetadata(summaryComment.body),
      commentId: summaryComment.id,
      url: summaryComment.url,
    };
  }

  if (votingComment) {
    const { thumbsUp, thumbsDown } = countVoteReactions(votingComment.reactions.nodes);
    const yourVote = getUserVoteReaction(votingComment.reactions.nodes, currentUser);
    issue.queenVoting = { thumbsUp, thumbsDown, yourVote };
  }

  return {
    schemaVersion: 1,
    kind: "issue_snapshot",
    generatedAt,
    repo,
    issue,
  };
}
