# Removes workstation-specific paths and unstable metadata from CodeQL reports.
[
  .[].runs[]
  | .results[]?
  | {
      ruleId,
      level,
      locations: [
        .locations[]?.physicalLocation
        | {
            artifactUri: .artifactLocation.uri,
            startLine: .region.startLine,
            startColumn: .region.startColumn
          }
      ]
    }
]
