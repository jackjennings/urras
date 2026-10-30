export interface UsageLimitHit {
  raw: string;
  scope: "session" | "weekly" | "unknown";
  resetAt: string | null;
}

export function detectUsageLimit(opts: {
  stdout: string;
  stderr: string;
  now: Temporal.ZonedDateTime;
}): UsageLimitHit | null {
  const match = /you.ve hit your (\w+) limit/i.exec(opts.stdout);
  if (!match) return null;

  const scopeWord = match[1].toLowerCase();
  const scope: UsageLimitHit["scope"] = scopeWord === "session"
    ? "session"
    : scopeWord === "weekly"
    ? "weekly"
    : "unknown";

  const raw = match[0];
  const resetAt = parseResetAt(opts.stdout, opts.now);
  return { raw, scope, resetAt };
}

function parseResetAt(
  stdout: string,
  now: Temporal.ZonedDateTime,
): string | null {
  const timeMatch =
    /resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+\(([^)]+)\)/i.exec(stdout);
  if (!timeMatch) return null;
  const [, timeStr, tzName] = timeMatch;
  try {
    const plain = parsePlainTime(timeStr);
    if (!plain) return null;
    let candidate = now.withPlainTime(plain).withTimeZone(tzName);
    if (Temporal.ZonedDateTime.compare(candidate, now) <= 0) {
      candidate = candidate.add({ days: 1 });
    }
    return candidate.toInstant().toString();
  } catch {
    return null;
  }
}

function parsePlainTime(s: string): Temporal.PlainTime | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3].toLowerCase();
  if (meridiem === "am" && hour === 12) hour = 0;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  try {
    return Temporal.PlainTime.from({ hour, minute });
  } catch {
    return null;
  }
}
