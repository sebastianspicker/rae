# Build a hermetic review-skill image so validation does not depend on host tooling.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /skill
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ src/
RUN ./node_modules/.bin/tsc

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
RUN groupadd -r skill && useradd -r -g skill skill
WORKDIR /workspace/multi-model-review
COPY --from=build /workspace/_shared/dist/ /workspace/_shared/dist/
COPY --from=build /workspace/_shared/node_modules/ /workspace/_shared/node_modules/
COPY --from=build /workspace/_shared/package.json /workspace/_shared/package.json
COPY --from=build /workspace/multi-model-review/dist/ dist/
COPY --from=build /workspace/multi-model-review/node_modules/ node_modules/
COPY multi-model-review/package.json ./
USER skill
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]
ENTRYPOINT ["node", "dist/index.js"]
