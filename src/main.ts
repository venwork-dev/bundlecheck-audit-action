import * as core from "@actions/core";
import * as github from "@actions/github";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { postAudit, pollAudit, type AuditResponse, type Budget } from "./api";
import { renderComment, renderDepsComment } from "./render";
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

  applyExitCode(audit.pass, audit.violations, failOnViolation, failOnPartial);
}

interface AddedDep { name: string; version: string }
interface ChangedDep { name: string; version: string; previousSpec: string }
interface RemovedDep { name: string }

// Strip range specifiers from a package.json version spec to get a usable version string.
// Returns null for non-npm protocols (workspace:, file:, link:, etc.) that can't be bundled.
function cleanVersion(spec: string): string | null {
  if (/^(workspace|file|link|portal|patch|git[+:]|github:|bitbucket:|gitlab:)/.test(spec) || spec === "*") {
    return null;
  }
  const stripped = spec.replace(/^[\^~>=<v]+/, "").trim();
  const first = stripped.split(/\s*\|\|\s*/)[0].trim().split(/\s+/)[0];
  return first || null;
}

function diffDependencies(
  baseDeps: Record<string, string>,
  headDeps: Record<string, string>
): { added: AddedDep[]; changed: ChangedDep[]; removed: RemovedDep[] } {
  const added: AddedDep[] = [];
  const changed: ChangedDep[] = [];
  const removed: RemovedDep[] = [];

  for (const [name, spec] of Object.entries(headDeps)) {
    const version = cleanVersion(spec);
    if (version === null) continue; // skip workspace/file/link/etc.
    if (!(name in baseDeps)) {
      added.push({ name, version });
    } else if (baseDeps[name] !== spec) {
      changed.push({ name, version, previousSpec: baseDeps[name] });
    }
  }

  for (const name of Object.keys(baseDeps)) {
    if (!(name in headDeps)) {
      removed.push({ name });
    }
  }

  return { added, changed, removed };
}

async function runCompareMode(
  apiUrl: string,
  apiKey: string,
  githubToken: string,
  failOnViolation: boolean,
  failOnPartial: boolean,
  pollIntervalSeconds: number,
  pollTimeoutSeconds: number
): Promise<void> {
  const packageJsonPath = core.getInput("package_json_path") || "package.json";

  let baseRef = core.getInput("base_ref");
  if (!baseRef) {
    baseRef = github.context.payload.pull_request?.base?.ref
      ? `origin/${github.context.payload.pull_request.base.ref}`
      : "origin/main";
  }

  core.info(`BundleCheck: comparing ${packageJsonPath} dependencies — base: ${baseRef}`);

  // Read head package.json
  if (!existsSync(packageJsonPath)) {
    core.setFailed(`${packageJsonPath} not found. Run "actions/checkout" before this action.`);
    return;
  }

  let headDeps: Record<string, string>;
  try {
    const raw = readFileSync(packageJsonPath, "utf-8");
    headDeps = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch {
    core.setFailed(`Failed to parse ${packageJsonPath}.`);
    return;
  }

  // Read base package.json from git
  let baseDeps: Record<string, string> = {};
  try {
    const raw = execSync(`git show ${baseRef}:${packageJsonPath}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    baseDeps = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch {
    core.warning(`Could not read ${packageJsonPath} from ${baseRef} — treating all dependencies as new.`);
  }

  const { added, changed, removed } = diffDependencies(baseDeps, headDeps);

  if (added.length + changed.length + removed.length === 0) {
    core.info("No production dependency changes — skipping.");
    core.setOutput("pass", "true");
    core.setOutput("total_gzip", "0");
    core.setOutput("violation_count", "0");
    return;
  }

  core.info(`Changes: ${added.length} added · ${changed.length} changed · ${removed.length} removed`);

  const toAudit = [
    ...added.map((p) => `${p.name}@${p.version}`),
    ...changed.map((p) => `${p.name}@${p.version}`),
  ];

  let audit: AuditResponse | null = null;

  if (toAudit.length > 0) {
    const budget = parseBudget();
    const postResult = await postAudit(apiUrl, apiKey, {
      packages: toAudit,
      budget,
      fail_on_partial: failOnPartial,
    });

    if (postResult.async) {
      core.info(`Audit queued (${toAudit.length} packages). Polling for results…`);
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
        core.warning(`  ⚠️  ${item.package}: ${item.status}`);
      }
    }
  } else {
    // Only removals — no bundle analysis needed
    core.setOutput("pass", "true");
    core.setOutput("total_gzip", "0");
    core.setOutput("violation_count", "0");
  }

  const addedNames = new Set(added.map((p) => p.name));
  const commentBody = renderDepsComment({ added, changed, removed, audit, addedNames });
  try {
    await upsertComment(githubToken, commentBody);
  } catch (err) {
    core.warning(prCommentWarning(err));
  }

  if (audit) {
    applyExitCode(audit.pass, audit.violations, failOnViolation, failOnPartial);
  }
}

function applyExitCode(
  pass: boolean,
  violations: Array<{ package: string; over_by: number }>,
  failOnViolation: boolean,
  failOnPartial: boolean
): void {
  const pkgViolations = violations.filter((v) => v.package !== "(total)");
  const totalViolation = violations.find((v) => v.package === "(total)");
  const hasViolations = pkgViolations.length > 0 || totalViolation != null;

  if (hasViolations && failOnViolation) {
    const parts: string[] = [];
    if (pkgViolations.length > 0)
      parts.push(`${pkgViolations.length} package${pkgViolations.length > 1 ? "s" : ""} over per-package budget`);
    if (totalViolation)
      parts.push(`total gzip over budget by ${totalViolation.over_by} bytes`);
    core.setFailed(`BundleCheck failed: ${parts.join("; ")}.`);
    return;
  }

  if (!pass && failOnPartial) {
    core.setFailed("BundleCheck failed: one or more packages could not be bundled.");
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
  const pollIntervalSeconds = getIntInput("poll_interval_seconds", 3);
  const pollTimeoutSeconds = getIntInput("poll_timeout_seconds", 300);

  // Mode detection: if "packages" is set → explicit audit mode
  //                 otherwise → lockfile compare mode
  const explicitPackages = core.getInput("packages");

  if (explicitPackages.trim()) {
    await runAuditMode(
      apiUrl, apiKey, githubToken,
      failOnViolation, failOnPartial,
      pollIntervalSeconds, pollTimeoutSeconds,
      explicitPackages
    );
  } else {
    await runCompareMode(
      apiUrl, apiKey, githubToken,
      failOnViolation, failOnPartial,
      pollIntervalSeconds, pollTimeoutSeconds
    );
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
