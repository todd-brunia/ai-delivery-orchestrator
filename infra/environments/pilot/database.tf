resource "aws_db_subnet_group" "application" {
  name       = "${local.name}-database"
  subnet_ids = values(aws_subnet.isolated)[*].id
  tags       = merge(local.tags, { Name = "${local.name}-database" })
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "Aurora ingress from explicitly supplied runtime security groups only"
  vpc_id      = aws_vpc.main.id

  egress = []
  tags   = merge(local.tags, { Name = "${local.name}-database" })
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  for_each                     = var.database_client_security_group_ids
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from reviewed runtime consumer ${each.key}"
}

resource "aws_rds_cluster" "application" {
  cluster_identifier              = local.name
  engine                          = "aurora-postgresql"
  engine_version                  = var.aurora_engine_version
  engine_mode                     = "provisioned"
  database_name                   = "orchestrator"
  master_username                 = "orchestrator_admin"
  manage_master_user_password     = true
  storage_encrypted               = true
  db_subnet_group_name            = aws_db_subnet_group.application.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  backup_retention_period         = var.database_backup_retention_days
  preferred_backup_window         = "07:00-08:00"
  preferred_maintenance_window    = "sun:08:00-sun:09:00"
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  copy_tags_to_snapshot           = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }

  tags = local.tags
}

resource "aws_rds_cluster_instance" "application" {
  identifier           = "${local.name}-writer"
  cluster_identifier   = aws_rds_cluster.application.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.application.engine
  engine_version       = aws_rds_cluster.application.engine_version
  db_subnet_group_name = aws_db_subnet_group.application.name
  publicly_accessible  = false
  tags                 = local.tags
}
