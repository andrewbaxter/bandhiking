provider "fly" {
  fly_api_token = var.fly_api_token
}

provider "docker" {}

provider "dnsimple" {
  token   = var.dnsimple_token
  account = var.dnsimple_account
}
