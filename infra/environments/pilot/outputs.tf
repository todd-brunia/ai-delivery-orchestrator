output "ecr_repository_url" { value = aws_ecr_repository.worker.repository_url }
output "public_subnet_ids" { value = values(aws_subnet.public)[*].id }
output "isolated_subnet_ids" { value = values(aws_subnet.isolated)[*].id }
