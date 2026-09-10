# Toolchain for the HackDay factory comparison.
# package.json pins engines.node to 24.x, so node:20 would not do.
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# No GEMINI_API_KEY needed: the unit tests cover error mapping only.
CMD ["npm", "test"]
