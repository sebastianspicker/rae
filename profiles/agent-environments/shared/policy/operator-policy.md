# Public Operator Policy

This profile payload is intentionally generic.

## Rules

- prefer local verification before publication
- keep generated state out of version control
- use explicit human checkpoints for destructive operations
- treat benchmark artifacts as publishable only when run cards, regression
  reports, and ledger entries are present

## Public-safety boundary

- no secrets
- no host-specific paths
- no usernames
- no machine-local hooks
