# Hygge cloud backend (Cloudflare)

Production home of the Hygge agent. One `UserSandbox` Durable Object
(with its own container, filesystem snapshot, encrypted credential
vault, and site memory) **per verified user**. D1 is the shared
control plane; the per-user Durable Object is the system of record.

## Environments

| Env | Worker | Config | Domain |
|---|---|---|---|
| staging | `hygge-api-staging` | `wrangler.staging.jsonc` | `api-staging.usehygge.app` |
| production | `hygge-api-production` | `wrangler.production.jsonc` | `api.usehygge.app` |

Separate config files per environment (not wrangler `env`): with
`env`, the container application does not bind to the env script's
Durable Object namespace. Always pass `-c <config>`.

## First-time staging provisioning

```bash
npm install
npx wrangler d1 create hygge-staging          # paste id into wrangler.staging.jsonc
npx wrangler r2 bucket create hygge-browser-profiles-staging   # browser-profile fallback storage
npx wrangler d1 migrations apply hygge-staging --remote -c wrangler.staging.jsonc
npx wrangler secret put HYGGE_LLM_API_KEY -c wrangler.staging.jsonc
npx wrangler secret put HYGGE_MASTER_KEY -c wrangler.staging.jsonc   # base64, 32 bytes
npx wrangler secret put HYGGE_DEV_TOKENS -c wrangler.staging.jsonc   # {"<token>":"<userId>"}
npx wrangler deploy -c wrangler.staging.jsonc   # run twice on first deploy (container app)
curl https://api-staging.usehygge.app/health
```

## Rules

- The user id comes from the verified credential, never the request.
- Passwords are encrypted at rest under a per-user DEK wrapped by
  the environment master key; plaintext only to type into a login
  form — never in prompts, logs, or responses.
- Sandbox snapshots are beta: durable truth lives in DO/D1/R2.
