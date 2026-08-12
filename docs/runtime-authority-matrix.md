# Pilot runtime authority matrix

Every role is owned by the independent `pilot-iam` state. The main pilot root
accepts exact validated role ARNs and never creates IAM. Secret containers are
empty until a separately approved human checkpoint supplies a value.

| Consumer role | Allowed | Explicitly forbidden |
|---|---|---|
| Webhook Lambda | Read only the webhook secret at `AWSCURRENT`; send callback FIFO messages; write ingress logs | Database, command receive, projections, provider keys, deployment |
| Operator Lambda | Send command FIFO messages; conditionally read/write the coordination table; write operator logs | Secrets, callback receive, GitHub/OpenAI, deployment |
| Worker execution | Pull only the worker ECR repository; write worker logs | Application secrets, queues, DynamoDB, GitHub/OpenAI |
| Workflow worker | Receive/delete/extend command and callback messages; conditional coordination access; read only the RDS-managed secret | ECR publication, provider secrets, IAM, deployment |
| Migration execution | Pull only the worker image; read only the RDS-managed secret for ECS injection; write worker logs | Queues, projections, provider secrets, deployment |
| Migration task | No AWS API permissions | All AWS mutations and provider credentials |
| GitHub builder/reviewer/merger | Each reads only its role-specific App key | Other App keys, OpenAI keys, deployment, IAM |
| Portal OpenAI builder/reviewer | Each reads only its target-and-stage-specific OpenAI key | GitHub keys, the other OpenAI key, deployment |
| Orchestrator OpenAI reviewer | Reads only the orchestrator reviewer key | Portal keys, GitHub keys, deployment |

The sole resource-wide permission is `ecr:GetAuthorizationToken` on `*`, which
AWS requires before a scoped repository pull. It grants no repository read or
write. There are no wildcard secret resources, wildcard actions, access keys,
`iam:PassRole`, provider publication, review, merge, or deployment permissions.

## Rotation and emergency disablement

Populate and rotate values outside Terraform. Add a new version as
`AWSCURRENT`, run the role-specific preflight, then revoke the previous external
credential. Never copy a value between role or target containers. On suspected
exposure, stop the consuming Lambda/task, remove its secret access or disable
the external credential, retain CloudTrail request IDs and policy digests, and
rotate before re-enabling. Evidence contains only sanitized role/secret ARNs,
version stages, request IDs, and decisions—never secret contents.
