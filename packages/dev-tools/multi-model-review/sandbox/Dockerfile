# Build from the repository root with locked dependencies and compiled TypeScript exports.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build
WORKDIR /workspace
COPY . .
RUN ["npm", "ci", "--ignore-scripts"]
RUN ["npm", "run", "build", "--workspace", "@rae/contracts"]
RUN ["npm", "run", "build", "--workspace", "@rae/dev-tools-shared"]
RUN ["npm", "run", "build", "--workspace", "packages/dev-tools/multi-model-review"]
RUN ["npm", "prune", "--omit=dev", "--ignore-scripts"]

FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
WORKDIR /workspace/packages/dev-tools/multi-model-review
COPY --from=build /workspace/node_modules/ /workspace/node_modules/
COPY --from=build /workspace/packages/dev-tools/shared/dist/ /workspace/packages/dev-tools/shared/dist/
COPY --from=build /workspace/packages/dev-tools/shared/package.json /workspace/packages/dev-tools/shared/package.json
COPY --from=build /workspace/packages/dev-tools/multi-model-review/dist/ dist/
COPY --from=build /workspace/packages/dev-tools/multi-model-review/package.json ./
COPY --from=build /workspace/packages/contracts/ /workspace/packages/contracts/
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]
ENTRYPOINT ["node", "dist/index.js"]
