locals {
  worker_interface_endpoints = toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager", "sqs"])
}

resource "aws_security_group" "private_endpoints" {
  name        = "${local.name}-private-endpoints"
  description = "TLS access to exact AWS private service endpoints from pilot workers"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-private-endpoints" })
}
resource "aws_vpc_security_group_ingress_rule" "private_endpoints_worker" {
  security_group_id            = aws_security_group.private_endpoints.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "TLS from worker and migration tasks"
}

resource "aws_vpc_endpoint" "worker_interface" {
  for_each            = local.worker_interface_endpoints
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = values(aws_subnet.isolated)[*].id
  security_group_ids  = [aws_security_group.private_endpoints.id]
  tags                = merge(local.tags, { Name = "${local.name}-${replace(each.key, ".", "-")}" })
}

resource "aws_vpc_endpoint" "worker_gateway" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.isolated.id]
  tags              = merge(local.tags, { Name = "${local.name}-${each.key}" })
}
