#!/usr/bin/env bash
set -e
export TF_VAR_fly_api_token="$(pw read /device/apricorn/container/dev/fly/token)"
export TF_VAR_dnsimple_token="$(pw read /device/apricorn/container/dev/dnsimple/token)"
export TF_VAR_dnsimple_account="$(pw read /device/apricorn/container/dev/dnsimple/account)"
export TF_VAR_fly_app_name="bandhiking"
export TF_VAR_fly_org="personal"
export TF_VAR_fly_region="lax"
export TF_VAR_image_tag="${IMAGE_TAG:-latest}"
export TF_VAR_dnsimple_zone="isandrew.com"
export TF_VAR_dns_record_name="bandhiking2"
cd "terraform"
terraform "$@"
