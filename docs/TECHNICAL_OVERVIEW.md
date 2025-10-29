# Healthy Basket — Technical Overview

Audience: Software Engineers and Solution Architects

This document describes the system architecture, runtime behavior, configuration, and operational concerns for the Healthy Basket assistant. It is optimized for quick comprehension by engineers and architects responsible for design, implementation, and operations.

## 1. System Overview

- Purpose: Smart grocery assistant that blends Elastic MCP search with Amazon Bedrock reasoning. Returns products + promotions with explainable reasoning.
- Modalities:
  - Legacy in‑app orchestration (Node/Express proxy).
  - Fully managed AgentCore orchestration (optional).
  - Hybrid policy routing (Haiku or heuristics) with guardrails and availability downgrades.

Key repos/dirs:
- `server/` Node/Express API + orchestration.
- `client/` React + Vite front‑end.
- `lambda/` Lambda wrappers for AgentCore action groups.
- `agentcore/` Agent instruction + action schemas.
- `data/` Synthetic dataset and importer.
- `docs/` Architecture notes and diagrams.

Primary diagrams:
- `architecture_overview.pdf/png` (topology)
- `policy_flowchart.pdf/png` (policy decision flow)

## 2. Architecture Components

- Client (Vite + React): UI to compose intents, toggle routing modes, set dietary filters, and visualize reasoning.
- Server (Node/Express):
  - MCP client: JSON‑RPC to Elastic MCP tools for products/promotions.
  - Policy router: Haiku model (if available) or heuristics.
  - Reasoning orchestrator: Bedrock Sonnet/Titan/Nova integration (with fallbacks/guardrails).
  - Logging: policy decisions to Elastic index.
- Elastic Cloud:
  - MCP endpoint: exposes custom tools (`healthy_basket_products`, `healthy_basket_promotions`).
  - Indices: products, promotions; `policy-decisions` for logging.
- Amazon Bedrock:
  - Policy model: Claude Haiku.
  - Reasoning models: Claude Sonnet, Titan Text Express, Nova Premier.
- AgentCore (optional):
  - Agent + action groups (Lambdas calling MCP/tools/reasoners).

## 3. Request Lifecycle

1. UI sends `POST /api/assistant` with fields:
   - `nlQuery`, `preferences.dietaryTags`, `rerank`, `useBedrock` (force Sonnet), `policyMode` (semi/fully), `useAgentCore`.
2. If `useAgentCore=true` and configured, server delegates to AgentCore via `InvokeAgent` and returns the agent’s JSON.
3. Otherwise, server flow:
   - Policy routing: `decidePolicy()` uses Haiku (if configured) else heuristics to produce an action (`elastic_only`, `elastic_plus_sonnet`, `elastic_plus_titan_express`, `elastic_plus_titan_premier`, `reject_out_of_domain`). Guardrails/downgrades applied by availability and complexity thresholds.
   - MCP: call product + promotion tools, flatten and normalize.
   - Preference filtering: strict dietary filters; fallback to broader results if zero matches.
   - Ranking: heuristic rerank by tokens/health/savings; apply model ranking if provided.
   - Reasoning: if advanced model chosen, call the target model; else return deterministic heuristic summary/details.
   - Logging: post policy decision (query, prefs, action/resolvedAction, confidence, reason, complexity, final model) to Elastic index.
4. Response shape: `AssistantResponse` with `products`, `promotions`, `reasoning` (summary/details/origin), and `meta` (policy/engine/budget/preference signals).

## 4. Policy Routing and Guardrails

- Modes:
  - Semi‑managed: server computes heuristic complexity; Haiku optional.
  - Fully‑managed: Haiku computes complexity and action; server still enforces guardrails/downgrades.
- Guardrails:
  - Very short queries (≤ 2 core tokens) without dietary filters → `elastic_only` unless Sonnet is forced.
  - Complexity < 5 disallows Express; Complexity < 8 disallows Premier.
  - If target endpoint unavailable → downgrade (Premier → Express → Sonnet → Elastic).
- Force Sonnet toggle: if user sets `useBedrock=true`, route to Sonnet when meaningful/available.

Implementation:
- `server/src/policy.js` builds a system prompt for Haiku; expects compact JSON `{ action, confidence, notes, complexity }`.
- `server/src/index.js` applies availability checks + guardrail thresholds and records `policyDecision` in meta and logs.
- AgentCore alternative: `agentcore/policy_agent_instruction.txt` is the agent’s system prompt (plan, tools, guardrails, final JSON schema).

## 5. Data and MCP Tools

- Products and promotions are obtained from Elastic MCP tools.
- Normalization merges common fields: `name`, `brand`, `category`, `price`, `regularPrice`, `nutrition`, `dietary_tags`, `promotionIds`.
- Dataset and importer:
  - Synthetic catalog: `data/healthy_basket_dataset.json`.
  - Importer: `import_to_elastic.py` uses `_bulk` to index products/promotions.

## 6. Server API

- `GET /api/health` → `{ status: "ok", mcpConfigured: boolean }`.
- `POST /api/assistant` (main entry): returns `AssistantResponse`.
- `POST /api/mcp/tool` → call a specific MCP tool `{ name, args }` and return raw result (debugging utility).

Code location: `server/src/index.js`.

## 7. Reasoning Integrations

- Sonnet (`reasonWithBedrock`): injects top‑K product snapshot; expects JSON `{ summary, details, product_ranking? }`. If disabled/unavailable, returns heuristic summary.
- Titan/Nova (`reasonWithTitan`): supports Text Express invoke and Nova Premier converse; robust JSON repair; same contract as Sonnet.
- Ranking merge: `applyBedrockRanking()` reorders candidates by id/name and optional scores.

## 8. Front‑End

- React + Tailwind; Vite dev server.
- Key components:
  - `IntentComposer`: query input + budget/household sliders + presets.
  - `PreferenceToolbar`: dietary filters and clear.
  - `AssistantView`: badges for engines/policy; products grid; reasoning panel.
  - `InsightsPanel`: averages, budget stats, and focus details.
  - `ConversationDock`: replay timeline.
- Hook: `useAssistant` wraps fetch + abort + local history.

## 9. Configuration and Secrets

Environment variables (see `server/.env.example`):
- Elastic MCP
  - `MCP_URL` (required): MCP JSON‑RPC endpoint.
  - `MCP_API_KEY` (required): Elastic ApiKey.
  - `MCP_PRODUCT_TOOL`, `MCP_PROMOTION_TOOL` (optional; defaults provided).
- HTTP server
  - `PORT` (default 5050).
- Bedrock policy & reasoning
  - `BEDROCK_REGION` (required to enable Bedrock SDK).
  - `BEDROCK_POLICY_MODEL_ID` (Haiku); enables model‑based policy.
  - `BEDROCK_MODEL_ID` or `BEDROCK_INFERENCE_PROFILE_ARN` (Sonnet).
  - `BEDROCK_TITAN_EXPRESS_MODEL_ID`, `BEDROCK_TITAN_PREMIER_MODEL_ID` (Nova Premier may be ARN/profile).
- Policy logging
  - `POLICY_LOG_URL` (defaults to MCP origin).
  - `POLICY_LOG_API_KEY` (defaults to `MCP_API_KEY`).
  - `POLICY_LOG_INDEX` (default `policy-decisions`).
- AgentCore (optional)
  - `AGENTCORE_ENABLED`, `AGENTCORE_AGENT_ID`, `AGENTCORE_AGENT_ALIAS_ID`, `AGENTCORE_REGION`, `AGENTCORE_DEFAULT_POLICY_MODE`.

Secrets hygiene:
- Keep `.env` files out of version control (repo `.gitignore` already excludes them).
- Use AWS standard credential resolution for Bedrock where possible.

## 10. Local Development

Install:
- `cd server && npm install`
- `cd client && npm install`

Run:
- `cd server && npm run dev` → http://127.0.0.1:5050
- `cd client && npm run dev` → http://127.0.0.1:5173

Logs:
- Server: `/tmp/healthy-basket-server.log` (when launched via helper scripts).
- Client: `/tmp/healthy-basket-client.log`.

Common pitfalls:
- Port conflicts (5050/5173): stop other dev servers before launching.
- Rollup optional dep error: wipe client `node_modules` + `package-lock.json` and reinstall.

## 11. AgentCore Deployment (Optional)

Objectives:
- Migrate orchestration to AgentCore while preserving behavior.

Steps (high level):
1. Prepare instruction and schemas:
   - Upload `agentcore/policy_agent_instruction.txt` and action schemas (`agentcore/schemas/*.json`) to S3.
2. Lambdas for action groups:
   - `lambda/*` provide wrappers for: Elastic search, Haiku policy, Sonnet, Titan, logging.
3. Create/prepare agent + action groups + aliases (AWS CLI or console).
4. Server integration:
   - Provide `AGENTCORE_*` env; enable toggle in UI and route requests via `invokeAgentCore`.

Reference: `docs/agentcore_migration.md`.

## 12. Observability & Telemetry

- Policy decisions: posted to Elastic index (`policy-decisions` by default).
- In‑app meta: the response `meta` reveals action, resolvedAction, complexity, and final reasoning model.
- AgentCore: inspect Agent traces in Bedrock console.

## 13. Security Considerations

- Secrets reside in `.env` (excluded from VCS) or AWS credentials chain.
- Requests to Elastic use ApiKey auth; requests to Bedrock use AWS SDK credentials.
- Client makes only calls to the local API; CORS is not exposed in dev mode.

## 14. Testing & Validation

- MCP connectivity: `test_mcp_connection.py` (initialise + optional tool calls).
- Data seeding: `import_to_elastic.py` to seed indices for demo/testing.
- Manual E2E:
  - Exercise French queries of varying complexity (see README suggestions) and check `meta.policyDecision`.
  - Verify logging documents appear in `policy-decisions` with proper fields.

## 15. Troubleshooting

- Port 5050 in use: stop other servers using `lsof -tiTCP:5050 -sTCP:LISTEN | xargs kill`.
- Vite refuses to start: reinstall deps; ensure Node >= 18.
- No products returned: verify MCP URL/Key, tool names, and that indices contain data.
- No policy logs: check `POLICY_LOG_URL`/`POLICY_LOG_API_KEY` and that `policy-decisions` index exists.

## 16. Known Limitations

- Reasoning JSON parsing is resilient but may require prompt adjustments if models drift.
- Policy logging defaults to MCP origin if `POLICY_LOG_URL` is not set; multi‑tenant logging may require a dedicated endpoint.
- Synthetic dataset is limited; production relevance requires real merchant data and MCCP mapping.

## 17. Roadmap (Highlights)

- Expand reasoning prompts for structured ranking, budget justification, and nutrition rationale.
- Cache MCP lookups and introduce product enrichment pipeline (nutrition tables, images).
- Add authentication + saved profiles (allergens, budget, loyalty).
- IaC for AgentCore/Lambdas (CDK/Terraform) and CI workflows.

