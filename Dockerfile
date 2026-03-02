FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV USE_GPU=0

EXPOSE 8080

CMD ["npm", "run", "api:stagepilot"]
