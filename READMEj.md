# Robo AI

Robo AI is a Turkish and English voice assistant UI for GitHub Pages. It has speech recognition, live subtitles, text-to-speech, and an animated orb.

## GitHub Pages

No localhost is required.

1. Upload this whole folder to a GitHub repository.
2. Go to **Settings > Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main`.
5. GitHub will publish the `public` folder automatically.

The site works in demo mode immediately. Voice recognition works best in Chrome or Edge because it uses the browser Web Speech API.

## API Without Running Your PC

GitHub Pages cannot safely store an OpenAI API key. Use `cloudflare-worker.mjs` as the API proxy so the key stays in Cloudflare, not in the website.

In Cloudflare Workers, add these secrets/variables:

```text
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-5.4-mini
ALLOWED_ORIGIN=https://your-github-username.github.io
```

Then open your GitHub Pages site once like this:

```text
https://your-github-username.github.io/your-repo/?api=https://your-worker-name.your-account.workers.dev
```

The browser saves that API address after the first visit.
