export type Budget = {
  per_package_gzip?: number;
  total_gzip?: number;
};

export type AuditInput = {
  packages: string[];
  budget: Budget;
  fail_on_partial: boolean;
};

export type AuditResultItem =
  | { package: string; status: "ok"; gzip: number; pass: boolean }
  | {
      package: string;
      status: "denied" | "not_found" | "timeout" | "error";
      gzip: null;
      pass: null;
      error_code: string;
      error_message: string;
    };

export type AuditViolation = {
  package: string;
  gzip: number;
  limit: number;
  over_by: number;
};

export type AuditSummary = {
  total_gzip: number;
  note: string;
  package_count: number;
  ok_count: number;
  skipped_count: number;
  warning?: string;
};

export type AuditResponse = {
  pass: boolean;
  mode: "exact";
  fail_on_partial: boolean;
  violations: AuditViolation[];
  results: AuditResultItem[];
  summary: AuditSummary;
};

type AsyncQueued = {
  status: "pending";
  analysis_id: string;
  poll: string;
  message: string;
};

type PostAuditResult =
  | { async: false; data: AuditResponse }
  | { async: true; analysisId: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;

  const direct = getString(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractErrorMessage(item, depth + 1);
      if (message) return message;
    }
    return null;
  }

  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const preferredKeys = [
    "message",
    "detail",
    "error_description",
    "title",
    "reason",
  ];

  for (const key of preferredKeys) {
    const message = getString(record[key]);
    if (message) return message;
  }

  for (const key of ["error", "errors"]) {
    const message = extractErrorMessage(record[key], depth + 1);
    if (message) return message;
  }

  return null;
}

async function parseErrorMessage(res: Response): Promise<string> {
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;

  try {
    const raw = (await res.text()).trim();
    if (!raw) return status;

    try {
      const parsed = JSON.parse(raw) as unknown;
      const message = extractErrorMessage(parsed);
      if (message) return `${status}: ${truncate(message)}`;
    } catch {
      // Not JSON: fall back to raw body text.
    }

    return `${status}: ${truncate(raw.replace(/\s+/g, " "))}`;
  } catch {
    return status;
  }
}

export async function postAudit(
  apiUrl: string,
  apiKey: string,
  input: AuditInput
): Promise<PostAuditResult> {
  const res = await fetch(`${apiUrl}/v1/api/audit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      packages: input.packages,
      budget: input.budget,
      fail_on_partial: input.fail_on_partial,
    }),
  });

  if (res.status === 202) {
    const body = (await res.json()) as AsyncQueued;
    return { async: true, analysisId: body.analysis_id };
  }

  if (!res.ok) {
    const message = await parseErrorMessage(res);
    throw new Error(`Audit request failed: ${message}`);
  }

  return { async: false, data: (await res.json()) as AuditResponse };
}

export async function pollAudit(
  apiUrl: string,
  apiKey: string,
  analysisId: string,
  intervalSeconds: number,
  timeoutSeconds: number
): Promise<AuditResponse> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const pollUrl = `${apiUrl}/v1/api/audit/${analysisId}`;

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);

    const res = await fetch(pollUrl, {
      headers: { "X-API-Key": apiKey },
    });

    if (res.status === 202) {
      // Still pending — keep waiting
      continue;
    }

    if (!res.ok) {
      const message = await parseErrorMessage(res);
      throw new Error(`Poll request failed: ${message}`);
    }

    const body = (await res.json()) as AuditResponse;
    return body;
  }

  throw new Error(
    `Audit timed out after ${timeoutSeconds}s. ` +
      `Tip: batches of ≤20 packages are processed synchronously and are faster. ` +
      `You can also increase poll_timeout_seconds.`
  );
}
