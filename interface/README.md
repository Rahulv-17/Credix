This is the Next.js chat UI for the Credix assistant. It talks to the Mastra backend (the Hono `/v1/chat` service) through same origin API routes under `app/api/*`, so the browser never calls the backend or any third party directly.

## Getting Started

1. Copy the env template and fill in the values:

   ```bash
   cp .env.example .env.local
   ```

   - `CREDIX_API_URL`: the Mastra backend base URL (default `http://localhost:3000`). Server side only; used by `app/api/chat/route.ts` and `app/api/parse-statement/route.ts`.
   - `ELEVENLABS_API_KEY`: enables voice input and read aloud replies (used server side by `app/api/stt/route.ts` and `app/api/tts/route.ts`). Optional overrides: `ELEVENLABS_STT_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL`.

2. Install deps and run the frontend:

   ```bash
   pnpm install
   pnpm dev
   ```

   The app runs on `http://localhost:5174`. Start the Mastra backend separately (see the repo root README / Makefile `make dev`), and point `CREDIX_API_URL` at it.

## How it talks to the backend

The browser only ever calls same origin routes; each one proxies to the backend server side:

- `app/api/chat` forwards the turn to `${CREDIX_API_URL}/v1/chat`.
- `app/api/parse-statement` parses an uploaded statement and posts the chunks to `${CREDIX_API_URL}/v1/statement`.
- `app/api/stt` and `app/api/tts` call ElevenLabs for speech to text and text to speech.

## Project layout

```
app/                Next.js App Router pages
app/api/chat        proxy to the Mastra /v1/chat backend
app/api/parse-statement  statement upload parser, posts to /v1/statement
app/api/stt         speech to text (ElevenLabs)
app/api/tts         text to speech (ElevenLabs)
lib/useCredixRuntime.ts  assistant-ui runtime adapter over /api/chat
```

`app/assistant.tsx` wires the assistant-ui runtime to `useCredixRuntime`, which sends each turn to `/api/chat`.
