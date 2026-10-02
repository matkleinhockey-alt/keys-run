# Keys Run

A three.js fishing game set in Marathon, Florida Keys. The whole game is one file: `index.html`.

## Play locally
Open `index.html` in a browser, or run:

    npm install
    npm start

then visit http://localhost:3000.

## 1. Put it on GitHub

    git init
    git add .
    git commit -m "Keys Run"
    git branch -M main
    git remote add origin https://github.com/YOUR-NAME/keys-run.git
    git push -u origin main

(Create the empty `keys-run` repo on github.com first, or run `gh repo create keys-run --public --source=. --push` if you use the GitHub CLI.)

## 2a. Deploy on Vercel (static, no build step)
- Go to vercel.com → Add New → Project → import the `keys-run` repo → Deploy. Leave Framework Preset as "Other" and the build command empty.
- Or from this folder: `npx vercel` (preview) then `npx vercel --prod`.

## 2b. Deploy on Railway
- Go to railway.app → New Project → Deploy from GitHub repo → pick `keys-run`.
- Railway detects Node, runs `npm install` and `npm start` (which serves the page on Railway's `$PORT`).
- In the service's Settings → Networking, click **Generate Domain** to get a public URL.
- Or from this folder: `npm i -g @railway/cli`, `railway login`, `railway init`, `railway up`, then `railway domain`.

## Updating the live game
Edit `index.html`, then:

    git add . && git commit -m "Update" && git push

Vercel and Railway both redeploy automatically on every push to `main`.

## What works where
Everything single-player works on Vercel and Railway. Live friends (seeing each other's boats) and the shared leaderboard use
features of the claude.ai artifact viewer, so on your own domain they switch off and the game runs solo. Keep sharing the
claude.ai link for multiplayer, or ask for a version that uses your own backend (for example a small Railway WebSocket server).
