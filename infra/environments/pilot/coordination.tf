locals {
  queue_names = toset(["commands", "callbacks"])
}

resource "aws_sqs_queue" "dead_letter" {
  for_each                    = local.queue_names
  name                        = "${local.name}-${each.key}-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  message_retention_seconds   = 1209600
  sqs_managed_sse_enabled     = true
  tags                        = local.tags
}

resource "aws_sqs_queue" "runtime" {
  for_each                    = local.queue_names
  name                        = "${local.name}-${each.key}.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  visibility_timeout_seconds  = 300
  message_retention_seconds   = 345600
  receive_wait_time_seconds   = 20
  sqs_managed_sse_enabled     = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter[each.key].arn
    maxReceiveCount     = 5
  })
  tags = local.tags
}

resource "aws_dynamodb_table" "runtime_coordination" {
  name         = "${local.name}-coordination"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "purposeKey"
  range_key    = "entityKey"

  attribute {
    name = "purposeKey"
    type = "S"
  }
  attribute {
    name = "entityKey"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAtEpochSeconds"
    enabled        = true
  }
  point_in_time_recovery {
    enabled = true
  }
  server_side_encryption {
    enabled = true
  }
  deletion_protection_enabled = var.coordination_table_deletion_protection_enabled
  tags                        = local.tags
}
