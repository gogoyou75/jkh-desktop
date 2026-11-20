FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /tests
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY playwright.config.js ./
COPY tests ./tests
CMD ["npx", "playwright", "test"]
