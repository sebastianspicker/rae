import { describe, it, expect } from "vitest";
import {
  detectDrift,
  detectDriftFromExtractorClaims,
  evaluateDriftQuality,
} from "../../src/lib/drift.js";

describe("detectDrift", () => {
  it("returns no findings when target contains all source claims", () => {
    const source = [
      "# Authentication",
      "- Must use JWT tokens for session management",
      "- Should support OAuth2 providers",
      "",
      "# Database",
      "- Must use PostgreSQL for persistence",
    ].join("\n");

    const target = [
      "# Authentication",
      "We use JWT tokens for session management.",
      "OAuth2 providers are fully supported.",
      "",
      "# Database",
      "PostgreSQL is the primary persistence layer.",
    ].join("\n");

    const { claims, findings } = detectDrift(source, target);

    expect(claims.length).toBeGreaterThan(0);
    expect(findings).toHaveLength(0);
    for (const claim of claims) {
      expect(claim.verification_status).toBe("verified");
    }
  });

  it("detects missing sections as drift", () => {
    const source = [
      "# Authentication",
      "- Must use JWT tokens",
      "",
      "# Rate Limiting",
      "- Must enforce 100 requests per minute",
    ].join("\n");

    const target = ["# Authentication", "We use JWT tokens."].join("\n");

    const { findings } = detectDrift(source, target);

    expect(findings.length).toBeGreaterThan(0);
    const driftFinding = findings.find(
      (f) =>
        f.description.toLowerCase().includes("rate limiting") ||
        f.description.toLowerCase().includes("100 requests"),
    );
    expect(driftFinding).toBeDefined();
  });

  it("detects missing assertions within sections", () => {
    const source = [
      "# Security",
      "- Must encrypt data at rest",
      "- Must use TLS 1.3 for transport",
      "- Must implement RBAC",
    ].join("\n");

    const target = ["# Security", "Data at rest is encrypted using AES-256."].join("\n");

    const { claims, findings } = detectDrift(source, target);

    const unverified = claims.filter((c) => c.verification_status !== "verified");
    expect(unverified.length).toBeGreaterThan(0);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("returns empty results for empty source", () => {
    const { claims, findings } = detectDrift("", "Some target text");

    expect(claims).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });

  it("detects drift when source has assertions but no markdown headings", () => {
    const source = ["- Must use JWT for auth", "- Must implement RBAC for admin endpoints"].join(
      "\n",
    );

    const target = "Authentication requirements are TBD.";

    const { claims, findings } = detectDrift(source, target);

    expect(claims.length).toBeGreaterThan(0);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("includes assertions that appear before the first heading", () => {
    const source = [
      "- Must enforce authentication at edge",
      "# API",
      "- Must return typed errors",
    ].join("\n");

    const target = ["# API", "Typed errors are returned."].join("\n");

    const { claims } = detectDrift(source, target);

    expect(claims.some((c) => c.claim.toLowerCase().includes("authentication"))).toBe(true);
  });

  it("does not treat heading substrings in body text as heading matches", () => {
    const source = "# API\nBody";
    const target = "Rapid rollout plan with no headings.";

    const { claims } = detectDrift(source, target);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.verification_status).toBe("violated");
  });

  it("assigns high/medium severity to non-verified claims", () => {
    const source = ["# API", "- Must support GraphQL subscriptions"].join("\n");

    const target = "# API\nREST endpoints only.";

    const { findings } = detectDrift(source, target);

    expect(findings.length).toBeGreaterThan(0);
    expect(["high", "medium"]).toContain(findings[0]?.severity);
    expect(findings[0]?.claim_ids.length).toBeGreaterThan(0);
  });

  it("adds extractor and claim fields in claims", () => {
    const source = [
      "# Deployment",
      "- Must use Kubernetes",
      "",
      "# Monitoring",
      "- Must expose Prometheus metrics",
    ].join("\n");

    const target = [
      "# Deployment",
      "Kubernetes is the deployment target.",
      "# Monitoring",
      "Prometheus metrics are exposed.",
    ].join("\n");

    const { claims } = detectDrift(source, target);

    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.claim.length).toBeGreaterThan(0);
      expect(claim.extractor).toBe("rule-based-drift-detector");
      expect(["interface", "invariant", "security", "performance", "docs"]).toContain(
        claim.claim_type,
      );
    }
  });

  it("returns heuristic adjudication metadata in fallback mode", () => {
    const source = "# API\n- Must support GraphQL subscriptions";
    const target = "# API\nREST only";

    const result = detectDrift(source, target);
    expect(result.adjudication.mode).toBe("heuristic");
    expect(result.adjudication.extractors).toEqual(["rule-based-drift-detector"]);
  });
});

describe("detectDriftFromExtractorClaims", () => {
  it("resolves verified-vs-violated as partial and tracks conflicts", () => {
    const result = detectDriftFromExtractorClaims([
      {
        extractor: "extractor-a",
        claims: [
          {
            id: "claim-1",
            claim: "Must support GraphQL subscriptions",
            verification_status: "verified",
            evidence: "GraphQL resolver present",
            confidence: 0.8,
          },
        ],
      },
      {
        extractor: "extractor-b",
        claims: [
          {
            id: "claim-1",
            claim: "Must support GraphQL subscriptions",
            verification_status: "violated",
            evidence: "Only REST routes found",
            confidence: 0.6,
          },
        ],
      },
    ]);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.verification_status).toBe("partial");
    expect(result.claims[0]?.confidence).toBe(0.7);
    expect(result.adjudication.mode).toBe("dual-extractor");
    expect(result.adjudication.conflicts_resolved).toBeGreaterThan(0);
  });

  it("marks unmatched claims as unverifiable", () => {
    const result = detectDriftFromExtractorClaims([
      {
        extractor: "extractor-a",
        claims: [
          {
            id: "claim-1",
            claim: "Must support GraphQL subscriptions",
            verification_status: "verified",
            evidence: "GraphQL resolver present",
          },
        ],
      },
      {
        extractor: "extractor-b",
        claims: [],
      },
    ]);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.verification_status).toBe("unverifiable");
    expect(result.findings).toHaveLength(1);
  });

  it("computes precision/recall/f1 metrics by taxonomy class", () => {
    const metrics = evaluateDriftQuality(
      ["security", "performance", "docs"],
      ["security", "docs", "docs"],
    );

    expect(metrics.overall.precision).toBeGreaterThan(0);
    expect(metrics.overall.recall).toBeGreaterThan(0);
    expect(metrics.by_class.security.precision).toBe(1);
    expect(metrics.by_class.performance.recall).toBe(0);
  });
});
