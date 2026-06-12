FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /skill
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ src/
RUN ./node_modules/.bin/tsc

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
RUN groupadd -r skill && useradd -r -g skill skill
WORKDIR /skill
COPY --from=build /skill/dist/ dist/
COPY --from=build /skill/node_modules/ node_modules/
COPY package.json ./
USER skill
ENTRYPOINT ["node", "dist/index.js"]
