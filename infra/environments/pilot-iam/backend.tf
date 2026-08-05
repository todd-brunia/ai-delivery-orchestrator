terraform {
  backend "s3" {
    key          = "pilot-iam/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
