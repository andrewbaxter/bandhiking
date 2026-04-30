variable "fly_api_token" {
  description = "Fly.io API token"
  type        = string
  sensitive   = true
}

variable "dnsimple_token" {
  description = "DNSimple API token"
  type        = string
  sensitive   = true
}

variable "dnsimple_account" {
  description = "DNSimple account ID"
  type        = string
}

variable "fly_app_name" {
  description = "Name of the Fly.io app"
  type        = string
  default     = "bandhiking"
}

variable "fly_org" {
  description = "Fly.io organization"
  type        = string
  default     = "personal"
}

variable "fly_region" {
  description = "Fly.io region"
  type        = string
  default     = "iad"
}

variable "image_tag" {
  description = "Docker image tag"
  type        = string
  default     = "latest"
}

variable "dnsimple_zone" {
  description = "DNSimple zone name"
  type        = string
  default     = "isandrew.com"
}

variable "dns_record_name" {
  description = "DNS record name (subdomain)"
  type        = string
  default     = "bandhiking2"
}
