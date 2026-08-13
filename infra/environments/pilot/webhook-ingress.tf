resource "aws_lambda_function" "webhook" {
  function_name = "${local.name}-webhook"
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_sha}"
  role          = var.webhook_lambda_role_arn
  timeout       = 10
  memory_size   = 256
  image_config {
    entry_point = ["node_modules/.bin/aws-lambda-ric"]
    command     = ["dist/github/webhooks/v1/lambda-handler.handler"]
  }
  environment {
    variables = {
      WEBHOOK_SECRET_ARN            = aws_secretsmanager_secret.application["github-webhook-secret"].arn
      CALLBACK_QUEUE_URL            = aws_sqs_queue.runtime["callbacks"].url
      RUNTIME_CONFIGURATION_VERSION = "runtime-v1"
    }
  }
  tags = local.tags
}

resource "aws_apigatewayv2_api" "operator" {
  name                         = "${local.name}-api"
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = false
  tags                         = local.tags
}
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.operator.id
  name        = "$default"
  auto_deploy = true
  tags        = local.tags
}
resource "aws_apigatewayv2_integration" "webhook" {
  api_id                 = aws_apigatewayv2_api.operator.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}
resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.operator.id
  route_key = "POST /github/webhooks"
  target    = "integrations/${aws_apigatewayv2_integration.webhook.id}"
}
resource "aws_lambda_permission" "webhook_api" {
  statement_id  = "AllowWebhookApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.operator.execution_arn}/*/POST/github/webhooks"
}
