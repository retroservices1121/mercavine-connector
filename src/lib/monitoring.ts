/**
 * Error tracking and security alerts. Sentry is inert unless SENTRY_DSN is set.
 *
 *   SENTRY_DSN                 project DSN (no default; nothing is sent without it)
 *   SENTRY_ENVIRONMENT         optional, default RAILWAY_ENVIRONMENT_NAME or NODE_ENV
 *   SENTRY_TRACES_SAMPLE_RATE  optional, default 0 (errors only)
 *
 * Security alerts (login lockouts, approval-link security holds) are sent to
 * Sentry as warning-level messages tagged security_alert, so a Sentry alert
 * rule on that tag emails/pages the incident contact.
 */
type SentryLike = {
  captureException: (e: unknown, ctx?: unknown) => unknown;
  captureMessage: (m: string, ctx?: unknown) => unknown;
};

const g = globalThis as unknown as { __mvSentry?: SentryLike | null; __mvConsoleBridge?: boolean };

export function sentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN?.trim());
}

/** Strip secrets that could ride along on request data. */
export function scrubEvent<T extends { request?: { headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown } }>(event: T): T {
  if (event.request) {
    if (event.request.headers) {
      for (const k of Object.keys(event.request.headers)) {
        if (/authorization|cookie|token|secret|signature/i.test(k)) event.request.headers[k] = "[redacted]";
      }
    }
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
  }
  return event;
}

export async function initMonitoring(): Promise<void> {
  if (g.__mvSentry !== undefined) return;
  if (!sentryEnabled()) {
    g.__mvSentry = null;
    return;
  }
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: process.env.SENTRY_DSN!.trim(),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event as never),
  });
  g.__mvSentry = Sentry as unknown as SentryLike;
  bridgeSecurityLogs();
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  g.__mvSentry?.captureException(error, context ? { extra: context } : undefined);
}

export type SecurityAlert = "login_lockout" | "approval_security_hold" | (string & {});

export function securityAlert(kind: SecurityAlert, detail: Record<string, unknown> = {}): void {
  console.warn(`[security-alert] ${kind} ${JSON.stringify(detail)}`);
}

function sendAlert(line: string): void {
  const kind = line.replace(/^\[security-alert\]\s*/, "").split(/\s/)[0] || "security_alert";
  g.__mvSentry?.captureMessage(`Security alert: ${kind}`, { level: "warning", tags: { security_alert: kind }, extra: { line } });
}

/**
 * Any log line starting with "[security-alert]" (from securityAlert() or from
 * other modules, e.g. the login lockout) is forwarded to Sentry.
 */
function bridgeSecurityLogs(): void {
  if (g.__mvConsoleBridge) return;
  g.__mvConsoleBridge = true;
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    original(...args);
    const first = args[0];
    if (typeof first === "string" && first.startsWith("[security-alert]")) {
      try {
        sendAlert(first);
      } catch {
        /* never let alerting break the caller */
      }
    }
  };
}

/** For tests. */
export function __setSentryForTests(s: SentryLike | null): void {
  g.__mvSentry = s;
  if (s) bridgeSecurityLogs();
}
