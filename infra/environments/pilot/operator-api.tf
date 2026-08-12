resource "aws_lambda_function" "operator" {
  function_name                  = "${local.name}-operator"
  package_type                   = "Image"
  image_uri                      = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_sha}"
  role                           = var.operator_lambda_role_arn
  timeout                        = 10
  memory_size                    = 256
  reserved_concurrent_executions = 5
  image_config {
    entry_point = ["node_modules/.bin/aws-lambda-ric"]
    command     = ["dist/operator-api/v1/lambda-handler.handler"]
  }
  environment {
    variables = {
      ALLOWED_OPERATOR_PRINCIPAL_ARN = var.allowed_operator_principal_arn
      COMMAND_QUEUE_URL              = aws_sqs_queue.runtime["commands"].url
      COORDINATION_TABLE_NAME        = aws_dynamodb_table.runtime_coordination.name
      RUNTIME_CONFIGURATION_VERSION  = "runtime-v1"
    }
  }
  tags = local.tags
}

locals {
  operator_routes = toset([
    "GET /v1/health",
    "GET /v1/runs",
    "POST /v1/runs",
    "GET /v1/runs/{runId}",
    "GET /v1/runs/{runId}/events",
    "POST /v1/runs/{runId}/pause",
    "POST /v1/runs/{runId}/resume",
    "POST /v1/runs/{runId}/cancel",
    "POST /v1/runs/{runId}/reconcile",
    "POST /v1/runtime/wake",
    "POST /v1/runtime/drain",
  ])
}
resource "aws_apigatewayv2_integration" "operator" {
  api_id                 = aws_apigatewayv2_api.operator.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.operator.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}
resource "aws_apigatewayv2_route" "operator" {
  for_each           = local.operator_routes
  api_id             = aws_apigatewayv2_api.operator.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.operator.id}"
  authorization_type = "AWS_IAM"
}
resource "aws_lambda_permission" "operator_api" {
  statement_id  = "AllowOperatorApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.operator.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.operator.execution_arn}/*/*/v1/*"
}
