# Build from the repository root with locked dependencies and compiled TypeScript exports.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /workspace
COPY . .
RUN ["npm", "ci", "--ignore-scripts"]
RUN ["npm", "run", "build", "--workspace", "@rae/contracts"]
RUN ["npm", "run", "build", "--workspace", "@rae/dev-tools-shared"]
RUN ["npm", "run", "build", "--workspace", "packages/dev-tools/multi-model-review"]
RUN ["npm", "prune", "--omit=dev", "--ignore-scripts"]

FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
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
