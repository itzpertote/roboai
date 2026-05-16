# Robo AI

Robo AI is a bilingual voice assistant web app with a central animated orb, live subtitles, browser speech recognition, text-to-speech, and a secure server-side OpenAI API proxy.

## Run

1. Copy `.env.example` to `.env`.
2. Set `OPENAI_API_KEY`.
3. Run:

```bash
npm start
```

Open `http://localhost:3000`.

## GitHub Pages

This repo includes a Pages workflow that publishes the `public` folder. In GitHub, open **Settings > Pages** and choose **GitHub Actions** as the source.

GitHub Pages is static, so it cannot safely store `OPENAI_API_KEY`. Keep `server.js` on a small backend such as Render, Railway, Fly.io, or a VPS, then open the Pages URL once with your backend address:

```text
https://your-github-username.github.io/your-repo/?api=https://your-robo-api.example.com
```

That API URL is saved in the browser. Set `ALLOWED_ORIGIN` on the backend to your GitHub Pages origin, for example:

```text
ALLOWED_ORIGIN=https://your-github-username.github.io
```

## Notes

- Speech recognition uses the browser Web Speech API. Chrome and Edge currently offer the best support.
- The API key stays on the Node server. The browser sends only cleaned transcript text to `/api/robo`.
- If no API key is configured, the app runs in demo mode so the interface can still be tested.
- If GitHub Pages is opened without an API proxy, the app stays in demo mode instead of exposing a key.
- Turkish and English are available from the top language switch.

The OpenAI integration uses the Responses API endpoint documented at `https://api.openai.com/v1/responses`; the default model can be changed with `OPENAI_MODEL`.
