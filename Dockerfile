FROM node:18

WORKDIR /app

COPY package*.json ./
# Use lockfile when present; fall back to install to avoid empty node_modules
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
