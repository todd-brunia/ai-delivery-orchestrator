# Architecture diagram

This diagram is a learning-oriented view of the intended pilot architecture. It
separates the human governance path from the two runtime entry paths: operator
commands and GitHub callbacks. It does not imply that every integration is
enabled in every environment.

```mermaid
flowchart LR
  operator["Operator<br/>Codex, Bruno, or browser"]

  subgraph githubBoundary["GitHub.com"]
    github["issues, plans, pull requests, webhooks"]
  end

  subgraph openaiBoundary["OpenAI"]
    openai["feasibility analysis API"]
  end

  github ~~~ openai

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

  operator -->|"manages issues, plans, and approvals"| github
  operator -->|"IAM-authorized operator request"| gateway
  github -->|"signed webhook"| gateway

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
  supervised -->|"feasibility request"| openai
  openai -->|"structured feasibility result"| supervised
```

## How to read it

- **Human governance is direct.** You use GitHub directly to create issues,
  milestones, plans, and approvals. Those human actions are distinct from
  machine processing.
- **Event delivery is signed.** GitHub sends a signed webhook to API Gateway. The
  webhook Lambda validates it before placing a normalized event on the
  callbacks queue.
- **PostgreSQL is authoritative.** Workflow state, legal transitions, inbox
  and outbox records, and LangGraph checkpoints live there.
- **DynamoDB supports speed and coordination.** It records request
  idempotency, callback-task lifecycle state, and derived status projections.
  A missing or stale projection must not override PostgreSQL.
- **The two SQS queues have different purposes.** The operator API emits
  commands; GitHub webhooks produce callbacks. Each queue has its own DLQ.
- **OpenAI is deliberately isolated.** The supervised-dispatch Fargate task
  sends feasibility requests to OpenAI and receives structured feasibility
  results. Callback processing does not call OpenAI.
- **GitHub has both inbound and outbound arrows.** Webhooks enter through the
  callback path. Canonical reads and narrowly approved GitHub App operations
  leave only through bounded worker paths.

## Milestone or epic lifecycle

Read these diagrams from top to bottom. Together they show the intended journey
from defining a milestone or epic to human-controlled completion. They describe
the authority boundaries, not an assertion that every runtime is currently
enabled.

### 1. Plan and approve the work

```mermaid
sequenceDiagram
  participant Operator
  participant GitHub as GitHub.com

  Operator->>GitHub: Create a milestone or epic, issues, and marked plans
  GitHub-->>Operator: Show the proposed scope and plan evidence
  Operator->>GitHub: Review and approve the plan
  Note over Operator,GitHub: Planning and approval remain direct human governance.
```

### 2. Submit and durably start an orchestrator run

```mermaid
sequenceDiagram
  participant Operator
  participant Gateway as API Gateway
  participant Lambda as Operator Lambda
  participant Dynamo as DynamoDB
  participant Commands as SQS FIFO commands
  participant Worker as Fargate command worker
  participant Aurora as Aurora PostgreSQL

  Operator->>Gateway: Submit an IAM-authorized command
  Gateway->>Lambda: Route the operator request
  Lambda->>Dynamo: Check idempotency and current projection
  alt Duplicate request
    Dynamo-->>Lambda: Return prior result
    Lambda-->>Operator: Return the prior command status
  else New request
    Lambda->>Commands: Enqueue one ordered command
    Commands->>Worker: Deliver the command
    Worker->>Aurora: Persist run state and LangGraph checkpoints
    Worker->>Dynamo: Publish derived run status
  end
```

### 3. Run the isolated feasibility and dispatch path

```mermaid
sequenceDiagram
  participant Operator
  participant Dispatch as Fargate supervised dispatch
  participant Aurora as Aurora PostgreSQL
  participant GitHub as GitHub.com
  participant OpenAI

  Operator->>Dispatch: Explicitly launch an owner-approved, bounded task
  Dispatch->>Aurora: Load immutable run, plan binding, and checkpoints
  Dispatch->>GitHub: Read canonical issue, plan, and approval evidence
  Dispatch->>OpenAI: Send feasibility request
  OpenAI-->>Dispatch: Return structured feasibility result
  Dispatch->>Aurora: Validate and durably record the decision
  alt Evidence, policy, or feasibility check fails
    Dispatch-->>Operator: Report a safe rejection and take no GitHub action
  else All checks and execution approval pass
    Dispatch->>GitHub: Perform the narrowly approved builder action
    Dispatch->>Aurora: Record the durable attempt and outbox state
  end
  Note over Dispatch,OpenAI: No other Fargate role calls OpenAI.
```

### 4. Process GitHub events without trusting delivery alone

```mermaid
sequenceDiagram
  participant GitHub as GitHub.com
  participant Gateway as API Gateway
  participant Webhook as GitHub Webhook Lambda
  participant Callbacks as SQS FIFO callbacks
  participant Ingress as Fargate callback ingress
  participant Aurora as Aurora PostgreSQL
  participant Processor as Fargate callback processor
  participant Dynamo as DynamoDB

  GitHub->>Gateway: Send signed webhook (for example, PR or CI update)
  Gateway->>Webhook: Route POST /github/webhooks
  Webhook->>Callbacks: Validate and enqueue normalized callback
  Callbacks->>Ingress: Deliver callback work
  Ingress->>Aurora: Durably accept the inbox event
  Ingress->>Dynamo: Coordinate the bounded lifecycle
  Processor->>Aurora: Claim the inbox event and current transition
  Processor->>GitHub: Re-read canonical state
  Processor->>Aurora: Commit the valid state transition
  Processor->>Dynamo: Publish derived callback status
  Note over Processor,GitHub: A webhook is a signal and canonical reads determine the outcome.
```

### 5. Review, merge, and complete the milestone

```mermaid
sequenceDiagram
  participant GitHub as GitHub.com
  participant Operator

  GitHub-->>Operator: Present pull request, checks, and current status
  Operator->>GitHub: Review the implementation and evidence
  alt Changes are needed
    Operator->>GitHub: Request changes or update the plan
    Note over Operator,GitHub: New GitHub events re-enter the callback sequence above.
  else Human approval is complete
    Operator->>GitHub: Merge the pull request
    Operator->>GitHub: Close completed issues and the milestone or epic
  end
  Note over Operator,GitHub: Merge and release remain human-controlled actions.
```

## Runtime availability

The diagram describes the intended pilot architecture and its authority
boundaries. It is not a claim that all arrows are currently live: ordinary
worker composition is stub-only, and provider access and callback processing
remain separately gated. See [Architecture](./architecture.md) for the
implemented contracts and current rollout boundaries.
