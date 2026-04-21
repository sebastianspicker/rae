FROM node:20-bookworm-slim AS build
WORKDIR /skill
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ src/
RUN npx tsc

FROM node:20-bookworm-slim
RUN groupadd -r skill && useradd -r -g skill skill
WORKDIR /skill
COPY --from=build /skill/dist/ dist/
COPY --from=build /skill/node_modules/ node_modules/
COPY package.json ./
USER skill
ENTRYPOINT ["node", "dist/index.js"]
