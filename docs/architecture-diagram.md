# Architecture diagram

This diagram is a learning-oriented view of the intended pilot architecture. It
separates the human governance path from the two runtime entry paths: operator
commands and GitHub callbacks. It does not imply that every integration is
enabled in every environment.

```mermaid
flowchart LR
  operator["Operator<br/>Codex, Bruno, or browser"]
  github["GitHub.com<br/>issues, plans, pull requests, webhooks"]
  openai["OpenAI"]

  subgraph aws["AWS pilot account"]
    gateway["API Gateway"]
    operatorLambda["Operator Lambda"]
    webhookLambda["GitHub Webhook Lambda"]

    commands["SQS FIFO<br/>commands"]
    callbacks["SQS FIFO<br/>callbacks"]
    dynamo[("DynamoDB<br/>idempotency, coordination,<br/>status projections")]
    postgres[("Aurora PostgreSQL<br/>authoritative workflow state,<br/>inbox/outbox, LangGraph checkpoints")]

    commandWorker["ECS Fargate<br/>command worker / LangGraph"]
    callbackIngress["ECS Fargate<br/>callback ingress"]
    callbackProcessor["ECS Fargate<br/>callback processor"]
    supervised["ECS Fargate<br/>supervised dispatch"]
  end

  operator -->|"B: manages issues, plans, and approvals"| github
  operator -->|"A: IAM-authorized operator request"| gateway
  github -->|"C: signed webhook"| gateway

  gateway -->|"/v1 operator routes"| operatorLambda
  gateway -->|"POST /github/webhooks"| webhookLambda

  operatorLambda -->|"idempotency and projection reads"| dynamo
  operatorLambda -->|"command"| commands
  webhookLambda -->|"normalized callback"| callbacks

  commands --> commandWorker
  callbacks --> callbackIngress
  callbackIngress -->|"durable inbox acceptance"| postgres
  callbackIngress <-->|"lifecycle coordination"| dynamo

  callbackProcessor -->|"claims inbox and commits transitions"| postgres
  callbackProcessor <-->|"lifecycle coordination"| dynamo
  callbackProcessor -->|"derived callback status"| dynamo
  callbackProcessor -->|"canonical reads"| github

  commandWorker -->|"authoritative state and checkpoints"| postgres
  commandWorker -->|"derived run status"| dynamo

  supervised -->|"authoritative state and checkpoints"| postgres
  supervised -->|"narrow GitHub App reads or approved actions"| github
  supervised -->|"feasibility analysis"| openai
```

## How to read it

- **B is human governance.** You use GitHub directly to create issues,
  milestones, plans, and approvals. Those human actions are distinct from
  machine processing.
- **C is event delivery.** GitHub sends a signed webhook to API Gateway. The
  webhook Lambda validates it before placing a normalized event on the
  callbacks queue.
- **PostgreSQL is authoritative.** Workflow state, legal transitions, inbox
  and outbox records, and LangGraph checkpoints live there.
- **DynamoDB supports speed and coordination.** It records request
  idempotency, callback-task lifecycle state, and derived status projections.
  A missing or stale projection must not override PostgreSQL.
- **The two SQS queues have different purposes.** The operator API emits
  commands; GitHub webhooks produce callbacks. Each queue has its own DLQ.
- **OpenAI is deliberately isolated.** Only the supervised-dispatch task may
  use it for feasibility analysis. Callback processing does not call OpenAI.
- **GitHub has both inbound and outbound arrows.** Webhooks enter through the
  callback path. Canonical reads and narrowly approved GitHub App operations
  leave only through bounded worker paths.

## Runtime availability

The diagram describes the intended pilot architecture and its authority
boundaries. It is not a claim that all arrows are currently live: ordinary
worker composition is stub-only, and provider access and callback processing
remain separately gated. See [Architecture](./architecture.md) for the
implemented contracts and current rollout boundaries.
