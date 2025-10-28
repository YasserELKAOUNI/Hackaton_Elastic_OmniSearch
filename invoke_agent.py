import json
import boto3

client = boto3.client("bedrock-agent-runtime", region_name="us-east-1")

response = client.invoke_agent(
    agentId="G94IJVP5FL",
    agentAliasId="GDSAQJNM6T",
    sessionId="test-1",
    inputText="Healthy breakfast for kids under €10"
)

# The response is a stream of events. Collect the completion blocks.
chunks = []
for event in response.get("completion", []):
    if "content" in event:
        text = event["content"][0].get("text")
        if text:
            chunks.append(text)

print("".join(chunks))
