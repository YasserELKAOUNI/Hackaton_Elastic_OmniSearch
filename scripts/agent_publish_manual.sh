#!/usr/bin/env bash
set -euo pipefail

# This script walks through the AgentCore deployment using current AWS CLI capabilities.
# Requirements:
#   - AWS CLI configured for the Bedrock account (region typically us-east-1).
#   - S3 bucket already created to host the instruction file.
#
# Usage example:
#   HB_BUCKET=healthy-basket-agentcore-975050203092 \
#   HB_BUCKET_REGION=eu-west-3 \
#   HB_AGENT_ID=G94IJVP5FL \
#   HB_REGION=us-east-1 \
#   ./scripts/agent_publish_manual.sh

export AWS_PAGER=""

LOCAL_FILE="${HB_INSTRUCTION_FILE:-agentcore/policy_agent_instruction.txt}"
REGION="${HB_REGION:-us-east-1}"
BUCKET="${HB_BUCKET:?Set HB_BUCKET to the S3 bucket hosting agent assets}"
BUCKET_REGION="${HB_BUCKET_REGION:-${REGION}}"
AGENT_ID="${HB_AGENT_ID:?Set HB_AGENT_ID to the target AgentCore ID}"
INSTRUCTION_KEY="${HB_INSTRUCTION_KEY:-policy_agent_instruction.txt}"
TEST_ALIAS="${HB_TEST_ALIAS:-TSTALIASID}"
PROD_ALIAS="${HB_PROD_ALIAS:-ZVN7OOWST1}"

echo "Step 1/6: Uploading ${LOCAL_FILE} to s3://${BUCKET}/${INSTRUCTION_KEY}"
aws s3api put-object \
  --bucket "${BUCKET}" \
  --key "${INSTRUCTION_KEY}" \
  --body "${LOCAL_FILE}" \
  --region "${BUCKET_REGION}"

echo "Step 2/6: Fetching agent metadata"
AGENT_NAME="$(aws bedrock-agent get-agent \
  --region "${REGION}" \
  --agent-id "${AGENT_ID}" \
  --query 'agent.agentName' \
  --output text)"

FOUNDATION_MODEL="$(aws bedrock-agent get-agent \
  --region "${REGION}" \
  --agent-id "${AGENT_ID}" \
  --query 'agent.foundationModel' \
  --output text)"

AGENT_ROLE_ARN="$(aws bedrock-agent get-agent \
  --region "${REGION}" \
  --agent-id "${AGENT_ID}" \
  --query 'agent.agentResourceRoleArn' \
  --output text)"

if [[ -z "${AGENT_NAME}" || "${AGENT_NAME}" == "None" ]]; then
  echo "Unable to resolve agent name; aborting." >&2
  exit 1
fi

if [[ -z "${FOUNDATION_MODEL}" || "${FOUNDATION_MODEL}" == "None" ]]; then
  echo "Unable to resolve foundation model; aborting." >&2
  exit 1
fi

echo "Step 3/6: Updating agent draft ${AGENT_ID} in ${REGION}"
UPDATE_ARGS=(
  --region "${REGION}"
  --agent-id "${AGENT_ID}"
  --agent-name "${AGENT_NAME}"
  --foundation-model "${FOUNDATION_MODEL}"
  --instruction "file://${LOCAL_FILE}"
)

if [[ -n "${AGENT_ROLE_ARN}" && "${AGENT_ROLE_ARN}" != "None" ]]; then
  UPDATE_ARGS+=(--agent-resource-role-arn "${AGENT_ROLE_ARN}")
fi

aws bedrock-agent update-agent "${UPDATE_ARGS[@]}"

echo "Step 4/6: Preparing draft version"
aws bedrock-agent prepare-agent \
  --region "${REGION}" \
  --agent-id "${AGENT_ID}" \
  >/dev/null

echo "Waiting for agent status to reach PREPARED..."
while true; do
  STATUS="$(aws bedrock-agent get-agent \
    --region "${REGION}" \
    --agent-id "${AGENT_ID}" \
    --query 'agent.agentStatus' \
    --output text)"
  case "${STATUS}" in
    PREPARED)
      echo "Agent is PREPARED."
      break
      ;;
    FAILED)
      echo "Agent preparation failed; check Bedrock console for details." >&2
      exit 1
      ;;
    *)
      sleep 8
      ;;
  esac
done

cat <<'EONOTE'
Step 5/6: Publish a new version manually.
  1. Open the AWS console → Amazon Bedrock → Agent orchestrations.
  2. Select your agent (healthy-basket-router).
  3. Click “Publish new version” and wait for completion.
  4. Note the numeric version that was created (for example, 6).

When you have the version number, return here and enter it below.
EONOTE

read -p "Enter the published version number: " NEW_VERSION

if [[ -z "${NEW_VERSION}" ]]; then
  echo "No version provided; skipping alias updates." >&2
  exit 0
fi

echo "Step 6/6: Updating agent aliases to version ${NEW_VERSION}"

update_alias() {
  local alias_id="$1"
  local label="$2"
  local alias_name=""
  if [[ -z "${alias_id}" || "${alias_id}" == "None" ]]; then
    echo "Skipping ${label} alias; no ID configured."
    return
  fi

  alias_name="$(aws bedrock-agent list-agent-aliases \
    --region "${REGION}" \
    --agent-id "${AGENT_ID}" \
    --query "agentAliasSummaries[?agentAliasId=='${alias_id}'].agentAliasName | [0]" \
    --output text)"

  if [[ -z "${alias_name}" || "${alias_name}" == "None" ]]; then
    echo "Alias ID ${alias_id} not found. Skipping ${label} alias."
    return
  fi

  aws bedrock-agent update-agent-alias \
    --region "${REGION}" \
    --agent-id "${AGENT_ID}" \
    --agent-alias-name "${alias_name}" \
    --agent-alias-id "${alias_id}" \
    --agent-version "${NEW_VERSION}" \
    >/dev/null
  echo "Updated ${label} alias (${alias_id}) to version ${NEW_VERSION}"
}

update_alias "${TEST_ALIAS}" "test"
update_alias "${PROD_ALIAS}" "prod"

echo "Done. Verify aliases:"
aws bedrock-agent list-agent-aliases \
  --region "${REGION}" \
  --agent-id "${AGENT_ID}" \
  --query 'agentAliasSummaries[].{alias:agentAliasId,version:agentVersion}'
