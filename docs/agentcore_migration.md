# AgentCore Migration Plan

This document describes how to introduce Amazon Bedrock AgentCore into the Healthy Basket stack without disrupting the existing routing service. Follow the steps in order; each task can be validated independently.

## 0. Prerequisites
- AWS account with Bedrock Agents and Bedrock Runtime enabled in the target region (same region as existing Bedrock models).
- IAM role with permissions: `bedrock:*Agent*`, `bedrock:InvokeModel`, `bedrock:InvokeAgent`, `lambda:*`, `iam:PassRole`, `s3:*` (for artifacts), `logs:*`.
- AWS CLI v2.15+ and boto3 / AWS SDK for JavaScript v3 >= 3.468 installed.
- (Optional) Terraform or CloudFormation if you prefer IaC.

## 1. Define Agent Instructions & Memory
1. Create an S3 bucket to host agent instruction files and action schemas, e.g. `healthy-basket-agentcore`. Enable versioning.
2. Draft the agent’s overarching prompt (`agentcore/policy_agent_instruction.txt`). Include responsibilities:
   - Analyse shopper query & preferences.
   - Request Elastic candidates via MCP/HTTP tool.
   - Call Haiku policy tool to select LLM.
   - Invoke Titan/Sonnet/Nova tools.
   - Enforce guardrails (fallbacks, availability notes).
   - Emit structured response (products, reasoning, metrics).
3. Upload the instruction file to S3 (keep URL handy).

## 2. Model Tooling via Lambda Action Groups
AgentCore exposes tools through “action groups”. Create one Lambda per capability so the agent can call the existing Node service logic without refactoring it away immediately.

| Capability | Lambda entry point | Notes |
|------------|-------------------|-------|
| `elasticSearchTopN` | `lambda/elastic_search/index.mjs` | Proxy to existing MCP product tool. Input: query, size, preferences. Output: product array + metadata. |
| `policyHeuristic` | Reuse `analyseQueryContext` & `computeComplexityScore` to compute signals for Haiku. |
| `haikuPolicy` | Proxy Haiku invocation (returns action + complexity). |
| `invokeSonnet` / `invokeTitanExpress` / `invokeNovaPremier` | Reuse existing `reasonWith…` helpers to call each model. |
| `logPolicyDecision` | POST to existing Elastic/Kibana logging endpoint. |

Implementation steps:
1. Create a new folder `lambda/` with minimal handler wrappers that import from `server/src` (or replicate logic). Use a shared layer (`nodejs14.x`+).
2. Each Lambda returns JSON matching the AgentCore action schema. Store schema files in `agentcore/schemas/` and upload them to S3.
   - Example provided: `agentcore/schemas/elasticSearchTopN.json` → upload to `s3://$HB_BUCKET/schemas/elasticSearchTopN.json`.
3. Grant Lambdas permission to call Bedrock models, Elastic MCP endpoints, and CloudWatch logs.
4. Use `scripts/build_lambda.sh` to compile and zip the Lambda bundle (`dist/elastic_search.zip`) before uploading.

## 3. Register the Agent with AWS CLI
1. Create an agent:
   ```bash
   aws bedrock create-agent \
     --agent-name healthy-basket-router \
     --foundation-model anthropic.claude-3-haiku-20240307-v1:0 \
     --instruction-file-s3uri s3://healthy-basket-agentcore/policy_agent_instruction.txt \
     --customer-encryption-key <kms-arn>
   ```
2. For each Lambda/tool, create an action group:
   ```bash
   aws bedrock create-agent-action-group \
     --agent-id <agent-id> \
     --description "Elastic search tool" \
     --action-group-name elasticSearchTopN \
     --action-group-executor "lambda": {"lambdaArn": "<lambda-arn>"} \
     --api-schema s3://healthy-basket-agentcore/schemas/elasticSearchTopN.json
   ```
3. Publish the agent and create an alias:
   ```bash
   aws bedrock prepare-agent --agent-id <agent-id>
   aws bedrock create-agent-alias --agent-id <agent-id> --alias-name prod
   ```

## 4. Integrate AgentCore into the Node Service
Keep existing code as default path; add a feature flag (`USE_AGENTCORE=true`) to switch.

1. Add a new module `server/src/agentcoreClient.js`:
   - Use `@aws-sdk/client-bedrock-agent-runtime`.
   - Implement `invokePolicyAgent({ query, preferences, size })` that calls `InvokeAgent` with the same inputs the server currently uses.
   - Parse the response (AgentCore returns tool outputs and final JSON content). Map the payload back into the existing `AssistantResponse` shape.
2. In `index.js`, behind the flag, swap the body of the `/api/assistant` handler to call `invokePolicyAgent` instead of running the local orchestration.
3. Log request/response IDs, latency, and the agent alias used.

## 5. Observability & Cost
1. Enable AgentCore traces in the Bedrock console to view each tool invocation.
2. Extend CloudWatch dashboard to include `AWS/Bedrock` metrics filtered by `OperationName=InvokeAgent`.
3. If using custom metrics (EstimatedCostEUR, etc.), emit them from the Lambda tools or from the Node service after `InvokeAgent` returns.

## 6. Rollout Strategy
1. Start canary traffic (e.g., `USE_AGENTCORE=true` for a single staging environment).
2. Compare policy decisions/cost vs. existing implementation using logs and dashboards.
3. Once validated, promote the agent alias to production and eventually retire the legacy path.

## Useful References
- [Agents for Amazon Bedrock – Developer Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html)
- [AgentCore sample action schema](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-action-groups.html)
- AWS CLI `bedrock` commands for automation.

Keep this file updated as you progress. Each completed section should have linked IAM/Lambda/Agent IDs to aid troubleshooting.
