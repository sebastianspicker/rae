# Build and run the experimental hosted platform through compiled TypeScript entrypoints.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build
WORKDIR /app
RUN ["apt-get", "update"]
RUN ["apt-get", "install", "-y", "--no-install-recommends", "cmake", "make", "g++", "git", "ca-certificates"]
RUN ["rm", "-rf", "/var/lib/apt/lists"]
COPY . .
RUN ["npm", "ci", "--ignore-scripts"]
RUN ["npm", "ci", "--prefix", "apps/platform", "--ignore-scripts"]
RUN ["npm", "run", "build:typescript"]
RUN ["npm", "--prefix", "apps/platform", "run", "build:typescript"]
RUN ["npm", "prune", "--omit=dev", "--ignore-scripts"]
RUN ["npm", "--prefix", "apps/platform", "prune", "--omit=dev", "--ignore-scripts"]

FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
WORKDIR /app
RUN ["apt-get", "update"]
RUN ["apt-get", "install", "-y", "--no-install-recommends", "git", "ca-certificates"]
RUN ["rm", "-rf", "/var/lib/apt/lists"]
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts/dist/container-check.js ./scripts/dist/container-check.js
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/engine/policies ./packages/engine/policies
COPY --from=build /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/packages/fs-bridge/dist ./packages/fs-bridge/dist
COPY --from=build /app/packages/fs-bridge/build/Release ./packages/fs-bridge/build/Release
COPY --from=build /app/packages/fs-bridge/package.json ./packages/fs-bridge/package.json
COPY --from=build /app/packages/dev-tools ./packages/dev-tools
COPY --from=build /app/workflows ./workflows
COPY --from=build /app/apps/platform/dist ./apps/platform/dist
COPY --from=build /app/apps/platform/migrations ./apps/platform/migrations
COPY --from=build /app/apps/platform/package.json ./apps/platform/package.json
COPY --from=build /app/apps/platform/node_modules ./apps/platform/node_modules
ENV PATH="/app/apps/platform/node_modules/.bin:${PATH}"
USER node
ENTRYPOINT ["node", "apps/platform/dist/bin/rae-platform.js"]
CMD ["serve"]
