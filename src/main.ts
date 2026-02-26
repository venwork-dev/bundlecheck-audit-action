import * as core from "@actions/core";
import { postAudit, pollAudit, type Budget } from "./api";
import { renderComment } from "./render";
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

async function run(): Promise<void> {
  const apiKey = core.getInput("api_key", { required: true });
  const apiUrl = core.getInput("api_url") || "https://bundlecheck.dev";
  const githubToken = core.getInput("github_token", { required: true });
  const failOnViolation = core.getInput("fail_on_violation") !== "false";
  const failOnPartial = core.getInput("fail_on_partial") === "true";
  const warnOnly = core.getInput("warn_only") === "true";
  const pollIntervalSeconds = getIntInput("poll_interval_seconds", 3);
  const pollTimeoutSeconds = getIntInput("poll_timeout_seconds", 300);

  const rawPackages = core.getInput("packages", { required: true });
  const packages = parsePackages(rawPackages);

  if (packages.length === 0) {
    core.setFailed("No packages provided. Add at least one name@version entry.");
    return;
  }

  core.info(`Auditing ${packages.length} package${packages.length > 1 ? "s" : ""}…`);

  const budget = parseBudget();
  if (budget.per_package_gzip) {
    core.info(`Budget: per_package_gzip = ${budget.per_package_gzip} bytes`);
  }
  if (budget.total_gzip) {
    core.info(`Budget: total_gzip = ${budget.total_gzip} bytes`);
  }

  // POST /v1/api/audit
  const postResult = await postAudit(apiUrl, apiKey, {
    packages,
    budget,
    fail_on_partial: failOnPartial,
  });

  let audit;

  if (postResult.async) {
    core.info(
      `Audit queued (${packages.length} packages). Polling for results ` +
        `(interval: ${pollIntervalSeconds}s, timeout: ${pollTimeoutSeconds}s)…`
    );
    audit = await pollAudit(
      apiUrl,
      apiKey,
      postResult.analysisId,
      pollIntervalSeconds,
      pollTimeoutSeconds
    );
  } else {
    audit = postResult.data;
  }

  // Set action outputs
  core.setOutput("pass", String(audit.pass));
  core.setOutput("total_gzip", String(audit.summary.total_gzip));
  core.setOutput(
    "violation_count",
    String(audit.violations.filter((v) => v.package !== "(total)").length)
  );

  // Log per-package summary to the workflow run
  for (const item of audit.results) {
    if (item.status === "ok") {
      const flag = item.pass ? "✅" : "❌";
      core.info(`  ${flag} ${item.package}: ${item.gzip} bytes gzip`);
    } else {
      core.warning(`  ⚠️  ${item.package}: ${item.status} — ${item.error_message}`);
    }
  }

  // Post or update PR comment
  const commentBody = renderComment(audit);
  try {
    await upsertComment(githubToken, commentBody);
  } catch (err) {
    // Comment failure is non-fatal — the audit result is still valid
    core.warning(
      `Failed to post PR comment: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Determine exit code
  if (!audit.pass && failOnViolation && !warnOnly) {
    const pkgViolations = audit.violations.filter((v) => v.package !== "(total)");
    const totalViolation = audit.violations.find((v) => v.package === "(total)");
    const parts: string[] = [];
    if (pkgViolations.length > 0) {
      parts.push(
        `${pkgViolations.length} package${pkgViolations.length > 1 ? "s" : ""} over per-package budget`
      );
    }
    if (totalViolation) {
      parts.push(`total gzip over budget by ${totalViolation.over_by} bytes`);
    }
    if (parts.length === 0 && failOnPartial) {
      parts.push("one or more packages could not be bundled");
    }
    core.setFailed(`BundleCheck failed: ${parts.join("; ")}.`);
  } else if (!audit.pass && warnOnly) {
    core.warning("BundleCheck found violations but warn_only is set — not failing the workflow.");
  } else {
    core.info("✅ BundleCheck passed.");
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
