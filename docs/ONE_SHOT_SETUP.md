# One-shot setup

## Local
```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```
Open http://localhost:8787.

## Docker
```bash
export DAMC_API_KEY_ADMIN='replace-with-a-long-random-secret'
docker compose up --build
```
The application is exposed on port 8787. In production, use HTTPS and a real reverse proxy.

## First production user
```bash
curl -X POST http://localhost:8787/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -H 'x-damc-admin-key: replace-with-a-long-random-secret' \
  -d '{"email":"you@example.com","displayName":"Your Name","projectName":"My Project"}'
```
The response contains a one-time API key. Store it securely.
