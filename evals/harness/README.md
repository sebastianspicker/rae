# Evals Harness

Local eval harness commands live here.

Current entrypoint:

- `./evals/harness/run-local.sh`

Current responsibilities:

- validate benchmark and run-card metadata
- route task specs into planned run cards
- execute benchmark splits
- emit judge calibration artifacts
- expose release gates and a minimal doctor surface for local inventory checks

This harness is intentionally narrow. Scenario execution still belongs to the
runtime chosen by the operator. The eval harness constrains how comparative
claims are recorded, validated, and published.
