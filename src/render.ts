import type { AuditResponse, AuditResultItem, AuditViolation } from "./api";

export const COMMENT_MARKER = "<!-- bundlecheck-audit -->";

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function statusCell(item: AuditResultItem): string {
  const emoji: Record<AuditResultItem["status"], string> = {
    ok: "✅",
    denied: "⛔",
    not_found: "🔍",
    timeout: "⏱️",
    error: "❌",
  };
  return `${emoji[item.status]} ${item.status}`;
}

function resultCell(
  item: AuditResultItem,
  violationMap: Map<string, AuditViolation>
): string {
  if (item.status !== "ok") return "—";
  if (!item.pass) {
    const v = violationMap.get(item.package);
    return v ? `❌ over by ${formatBytes(v.over_by)}` : "❌";
  }
  return "✅";
}

export function renderComment(audit: AuditResponse): string {
  const { pass, results, violations, summary } = audit;

  const violationMap = new Map(
    violations.filter((v) => v.package !== "(total)").map((v) => [v.package, v])
  );
  const totalViolation = violations.find((v) => v.package === "(total)");

  const heading = pass
    ? "## ✅ BundleCheck — all packages within budget"
    : "## ❌ BundleCheck — budget violations detected";

  const tableRows = results.map((item) => {
    const gzip = item.status === "ok" ? formatBytes(item.gzip) : "—";
    return `| \`${item.package}\` | ${gzip} | ${statusCell(item)} | ${resultCell(item, violationMap)} |`;
  });

  const totalResultCell = totalViolation
    ? `❌ over by ${formatBytes(totalViolation.over_by)}`
    : summary.ok_count > 0
    ? "✅"
    : "—";

  const table = [
    "| Package | Gzip | Status | Result |",
    "|---|---|---|---|",
    ...tableRows,
    `| **Total** | **${formatBytes(summary.total_gzip)}** | | ${totalResultCell} |`,
  ].join("\n");

  const lines: string[] = [
    COMMENT_MARKER,
    heading,
    "",
    table,
    "",
    `> ⚠️ \`total_gzip\` is the **sum of individual package costs** — not your real app bundle size (deduplication and tree-shaking are not accounted for).`,
  ];

  if (summary.skipped_count > 0) {
    lines.push(
      `> ℹ️ ${summary.skipped_count} package${summary.skipped_count > 1 ? "s" : ""} skipped (denied, not found, or errored).`
    );
  }

  if (summary.warning) {
    lines.push(`> ⚠️ ${summary.warning}`);
  }

  return lines.join("\n");
}
