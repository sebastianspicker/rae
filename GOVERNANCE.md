# Governance

RAE is maintainer-led during the public alpha candidate phase. The maintainer
owns release scope, security decisions, project direction, and final merge
authority.

Contributors may propose changes through issues and pull requests. Decisions
favor:

1. reproducible evidence and explicit failure modes;
2. user and repository safety;
3. the smallest adequate implementation;
4. compatibility with documented public alpha scope;
5. maintainability and verification cost.

Documentation frontmatter status describes the review maturity of a page, not
the stability of a public API. Capability and interface maturity must be stated
in the page prose. During the alpha series, documented interfaces may change;
changes still require a rationale, migration notes when users are affected, and
the applicable verification gates. Significant behavior, security, governance,
or release changes require maintainer approval.

Security reports follow [SECURITY.md](SECURITY.md), not public governance
channels.
