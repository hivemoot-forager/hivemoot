/**
 * GET /api/repos/[owner]/[repo]/roles
 *
 * Returns the list of agent roles defined in `.github/hivemoot.yml` for the
 * given repository, along with the file SHA for optimistic concurrency on
 * subsequent writes.
 *
 * Also checks for an open role-edit PR so the UI can surface the correct
 * "Editing: pending PR #N" badge instead of "Editing: main".
 */

import { NextRequest, NextResponse } from "next/server";
import { parse as parseYaml } from "yaml";
import { authenticateByokRequest } from "@/server/byok-auth";
import { validateEnv } from "@/server/env";
import { generateAppJwt, generateInstallationToken } from "@/server/github-auth";
import { readRepoFile, listOpenPRsForBranch } from "@/server/github-contents";

const HIVEMOOT_CONFIG_PATH = ".github/hivemoot.yml";

/** Branch name for role-edit PRs created by the web UI. */
const ROLE_EDIT_BRANCH = "hivemoot-role-edits";

/** Maximum number of characters allowed per role field (mirrors CLI guards). */
const MAX_FIELD_LENGTH = 10_000;

interface RoleEntry {
  name: string;
  description: string;
  instructions: string;
}

interface RolesResponse {
  roles: RoleEntry[];
  /** Blob SHA of `.github/hivemoot.yml` at `source`. Pass back on PUT to detect conflicts. */
  fileSha: string;
  /** "main" or "pending-pr:{number}" */
  source: string;
}

function repoError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ code, message }, { status });
}

function extractOwnerRepo(pathname: string): { owner: string; repo: string } | null {
  // /api/repos/{owner}/{repo}/roles
  const match = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/roles(?:\/.*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function sanitizeString(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength);
}

function parseRoles(configContent: string): RoleEntry[] | null {
  let config: unknown;
  try {
    config = parseYaml(configContent);
  } catch {
    return null;
  }

  if (!config || typeof config !== "object") return null;
  const top = config as Record<string, unknown>;
  if (!top.team || typeof top.team !== "object") return null;
  const team = top.team as Record<string, unknown>;
  if (!team.roles || typeof team.roles !== "object" || Array.isArray(team.roles)) return null;

  const rolesMap = team.roles as Record<string, unknown>;
  return Object.entries(rolesMap).map(([name, roleValue]) => {
    const role =
      roleValue && typeof roleValue === "object" ? (roleValue as Record<string, unknown>) : {};
    return {
      name,
      description: sanitizeString(role.description),
      instructions: sanitizeString(role.instructions),
    };
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const parsed = extractOwnerRepo(pathname);
  if (!parsed) {
    return repoError("invalid_path", "Invalid repository path", 400);
  }
  const { owner, repo } = parsed;

  const env = validateEnv();
  if (!env.ok) {
    return repoError("server_misconfiguration", "Server misconfiguration", 503);
  }

  const { githubAppId, githubAppPrivateKey } = env.config;
  if (!githubAppId || !githubAppPrivateKey) {
    return repoError("server_misconfiguration", "GitHub App not configured", 503);
  }

  try {
    const appJwt = generateAppJwt(githubAppId, githubAppPrivateKey);
    const installationToken = await generateInstallationToken(
      auth.session.installationId,
      appJwt,
    );

    // Check for an open role-edit PR; if found, read from that branch.
    const openPRs = await listOpenPRsForBranch(owner, repo, ROLE_EDIT_BRANCH, installationToken);
    const editPR = openPRs.length > 0 ? openPRs[0] : null;
    const ref = editPR ? ROLE_EDIT_BRANCH : undefined;

    const file = await readRepoFile(owner, repo, HIVEMOOT_CONFIG_PATH, installationToken, ref);
    if (!file) {
      return repoError(
        "config_not_found",
        `${HIVEMOOT_CONFIG_PATH} not found in ${owner}/${repo}`,
        404,
      );
    }

    const roles = parseRoles(file.content);
    if (roles === null) {
      return repoError(
        "config_parse_error",
        `Could not parse roles from ${HIVEMOOT_CONFIG_PATH} in ${owner}/${repo}`,
        422,
      );
    }

    const source = editPR ? `pending-pr:${editPR.number}` : "main";
    const body: RolesResponse = { roles, fileSha: file.sha, source };
    return NextResponse.json(body);
  } catch (error) {
    console.error("[repos/roles] Failed to fetch roles", {
      installationId: auth.session.installationId,
      owner,
      repo,
      error,
    });
    return repoError("server_error", "Failed to fetch roles", 500);
  }
}
