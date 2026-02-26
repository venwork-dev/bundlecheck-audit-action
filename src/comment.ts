import * as github from "@actions/github";
import { COMMENT_MARKER } from "./render";

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Find the existing BundleCheck comment on a PR by looking for the marker string.
 * Paginates through up to 500 comments (5 pages × 100).
 */
async function findExistingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<number | null> {
  for (let page = 1; page <= 5; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });

    const match = data.find((c: { id: number; body?: string | null }) => c.body?.includes(COMMENT_MARKER));
    if (match) return match.id;
    if (data.length < 100) break; // no more pages
  }
  return null;
}

/**
 * Upsert a PR comment containing the BundleCheck audit result.
 * If a previous comment exists (identified by COMMENT_MARKER), it is updated.
 * If not running in a pull_request context, logs the body to stdout instead.
 */
export async function upsertComment(token: string, body: string): Promise<void> {
  const ctx = github.context;
  const issueNumber = ctx.issue?.number;

  if (!issueNumber) {
    // Not a PR — print results to the workflow log instead
    console.log("Not running in a pull request context. Audit result:\n");
    console.log(body);
    return;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = ctx.repo;

  const existingId = await findExistingComment(octokit, owner, repo, issueNumber);

  if (existingId) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }
}
