FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS build

# Build with skills/dev-tools as the Docker context so the local shared package
# remains available to npm and TypeScript.
WORKDIR /workspace/_shared
COPY _shared/package.json _shared/package-lock.json _shared/tsconfig.json ./
RUN npm ci --ignore-scripts
COPY _shared/src/ src/
RUN ./node_modules/.bin/tsc

WORKDIR /workspace/multi-model-review
COPY multi-model-review/package.json multi-model-review/package-lock.json multi-model-review/tsconfig.json ./
RUN npm ci --ignore-scripts
COPY multi-model-review/src/ src/
RUN ./node_modules/.bin/tsc

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c
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
