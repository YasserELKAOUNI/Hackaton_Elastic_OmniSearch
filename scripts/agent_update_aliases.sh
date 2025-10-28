#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   HB_AGENT_ID=G94IJVP5FL \
#   HB_REGION=us-east-1 \
#   HB_VERSION=6 \
#   HB_TEST_ALIAS=TSTALIASID \
#   HB_PROD_ALIAS=ZVN7OOWST1 \
#   ./scripts/agent_update_aliases.sh
#
# HB_VERSION may also be passed as the first positional argument.

export AWS_PAGER=""

REGION="${HB_REGION:-us-east-1}"
AGENT_ID="${HB_AGENT_ID:?Set HB_AGENT_ID to the target AgentCore ID}"
VERSION="${HB_VERSION:-${1:-}}"
TEST_ALIAS="${HB_TEST_ALIAS:-TSTALIASID}"
PROD_ALIAS="${HB_PROD_ALIAS:-ZVN7OOWST1}"

if [[ -z "${VERSION}" ]]; then
  echo "HB_VERSION (or positional argument) is required." >&2
  exit 1
fi

lookup_alias_name() {
  local alias_id="$1"
  aws bedrock-agent list-agent-aliases \
    --region "${REGION}" \
    --agent-id "${AGENT_ID}" \
    --query "agentAliasSummaries[?agentAliasId=='${alias_id}'].agentAliasName | [0]" \
    --output text
}

update_alias() {
  local alias_id="$1"
  local label="$2"

  if [[ -z "${alias_id}" || "${alias_id}" == "None" ]]; then
    echo "Skipping ${label}; alias id not provided."
    return
  fi

  local alias_name
  alias_name="$(lookup_alias_name "${alias_id}")"

  if [[ -z "${alias_name}" || "${alias_name}" == "None" ]]; then
    echo "Alias ${alias_id} not found; skipping ${label}."
    return
  fi

  aws bedrock-agent update-agent-alias \
    --region "${REGION}" \
    --agent-id "${AGENT_ID}" \
    --agent-alias-id "${alias_id}" \
    --agent-alias-name "${alias_name}" \
    --agent-version "${VERSION}" \
    >/dev/null

  echo "Updated ${label} alias (${alias_id} - ${alias_name}) to version ${VERSION}"
}

update_alias "${TEST_ALIAS}" "test"
update_alias "${PROD_ALIAS}" "prod"

echo "Current aliases:"
aws bedrock-agent list-agent-aliases \
  --region "${REGION}" \
  --agent-id "${AGENT_ID}" \
  --query 'agentAliasSummaries[].{alias:agentAliasId,name:agentAliasName,version:agentVersion}'
