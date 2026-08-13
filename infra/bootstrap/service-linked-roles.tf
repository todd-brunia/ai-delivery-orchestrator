resource "aws_iam_service_linked_role" "rds" {
  aws_service_name = "rds.amazonaws.com"
  description      = "Allows Amazon RDS to manage resources for the pilot database."
}

resource "aws_iam_service_linked_role" "ecs" {
  aws_service_name = "ecs.amazonaws.com"
  description      = "Allows Amazon ECS to manage resources for the pilot worker service."
}
