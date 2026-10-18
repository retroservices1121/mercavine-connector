# Security testing

| Control | Where | Cadence |
|---|---|---|
| Dependency updates | Dependabot (`.github/dependabot.yml`): npm, GitHub Actions, Docker | weekly |
| Known-vulnerability gate | `npm audit --omit=dev --audit-level=high` in `.github/workflows/security-ci.yml` | every PR, push, daily |
| Static analysis (SAST) | CodeQL `security-extended` (`.github/workflows/codeql.yml`) | every PR, push, weekly |
| Dynamic scan (DAST), site + API | OWASP ZAP baseline + API scan (`scripts/zap-baseline.sh`) | monthly and before each major release |
| Penetration test | external tester, scope: web app, REST API, MCP endpoint, OAuth | yearly (SP-API DPP) |

## Running the ZAP scan

Locally against a dev server (`npm run dev`), then:

```sh
scripts/zap-baseline.sh                         # local
scripts/zap-baseline.sh https://mercavine.com   # production, passive only
```

`zap-api-scan.py -S` uses the OpenAPI spec at `/api/v1/openapi.json` so the
REST API is covered, not just crawlable pages. Triage FAIL/WARN items, fix or
document accepted risks, and keep the reports (`zap-reports/`, gitignored) as
evidence for Amazon's security questionnaire.

## Enable in GitHub

Settings, then Code security: turn on Dependabot alerts, Dependabot security
updates, and secret scanning with push protection. CodeQL needs no further
setup for this public repo.
