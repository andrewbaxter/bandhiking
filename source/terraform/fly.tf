resource "fly_app" "app" {
  name                     = "bandhiking"
  org                      = "personal"
  assign_shared_ip_address = true
}

resource "fly_machine" "app" {
  app    = fly_app.app.name
  image  = docker_registry_image.app.name
  region = "iad"
  name   = "bandhiking"

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
  hostname = "bandhiking2.isandrew.com"
}
