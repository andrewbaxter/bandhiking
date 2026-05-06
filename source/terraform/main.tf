terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
    fly = {
      source  = "andrewbaxter/fly"
      version = "~> 0.1"
    }
    dnsimple = {
      source  = "dnsimple/dnsimple"
      version = "~> 1.0"
    }
  }
}

locals {
  app_name = "bandhiking"
  source_files = setunion(
    fileset("${path.module}/..", "Dockerfile"),
    fileset("${path.module}/..", "Cargo.*"),
    fileset("${path.module}/..", "build.rs"),
    fileset("${path.module}/..", "src/**/*"),
    fileset("${path.module}/..", "prestatic/**/*"),
    fileset("${path.module}/..", "ts/package*.json"),
    fileset("${path.module}/..", "ts/tsconfig.json"),
    fileset("${path.module}/..", "ts/rollup.config.js"),
    fileset("${path.module}/..", "ts/src/**/*"),
  )
  source_hash = sha256(join("", [for f in sort(local.source_files) : filesha256("${path.module}/../${f}")]))
}

variable "fly_api_token" {
  type      = string
  sensitive = true
}

variable "dnsimple_token" {
  type      = string
  sensitive = true
}

variable "dnsimple_account" {
  type = string
}

provider "fly" {
  fly_api_token = var.fly_api_token
}

provider "docker" {}

provider "dnsimple" {
  token   = var.dnsimple_token
  account = var.dnsimple_account
}

resource "docker_image" "app" {
  name = "registry.fly.io/${local.app_name}:${local.source_hash}"
  build {
    context    = "${path.module}/.."
    dockerfile = "Dockerfile"
  }
  triggers = {
    source_hash = local.source_hash
  }
}

resource "docker_registry_image" "app" {
  name          = docker_image.app.name
  keep_remotely = true
  auth_config {
    address  = "registry.fly.io"
    username = "x"
    password = var.fly_api_token
  }
}

resource "fly_app" "app" {
  name                     = local.app_name
  org                      = "personal"
  assign_shared_ip_address = true
}

resource "fly_machine" "app" {
  app    = fly_app.app.name
  image  = docker_registry_image.app.name
  region = "lax"
  name   = local.app_name

  services = [{
    internal_port = 8080
    protocol      = "tcp"
    ports = [
      {
        port     = 443
        handlers = ["tls", "http"]
      }
    ]
  }]
}

resource "fly_cert" "app" {
  app      = fly_app.app.name
  hostname = "bandhiking2.isandrew.com"
}

resource "dnsimple_zone_record" "app" {
  zone_name = "isandrew.com"
  name      = "bandhiking2"
  type      = "A"
  value     = fly_app.app.shared_ip_address
  ttl       = 3600
}
