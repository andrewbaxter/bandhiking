output "app_name" {
  description = "Fly.io app name"
  value       = fly_app.app.name
}

output "app_url" {
  description = "Fly.io app URL"
  value       = fly_app.app.app_url
}

output "shared_ip_address" {
  description = "Fly.io shared IPv4 address"
  value       = fly_app.app.shared_ip_address
}

output "image_name" {
  description = "Docker image name"
  value       = docker_image.app.name
}

output "dns_record" {
  description = "DNS record FQDN"
  value       = "${dnsimple_zone_record.app.name}.${dnsimple_zone_record.app.zone_name}"
}
