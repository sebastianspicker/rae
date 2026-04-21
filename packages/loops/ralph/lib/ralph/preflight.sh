# shellcheck shell=bash
# Security and optional model preflight checks. Depends on log_event, fail, is_true.

run_security_preflight_check() {
  local -a watched_patterns=(
    "TOKEN" "SECRET" "PASSWORD" "API_KEY" "ACCESS_KEY" "PRIVATE_KEY"
    "AWS_" "DATABASE_URL" "POSTGRES_URL" "STRIPE_" "GITHUB_" "GOOGLE_APPLICATION_CREDENTIALS"
  )
  local -a detected=()
  local var_name joined pattern

  if ! is_true "${SECURITY_PREFLIGHT:-true}"; then
    log_event "INFO security_preflight=disabled"
    return
  fi

  while read -r var_name; do
    [[ -n "$var_name" ]] || continue
    for pattern in "${watched_patterns[@]}"; do
      if [[ "${var_name^^}" == *"$pattern"* ]]; then
        if [[ -n "${!var_name:-}" ]]; then
          detected+=("$var_name")
          break
        fi
      fi
    done
  done < <(export -p | awk -F'[ =]' '{print $3}' | sed 's/"//g')

  if [[ "${#detected[@]}" -eq 0 ]]; then
    log_event "INFO security_preflight=clean"
    return
  fi

  mapfile -t detected < <(printf '%s\n' "${detected[@]}" | sort -u)

  joined="$(IFS=,; printf '%s' "${detected[*]}")"
  log_event "WARN security_preflight=detected vars=$joined"
  printf '[ralph][WARN] Security preflight detected sensitive environment variables: %s\n' "$joined" >&2
  printf '[ralph][WARN] Use least privilege and unset unneeded secrets for autonomous runs.\n' >&2

  if is_true "${SECURITY_PREFLIGHT_FAIL_ON_RISK:-false}"; then
    fail "${RALPH_EXIT_SECURITY:-6}" "Security preflight blocked run due sensitive environment variables (vars=$joined)"
  fi
}
