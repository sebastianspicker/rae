# Experimental hosted-platform image. The runtime has no writeable application filesystem.
FROM node:24.14.1-alpine AS dependencies
WORKDIR /app/packages/orchestration/platform
COPY packages/orchestration/platform/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts

FROM node:24.14.1-alpine
WORKDIR /app/packages/orchestration
COPY --from=dependencies /app/packages/orchestration/platform/node_modules ./node_modules
COPY packages/orchestration/platform ./platform
COPY packages/orchestration/contracts/workflows ./contracts/workflows
COPY packages/orchestration/scripts/pipeline ./scripts/pipeline
ENV PATH="/app/packages/orchestration/node_modules/.bin:${PATH}"
USER node
ENTRYPOINT ["node", "platform/bin/rae-platform.mjs"]
CMD ["serve"]
