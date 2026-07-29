#!/usr/bin/env bash
# Provisions the pinned Linux analyzer binaries used by the Codacy gate.
set -euo pipefail

CODACY_HOME="${HOME}/.codacy"
TOOLS_DIR="${CODACY_HOME}/tools"
RUNTIMES_DIR="${CODACY_HOME}/runtimes"
TRIVY_CACHE_DIR="${CODACY_HOME}/cache/trivy"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rae-codacy-tools.XXXXXX")"

HADOLINT_VERSION="2.14.0"
HADOLINT_SHA256="6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47"
TRIVY_VERSION="0.72.0"
TRIVY_SHA256="bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"
OPENGREP_VERSION="1.22.0"
OPENGREP_SHA256="45bcd58440e397ed52c50e953ccf5948909ea77087c9186fc7d277216f62e319"
LIZARD_VERSION="1.21.2"
LIZARD_WHEEL_SHA256="d628a63fe0ad1ccff8e8f648e8dc9621f3a85ff754106dcc32b62cd0fc877802"
PATHSPEC_VERSION="1.1.1"
PATHSPEC_WHEEL_SHA256="a00ce642f577bf7f473932318056212bc4f8bfdf53128c78bbd5af0b9b20b189"
PYGMENTS_VERSION="2.20.0"
PYGMENTS_WHEEL_SHA256="81a9e26dd42fd28a23a2d169d86d7ac03b46e2f8b59ed4698fb4785f946d0176"

cleanup() {
  rm -rf "$WORK_DIR"
}

download_and_verify() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"

  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors \
    --output "$destination" "$url"
  printf '%s  %s\n' "$expected_sha256" "$destination" | sha256sum --check --status
}

require_linux_x86_64() {
  if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
    printf 'ERROR: Codacy tool provisioning supports only Linux x86_64; got %s %s.\n' \
      "$(uname -s)" "$(uname -m)" >&2
    exit 2
  fi
}

require_linux_x86_64
trap cleanup EXIT

mkdir -p "$TOOLS_DIR/Hadolint" "$TOOLS_DIR/Trivy" "$TOOLS_DIR/Semgrep" \
  "$RUNTIMES_DIR" "$TRIVY_CACHE_DIR"

download_and_verify \
  "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64" \
  "$WORK_DIR/hadolint" "$HADOLINT_SHA256"
install -m 0755 "$WORK_DIR/hadolint" "$TOOLS_DIR/Hadolint/hadolint"

download_and_verify \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
  "$WORK_DIR/trivy.tar.gz" "$TRIVY_SHA256"
mkdir "$WORK_DIR/trivy"
tar --extract --gzip --file "$WORK_DIR/trivy.tar.gz" --directory "$WORK_DIR/trivy" trivy
install -m 0755 "$WORK_DIR/trivy/trivy" "$TOOLS_DIR/Trivy/trivy"

download_and_verify \
  "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_x86" \
  "$WORK_DIR/opengrep" "$OPENGREP_SHA256"
install -m 0755 "$WORK_DIR/opengrep" "$TOOLS_DIR/Semgrep/opengrep"

printf 'lizard==%s \\\n    --hash=sha256:%s\npathspec==%s \\\n    --hash=sha256:%s\npygments==%s \\\n    --hash=sha256:%s\n' \
  "$LIZARD_VERSION" "$LIZARD_WHEEL_SHA256" \
  "$PATHSPEC_VERSION" "$PATHSPEC_WHEEL_SHA256" \
  "$PYGMENTS_VERSION" "$PYGMENTS_WHEEL_SHA256" > "$WORK_DIR/lizard-requirements.txt"
python -m venv "$RUNTIMES_DIR/lizard-1/venv"
"$RUNTIMES_DIR/lizard-1/venv/bin/pip" install --disable-pip-version-check \
  --require-hashes --requirement "$WORK_DIR/lizard-requirements.txt"

"$TOOLS_DIR/Hadolint/hadolint" --version | grep -Fq "$HADOLINT_VERSION"
"$TOOLS_DIR/Trivy/trivy" --version | grep -Fq "Version: ${TRIVY_VERSION}"
"$TOOLS_DIR/Semgrep/opengrep" --version | grep -Fxq "$OPENGREP_VERSION"
"$RUNTIMES_DIR/lizard-1/venv/bin/lizard" --version | grep -Fq "$LIZARD_VERSION"

"$TOOLS_DIR/Trivy/trivy" image --cache-dir "$TRIVY_CACHE_DIR" --download-db-only

printf 'Provisioned Codacy analyzers: Hadolint %s, Trivy %s, OpenGrep %s, Lizard %s.\n' \
  "$HADOLINT_VERSION" "$TRIVY_VERSION" "$OPENGREP_VERSION" "$LIZARD_VERSION"
