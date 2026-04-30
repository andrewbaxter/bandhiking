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
