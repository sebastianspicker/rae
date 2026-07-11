FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

# Build with skills/dev-tools as the Docker context so the local shared package
# remains available to npm and TypeScript.
WORKDIR /workspace/_shared
COPY _shared/package.json _shared/package-lock.json _shared/tsconfig.json ./
RUN npm ci --ignore-scripts
COPY _shared/src/ src/
RUN ./node_modules/.bin/tsc

WORKDIR /workspace/quality-gate
COPY quality-gate/package.json quality-gate/package-lock.json quality-gate/tsconfig.json ./
RUN npm ci --ignore-scripts
COPY quality-gate/src/ src/
RUN ./node_modules/.bin/tsc

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
RUN groupadd -r skill && useradd -r -g skill skill
WORKDIR /workspace/quality-gate
COPY --from=build /workspace/_shared/dist/ /workspace/_shared/dist/
COPY --from=build /workspace/_shared/node_modules/ /workspace/_shared/node_modules/
COPY --from=build /workspace/_shared/package.json /workspace/_shared/package.json
COPY --from=build /workspace/quality-gate/dist/ dist/
COPY --from=build /workspace/quality-gate/node_modules/ node_modules/
COPY quality-gate/package.json ./
USER skill
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]
ENTRYPOINT ["node", "dist/index.js"]
