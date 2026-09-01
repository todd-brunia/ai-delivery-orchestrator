resource "aws_ecs_cluster" "worker" {
  name = "${local.name}-worker"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Private worker tasks"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-worker" })
}

resource "aws_vpc_security_group_ingress_rule" "database_worker" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from worker tasks"
}

resource "aws_vpc_security_group_egress_rule" "worker_database" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.database.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL to pilot database"
}

resource "aws_vpc_security_group_egress_rule" "worker_private_endpoints" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.private_endpoints.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "TLS to pilot private endpoints"
}

resource "aws_vpc_security_group_egress_rule" "worker_s3_gateway" {
  security_group_id = aws_security_group.worker.id
  prefix_list_id    = data.aws_prefix_list.s3.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "TLS to regional S3 gateway endpoint for ECR image layers"
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.worker_execution_role_arn
  task_role_arn            = var.worker_task_role_arn
  skip_destroy             = true

  container_definitions = jsonencode([{
    name        = "worker"
    image       = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_sha}"
    essential   = true
    stopTimeout = 60
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PROVIDER_MODE", value = "stub" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application["worker"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
  tags = local.tags
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.worker.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = values(aws_subnet.isolated)[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  lifecycle { ignore_changes = [desired_count] }
  tags = local.tags
}

resource "aws_security_group" "supervised_dispatch" {
  name        = "${local.name}-supervised-dispatch"
  description = "Ephemeral supervised dispatch task with no inbound rules"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-supervised-dispatch" })
}

resource "aws_vpc_security_group_egress_rule" "supervised_dispatch_https" {
  security_group_id = aws_security_group.supervised_dispatch.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS to canonical GitHub, OpenAI, and AWS APIs"
}

resource "aws_vpc_security_group_egress_rule" "supervised_dispatch_database" {
  security_group_id            = aws_security_group.supervised_dispatch.id
  referenced_security_group_id = aws_security_group.database.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL to pilot database"
}

resource "aws_vpc_security_group_ingress_rule" "database_supervised_dispatch" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.supervised_dispatch.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from ephemeral supervised dispatch task"
}

resource "aws_ecs_task_definition" "supervised_dispatch" {
  family                   = "${local.name}-supervised-dispatch"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.supervised_dispatch_execution_role_arn
  task_role_arn            = var.supervised_dispatch_task_role_arn
  skip_destroy             = true
  container_definitions = jsonencode([{
    name                   = "supervised-dispatch"
    image                  = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_sha}"
    essential              = true
    command                = ["node", "dist/runtime/v1/supervised-dispatch-cli.js"]
    readonlyRootFilesystem = true
    user                   = "10001:10001"
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "SUPERVISED_DISPATCH_ENABLED", value = "false" },
      { name = "GITHUB_REPOSITORY_ID", value = var.supervised_repository_id },
      { name = "GITHUB_APP_ID", value = var.supervised_github_app_id },
      { name = "GITHUB_INSTALLATION_ID", value = var.supervised_github_installation_id },
      { name = "GITHUB_INSTALLATION_ACCOUNT", value = var.supervised_github_installation_account },
      { name = "OPENAI_PROJECT_ID", value = var.supervised_openai_project_id },
      { name = "PGHOST", value = aws_rds_cluster.application.endpoint },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = "orchestrator" },
      { name = "REPOSITORY_ADAPTER_JSON", value = jsonencode({
        version             = 1, repository = "todd-brunia/ai-consulting-client-portal", defaultBranch = "main", enabled = true,
        orchestratorAppSlug = "ai-delivery-orchestrator",
        workflows           = { implementation = "implementation.yml", repair = "repair.yml", sync = "sync.yml" },
        labels              = { needsPlanning = "needs-planning", planReady = "plan-ready", approvedForBuild = "approved-for-build", approvedForAiBuild = "approved-for-ai-build", inProgress = "in-progress", previewReady = "preview-ready", needsDecision = "needs-decision", blocked = "blocked" },
        requiredChecks      = ["CI Gate"], maxParallelImplementations = 1,
        risk                = { humanApprovalCategories = ["security", "authentication", "secrets", "infrastructure", "destructive_data", "billing", "workflow_policy", "external_communication"], humanApprovalLabels = ["approved-for-build"], humanApprovalPathPatterns = [".github/**"] }
      }) }
    ]
    secrets = [
      { name = "PGUSER", valueFrom = "${aws_rds_cluster.application.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_rds_cluster.application.master_user_secret[0].secret_arn}:password::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application["worker"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "supervised-dispatch"
      }
    }
  }])
  tags = local.tags
}

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = 2
  min_capacity       = 0
  resource_id        = "service/${aws_ecs_cluster.worker.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.migration_execution_role_arn
  task_role_arn            = var.migration_task_role_arn
  skip_destroy             = true
  container_definitions = jsonencode([{
    name      = "migration"
    image     = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_sha}"
    essential = true
    command   = ["node", "dist/persistence/migrate-cli.js"]
    environment = [
      { name = "PGHOST", value = aws_rds_cluster.application.endpoint },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = "orchestrator" },
      { name = "PGSSLMODE", value = "require" },
      { name = "MIGRATION_IMAGE_SHA", value = var.worker_image_sha }
    ]
    secrets = [
      { name = "PGUSER", valueFrom = "${aws_rds_cluster.application.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_rds_cluster.application.master_user_secret[0].secret_arn}:password::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application["worker"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
  tags = local.tags
}
