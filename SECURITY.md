# Security policy and incident response

Mercavine is operated by Mobi Media Inc. (Florida). Security contact:
**security@mercavine.com**. Privacy requests: privacy@mercavine.com.

## Reporting a vulnerability

Email security@mercavine.com with steps to reproduce. Please do not open a
public GitHub issue. We acknowledge reports within 2 business days and aim to
fix critical issues within 7 days. Good-faith research that avoids privacy
violations, data destruction and service disruption will not be pursued.

## Roles

| Role | Who | Backup |
|---|---|---|
| Incident lead and security contact | JP (founder), security@mercavine.com | none yet; name one |
| Engineering responder | JP, with engineering support | |
| Communications (users, Amazon, Stripe, regulators) | JP | |

Keep a current phone number for the incident lead in the team password manager.

## Severity

- **SEV1**: confirmed or likely unauthorized access to personal data, Amazon
  data, credentials, payment flows, or production infrastructure.
- **SEV2**: exploitable vulnerability with no evidence of access; prolonged outage.
- **SEV3**: minor vulnerability or degraded service.

## Response steps

1. **Detect and log.** Open an incident note (time in Eastern, who found it,
   what was seen). Sources: Sentry `security_alert` events, login-lockout and
   approval-hold alerts, uptime checks, Stripe/Railway/GitHub notices, reports.
2. **Contain.** As needed: revoke bot and OAuth tokens, rotate secrets in
   Railway (STRIPE_*, RESEND_API_KEY, TOKEN_ENCRYPTION_KEY with re-encryption,
   BACKUP_*, Amazon LWA client secret), disable the affected feature with its
   env flag (e.g. AMAZON_MCF_ENABLED=false), block abusive IPs at the WAF,
   or take the service offline.
3. **Preserve evidence.** Export Railway logs and the `audit_log` table and
   keep a database snapshot before changing data.
4. **Notify** (see below).
5. **Eradicate and recover.** Fix the root cause, redeploy, restore from backup
   if needed (docs/BACKUPS.md), confirm with tests and monitoring.
6. **Review within 5 business days.** Write a post-incident summary: timeline,
   root cause, data affected, fixes, follow-ups.

## Notification deadlines

| Who | When | How |
|---|---|---|
| **Amazon** (any incident involving Amazon information or SP-API credentials) | **within 24 hours of detection** | email **security@amazon.com**, per the SP-API Data Protection Policy; include what happened, data involved, steps taken, and our contact. Then follow Amazon's instructions and cooperate with its investigation. |
| Stripe (payment data or Stripe keys) | without undue delay | Stripe Dashboard support + rotate keys |
| Affected users | without undue delay, and within the time state law requires (Florida: 30 days) | email from security@mercavine.com |
| Regulators / state AGs | as required by law (Florida: 30 days if 500+ residents affected) | counsel |

Do not delay the Amazon notice to finish an investigation; send what is known
and update it.

## Standing controls (summary)

- TLS 1.3 everywhere, HSTS, CSP and hardening headers.
- Third-party credentials (Amazon refresh tokens, Shop tokens) encrypted with
  AES-256-GCM; Mercavine tokens and sessions stored only as SHA-256 hashes;
  passwords hashed with scrypt.
- Login lockout after 10 failed attempts per account and per IP.
- Error tracking and security alerts (Sentry), `/healthz` uptime checks.
- Nightly encrypted backups, 30-day retention, quarterly restore test.
- Account deletion completes within 30 days.
- Dependabot, CodeQL, `npm audit` gate in CI, OWASP ZAP scans, yearly pen test.
- MFA required on GitHub, Railway, Stripe, Resend, the domain registrar and
  Amazon accounts; devices lock after 15 minutes idle and use disk encryption.

## Review

Review this document and run a tabletop exercise at least once a year.
Last reviewed: October 16, 2026.
