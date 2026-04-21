function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max) {
  const n = Math.trunc(toFiniteNumber(value, min));
  return Math.max(min, Math.min(max, n));
}

function phaseLimit(phase, policy) {
  if (phase === "adversarial-review") {
    return clampInt(policy.max_reviewers ?? 1, 1, 12);
  }
  if (phase === "build") {
    return clampInt(policy.max_builders ?? 1, 1, 12);
  }
  return 1;
}

function estimateQualityGain(base, fanout) {
  if (fanout <= 1) return 0;
  return base * Math.log2(fanout + 1);
}

function estimateCostDelta(costPerAgent, fanout) {
  return Math.max(0, fanout - 1) * costPerAgent;
}

function estimateCoordinationCost(coordinationUnit, fanout) {
  return Math.max(0, fanout - 1) * coordinationUnit;
}

export function decideFanout({
  phase,
  policy = {},
  traceSummary = {},
  requestedFanout,
  qualityGainEstimate,
  costPerAgentUsd,
  coordinationCost,
}) {
  const maxFanout = phaseLimit(phase, policy);
  const requested = clampInt(requestedFanout ?? maxFanout, 1, maxFanout);

  const lambda = toFiniteNumber(policy.lambda, 1);
  const mu = toFiniteNumber(policy.mu, 1);
  const minExpectedGain = toFiniteNumber(policy.min_expected_gain, 0.1);

  const qualityBase = toFiniteNumber(qualityGainEstimate, 0.2);
  const perAgentCost = toFiniteNumber(costPerAgentUsd, 0.5);
  const coordinationUnit = toFiniteNumber(coordinationCost, 0.05);

  const totalCost = toFiniteNumber(traceSummary.total_cost_usd, 0);
  const totalLatency = toFiniteNumber(traceSummary.total_duration_s, 0);
  const budgetUsd = toFiniteNumber(policy.budget_usd, 0);
  const latencyBudget = toFiniteNumber(policy.latency_budget_s, 0);

  const budgetExceeded = budgetUsd > 0 && totalCost >= budgetUsd;
  const latencyExceeded = latencyBudget > 0 && totalLatency >= latencyBudget;

  const candidateScores = [];
  for (let fanout = 1; fanout <= requested; fanout++) {
    const qualityGain = estimateQualityGain(qualityBase, fanout);
    const costDelta = estimateCostDelta(perAgentCost, fanout);
    const coordination = estimateCoordinationCost(coordinationUnit, fanout);
    const delta = qualityGain - lambda * costDelta - mu * coordination;

    candidateScores.push({
      fanout,
      quality_gain: Number(qualityGain.toFixed(6)),
      cost_delta: Number(costDelta.toFixed(6)),
      coordination_cost: Number(coordination.toFixed(6)),
      delta: Number(delta.toFixed(6)),
    });
  }

  candidateScores.sort((a, b) => {
    if (b.delta !== a.delta) return b.delta - a.delta;
    return a.fanout - b.fanout;
  });

  const best = candidateScores[0];

  let chosenFanout = best.fanout;
  const reasons = ["best_delta"];

  if (best.delta <= minExpectedGain) {
    chosenFanout = 1;
    reasons.length = 0;
    reasons.push("below_min_expected_gain");
  }

  if (budgetExceeded || latencyExceeded) {
    chosenFanout = 1;
    if (budgetExceeded) reasons.push("budget_guardrail");
    if (latencyExceeded) reasons.push("latency_guardrail");
  }

  return {
    phase,
    chosen_fanout: clampInt(chosenFanout, 1, maxFanout),
    max_fanout: maxFanout,
    requested_fanout: requested,
    reason: reasons.join(";"),
    thresholds: {
      lambda,
      mu,
      min_expected_gain: minExpectedGain,
      budget_usd: budgetUsd,
      latency_budget_s: latencyBudget,
    },
    runtime_totals: {
      total_cost_usd: totalCost,
      total_latency_s: totalLatency,
      budget_exceeded: budgetExceeded,
      latency_exceeded: latencyExceeded,
    },
    candidates: candidateScores,
  };
}
