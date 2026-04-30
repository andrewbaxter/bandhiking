#!/usr/bin/env bash
set -e

# Set terraform variables from environment variables, using placeholders as defaults.
export TF_VAR_fly_api_token="${FLY_API_TOKEN:-placeholder_fly_api_token}"
export TF_VAR_dnsimple_token="${DNSIMPLE_TOKEN:-placeholder_dnsimple_token}"
export TF_VAR_dnsimple_account="${DNSIMPLE_ACCOUNT:-placeholder_dnsimple_account}"
export TF_VAR_fly_app_name="${FLY_APP_NAME:-bandhiking}"
export TF_VAR_fly_org="${FLY_ORG:-personal}"
export TF_VAR_fly_region="${FLY_REGION:-iad}"
export TF_VAR_image_tag="${IMAGE_TAG:-latest}"
export TF_VAR_dnsimple_zone="${DNSIMPLE_ZONE:-isandrew.com}"
export TF_VAR_dns_record_name="${DNS_RECORD_NAME:-bandhiking2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "${SCRIPT_DIR}/terraform"
terraform "$@"
