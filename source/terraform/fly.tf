resource "fly_app" "app" {
  name                     = var.fly_app_name
  org                      = var.fly_org
  assign_shared_ip_address = true
}

resource "fly_machine" "app" {
  app    = fly_app.app.name
  image  = docker_registry_image.app.name
  region = var.fly_region
  name   = var.fly_app_name

  services = [{
    internal_port = 8080
    protocol      = "tcp"
    ports = [{
      port     = 443
      handlers = ["tls", "http"]
      }, {
      port     = 80
      handlers = ["http"]
    }]
  }]
}

resource "fly_cert" "app" {
  app      = fly_app.app.name
  hostname = "${var.dns_record_name}.${var.dnsimple_zone}"
}
