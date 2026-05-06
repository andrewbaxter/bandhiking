resource "dnsimple_zone_record" "app" {
  zone_name = "isandrew.com"
  name      = "bandhiking2"
  type      = "A"
  value     = fly_app.app.shared_ip_address
  ttl       = 3600
}
