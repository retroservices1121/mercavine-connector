const SECRET_KEY = /authorization|token|password|secret|signature|cookie|card|cvc|cvv|stripe|payment_method|client_secret|last4|pan/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(inner);
    }
    return out;
  }
  if (typeof value === "string" && /^(pi_|pm_|sk_|whsec_|osa_)/.test(value)) return "[redacted]";
  return value;
}

const LEAK_KEY = /stripe|payment_intent|payment_method|client_secret|last4|cvc|cvv|card_number|cardholder|billing|pan|expiry|exp_month|exp_year|credential|refresh_token/i;

/** Throws if a bot-visible payload contains payment material. */
export function assertBotSafe(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertBotSafe(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (LEAK_KEY.test(key)) throw new Error(`Bot payload leaked field ${path}.${key}`);
      if (typeof inner === "string" && /^(pi_|pm_|sk_|whsec_|Atzr\|)/.test(inner)) {
        throw new Error(`Bot payload leaked a secret-looking string at ${path}.${key}`);
      }
      assertBotSafe(inner, `${path}.${key}`);
    }
  }
}
