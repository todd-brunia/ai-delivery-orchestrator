import { GetItemCommand, PutItemCommand, QueryCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { handleOperatorHttp, type OperatorHttpRequest, type OperatorHttpResponse } from "./handler.js";
import type { OperatorApiPort, OperatorCommand, OperatorReadResult } from "./contracts.js";

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
const required = (name: "ALLOWED_OPERATOR_PRINCIPAL_ARN" | "COMMAND_QUEUE_URL" | "COORDINATION_TABLE_NAME") => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function publish(command: OperatorCommand): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: required("COMMAND_QUEUE_URL"), MessageBody: JSON.stringify(command),
    MessageGroupId: command.route, MessageDeduplicationId: command.commandId,
  }));
}

const port: OperatorApiPort = {
  submit: async (command) => {
    const key = `${command.principalArn}:${command.route}:${command.idempotencyKey}`;
    const table = required("COORDINATION_TABLE_NAME");
    let selected = command;
    let duplicate = false;
    try {
      await dynamo.send(new PutItemCommand({ TableName: table, ConditionExpression: "attribute_not_exists(purposeKey)", Item: {
        purposeKey: { S: "operator-idempotency" }, entityKey: { S: key }, commandId: { S: command.commandId },
        principalArn: { S: command.principalArn }, route: { S: command.route }, idempotencyKey: { S: command.idempotencyKey },
        payloadSha256: { S: command.payloadSha256 }, payloadJson: { S: JSON.stringify(command.payload) },
      } }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
      const existing = await dynamo.send(new GetItemCommand({ TableName: table, ConsistentRead: true, Key: { purposeKey: { S: "operator-idempotency" }, entityKey: { S: key } } }));
      if (!existing.Item?.commandId?.S || existing.Item.payloadSha256?.S !== command.payloadSha256) {
        throw new Error("idempotency key reused with different request", { cause: error });
      }
      selected = { ...command, commandId: existing.Item.commandId.S };
      duplicate = true;
    }
    await publish(selected);
    return { commandId: selected.commandId, duplicate };
  },
  read: async ({ route, limit }) => {
    const result = await dynamo.send(new QueryCommand({
      TableName: required("COORDINATION_TABLE_NAME"),
      KeyConditionExpression: "purposeKey = :purpose",
      ExpressionAttributeValues: { ":purpose": { S: `operator-read:${route}` } },
      Limit: limit,
      ConsistentRead: true,
    }));
    const projectionAsOf = result.Items?.map((item) => item.projectionAsOf?.S).filter((value): value is string => Boolean(value)).sort().at(-1);
    return { source: "projection", ...(projectionAsOf ? { projectionAsOf } : {}), value: result.Items ?? [] } satisfies OperatorReadResult;
  },
};

interface ApiGatewayV2Event {
  readonly rawPath: string;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly requestContext?: { http?: { method?: string }; authorizer?: { iam?: { userArn?: string } } };
}

export async function handler(event: ApiGatewayV2Event): Promise<OperatorHttpResponse> {
  const request: OperatorHttpRequest = {
    method: event.requestContext?.http?.method ?? "",
    path: event.rawPath,
    headers: event.headers ?? {},
    ...(event.body === undefined ? {} : { body: event.body }),
    ...(event.requestContext?.authorizer?.iam?.userArn ? { principalArn: event.requestContext.authorizer.iam.userArn } : {}),
    ...(event.queryStringParameters ? { query: event.queryStringParameters } : {}),
  };
  return handleOperatorHttp(request, port, required("ALLOWED_OPERATOR_PRINCIPAL_ARN"));
}
