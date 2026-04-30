resource "dnsimple_zone_record" "app" {
  zone_name = var.dnsimple_zone
  name      = var.dns_record_name
  type      = "A"
  value     = fly_app.app.shared_ip_address
  ttl       = 3600
}
