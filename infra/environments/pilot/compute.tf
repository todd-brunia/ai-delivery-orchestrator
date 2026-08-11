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

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512

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

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = 2
  min_capacity       = 0
  resource_id        = "service/${aws_ecs_cluster.worker.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
