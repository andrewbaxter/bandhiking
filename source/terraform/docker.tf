resource "docker_image" "app" {
  name = "registry.fly.io/${var.fly_app_name}:${var.image_tag}"
  build {
    context    = "${path.module}/.."
    dockerfile = "Dockerfile"
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
