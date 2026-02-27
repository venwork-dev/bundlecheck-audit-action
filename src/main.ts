import * as core from "@actions/core";
import * as github from "@actions/github";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { postAudit, pollAudit, postCompare, type Budget } from "./api";
import { renderComment, renderCompareComment } from "./render";
import { upsertComment } from "./comment";

function getIntInput(name: string, defaultValue: number): number {
  const raw = core.getInput(name);
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n < 1 ? defaultValue : n;
}

function parsePackages(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBudget(): Budget {
  const budget: Budget = {};
  const perPkg = getIntInput("per_package_gzip", 0);
  const total = getIntInput("total_gzip", 0);
  if (perPkg > 0) budget.per_package_gzip = perPkg;
  if (total > 0) budget.total_gzip = total;
  return budget;
}

function prCommentWarning(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Resource not accessible by integration")) {
    return (
      `Failed to post PR comment: the GITHUB_TOKEN lacks pull-requests: write permission. ` +
      `Add the following to your workflow:\n\n` +
      `permissions:\n  pull-requests: write`
    );
  }
  return `Failed to post PR comment: ${msg}`;
}

async function runAuditMode(
  apiUrl: string,
  apiKey: string,
  githubToken: string,
  failOnViolation: boolean,
  failOnPartial: boolean,
  warnOnly: boolean,
  pollIntervalSeconds: number,
  pollTimeoutSeconds: number,
  rawPackages: string
): Promise<void> {
  const packages = parsePackages(rawPackages);

  if (packages.length === 0) {
    core.setFailed("No packages provided. Add at least one name@version entry.");
    return;
  }

  core.info(`Auditing ${packages.length} package${packages.length > 1 ? "s" : ""}…`);

  const budget = parseBudget();
  if (budget.per_package_gzip) core.info(`Budget: per_package_gzip = ${budget.per_package_gzip} bytes`);
  if (budget.total_gzip) core.info(`Budget: total_gzip = ${budget.total_gzip} bytes`);

  const postResult = await postAudit(apiUrl, apiKey, { packages, budget, fail_on_partial: failOnPartial });

  let audit;
  if (postResult.async) {
    core.info(`Audit queued (${packages.length} packages). Polling for results…`);
    audit = await pollAudit(apiUrl, apiKey, postResult.analysisId, pollIntervalSeconds, pollTimeoutSeconds);
  } else {
    audit = postResult.data;
  }

  core.setOutput("pass", String(audit.pass));
  core.setOutput("total_gzip", String(audit.summary.total_gzip));
  core.setOutput("violation_count", String(audit.violations.filter((v) => v.package !== "(total)").length));

  for (const item of audit.results) {
    if (item.status === "ok") {
      core.info(`  ${item.pass ? "✅" : "❌"} ${item.package}: ${item.gzip} bytes gzip`);
    } else {
      core.warning(`  ⚠️  ${item.package}: ${item.status} — ${item.error_message}`);
    }
  }

  const commentBody = renderComment(audit);
  try {
    await upsertComment(githubToken, commentBody);
  } catch (err) {
    core.warning(prCommentWarning(err));
  }

  applyExitCode(audit.pass, audit.violations, failOnViolation, failOnPartial, warnOnly);
}

async function runCompareMode(
  apiUrl: string,
  apiKey: string,
  githubToken: string,
  failOnViolation: boolean,
  failOnPartial: boolean,
  warnOnly: boolean
): Promise<void> {
  const lockfilePath = core.getInput("lockfile_path") || "package-lock.json";

  // Resolve base ref: explicit input → PR base ref → fallback to origin/main
  let baseRef = core.getInput("base_ref");
  if (!baseRef) {
    baseRef = github.context.payload.pull_request?.base?.ref
      ? `origin/${github.context.payload.pull_request.base.ref}`
      : "origin/main";
  }

  core.info(`Comparing ${lockfilePath} — base: ${baseRef}`);

  // Check if the lockfile actually changed before making any API call.
  // An unchanged lockfile means no packages were added or bumped — nothing to audit.
  try {
    const changed = execSync(`git diff --name-only ${baseRef} -- ${lockfilePath}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!changed) {
      core.info(`${lockfilePath} is unchanged — skipping audit.`);
      core.setOutput("pass", "true");
      core.setOutput("total_gzip", "0");
      core.setOutput("violation_count", "0");
      return;
    }
  } catch {
    // git diff failed (shallow clone, detached HEAD, etc.) — continue and let the API handle it
    core.warning("Could not determine if lockfile changed — proceeding with full compare.");
  }

  // Read head lockfile from disk
  if (!existsSync(lockfilePath)) {
    core.setFailed(`Lockfile not found: ${lockfilePath}. Run "actions/checkout" before this action.`);
    return;
  }
  const headLockfile = readFileSync(lockfilePath, "utf-8");

  // Read base lockfile from git
  let baseLockfile: string;
  try {
    baseLockfile = execSync(`git show ${baseRef}:${lockfilePath}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // Base lockfile missing means this is a brand-new lockfile — treat everything as added
    core.warning(
      `Could not read ${lockfilePath} from ${baseRef} — treating all packages as new. ` +
        `Make sure "actions/checkout" runs with fetch-depth: 0.`
    );
    // Return an empty lockfile in the correct format so the server can parse it
    baseLockfile = lockfilePath.endsWith("yarn.lock")
      ? "# yarn lockfile v1\n"
      : JSON.stringify({ lockfileVersion: 3, packages: {} });
  }

  const budget = parseBudget();
  const compare = await postCompare(apiUrl, apiKey, baseLockfile, headLockfile, budget, failOnPartial);

  core.setOutput("pass", String(compare.pass));
  core.setOutput("total_gzip", String(compare.summary.total_new_gzip));
  core.setOutput("violation_count", String(compare.violations.filter((v) => v.package !== "(total)").length));

  const { added, changed, removed, summary } = compare;
  if (added.length + changed.length + removed.length === 0) {
    core.info("No package changes detected — nothing to audit.");
  } else {
    core.info(`Added: ${summary.added_count}  Changed: ${summary.changed_count}  Removed: ${summary.removed_count}`);
    for (const item of [...added, ...changed]) {
      if (item.status === "ok") {
        core.info(`  ${item.pass ? "✅" : "❌"} ${item.package}: ${item.gzip} bytes gzip`);
      } else {
        core.warning(`  ⚠️  ${item.package}: ${item.status} — ${item.error_message}`);
      }
    }
  }

  const commentBody = renderCompareComment(compare);
  try {
    await upsertComment(githubToken, commentBody);
  } catch (err) {
    core.warning(prCommentWarning(err));
  }

  applyExitCode(compare.pass, compare.violations, failOnViolation, failOnPartial, warnOnly);
}

function applyExitCode(
  pass: boolean,
  violations: Array<{ package: string; over_by: number }>,
  failOnViolation: boolean,
  failOnPartial: boolean,
  warnOnly: boolean
): void {
  if (warnOnly) {
    if (!pass) core.warning("BundleCheck found violations but warn_only is set — not failing the workflow.");
    else core.info("✅ BundleCheck passed.");
    return;
  }

  const pkgViolations = violations.filter((v) => v.package !== "(total)");
  const totalViolation = violations.find((v) => v.package === "(total)");
  const hasViolations = pkgViolations.length > 0 || totalViolation != null;

  // Budget violations — controlled by fail_on_violation
  if (hasViolations && failOnViolation) {
    const parts: string[] = [];
    if (pkgViolations.length > 0)
      parts.push(`${pkgViolations.length} package${pkgViolations.length > 1 ? "s" : ""} over per-package budget`);
    if (totalViolation)
      parts.push(`total gzip over budget by ${totalViolation.over_by} bytes`);
    core.setFailed(`BundleCheck failed: ${parts.join("; ")}.`);
    return;
  }

  // Denied / not-found / error packages — controlled by fail_on_partial
  if (!pass && failOnPartial) {
    core.setFailed("BundleCheck failed: one or more packages could not be bundled.");
    return;
  }

  if (!pass) {
    // Denied packages (e.g. typescript, webpack) are expected — they are not browser bundles.
    // Set fail_on_partial: true to block CI on these.
    core.warning("BundleCheck: some packages were skipped (denied or not found) — set fail_on_partial: true to treat this as a failure.");
    return;
  }

  core.info("✅ BundleCheck passed.");
}

async function run(): Promise<void> {
  const apiKey = core.getInput("api_key", { required: true });
  const apiUrl = core.getInput("api_url") || "https://bundlecheck.dev";
  const githubToken = core.getInput("github_token", { required: true });
  const failOnViolation = core.getInput("fail_on_violation") !== "false";
  const failOnPartial = core.getInput("fail_on_partial") === "true";
  const warnOnly = core.getInput("warn_only") === "true";
  const pollIntervalSeconds = getIntInput("poll_interval_seconds", 3);
  const pollTimeoutSeconds = getIntInput("poll_timeout_seconds", 300);

  // Mode detection: if "packages" is set → explicit audit mode
  //                 otherwise → lockfile compare mode
  const explicitPackages = core.getInput("packages");

  if (explicitPackages.trim()) {
    await runAuditMode(
      apiUrl, apiKey, githubToken,
      failOnViolation, failOnPartial, warnOnly,
      pollIntervalSeconds, pollTimeoutSeconds,
      explicitPackages
    );
  } else {
    await runCompareMode(
      apiUrl, apiKey, githubToken,
      failOnViolation, failOnPartial, warnOnly
    );
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
