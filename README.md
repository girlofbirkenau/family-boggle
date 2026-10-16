# Family Boggle

A live Boggle game for the whole family. Everyone opens the same link in a
browser (phone, tablet or computer), no accounts or app installs. Anyone can
start a round; everyone plays the same board at the same time.

## Run it on your own computer (to try it)

    npm install
    npm start

Then open http://localhost:3000 in two browser windows and play against yourself.

## Put it online for the family (Render, free)

Vercel can't host this one, because the game keeps live connections open. Render can.

1. Create a free account at https://github.com and make a new repository
   (for example `family-boggle`). Use "Add file > Upload files" and drag in
   everything from this folder (`server.js`, `package.json`, `public/`,
   `README.md`). Do not upload a `node_modules` folder.
2. Create a free account at https://render.com and sign in with GitHub.
3. New > Web Service > pick the `family-boggle` repository.
4. Settings: Runtime `Node`, Build Command `npm install`, Start Command
   `npm start`, Instance Type `Free`. Click Deploy.
5. After a few minutes Render shows an address like
   `https://family-boggle.onrender.com`. That is the link to send everyone.

On the free plan the game goes to sleep after 15 minutes with no activity and
takes about a minute to wake up. Open the link a few minutes before game time.
Round results are shown immediately; the all-time leaderboard needs persistent
storage as described below.

## Add to a phone's home screen

iPhone: open the link in Safari, tap Share, then Add to Home Screen.
Android: open in Chrome, tap the menu, then Add to Home screen.

## All-time leaderboard and keeping it safe

The lobby has an "All-time leaderboard": most wins, best round, longest word, most words in a
round, longest win streak and total points. It counts by name. Each finished round is saved to
PostgreSQL when `DATABASE_URL` is set, or `data/stats.json` next to the server otherwise.
Rejected-word reports use the same storage choice.

### PostgreSQL on Coolify (recommended for the home server)

1. Create a standard PostgreSQL resource in the same server and Docker destination/network
   as the app. For a new installation, PostgreSQL 18 is supported. Use an initial database
   named `family_boggle`. Keep public access disabled and port mappings empty.
2. Start PostgreSQL. Confirm its persistent volume is mounted at `/var/lib/postgresql`
   for PostgreSQL 18 (`/var/lib/postgresql/data` for 17 and earlier).
3. Prefer a dedicated application login rather than PostgreSQL's administrator. Before
   the app's first database start, open the database's **Terminal** and run
   `psql -U postgres -d family_boggle`. Inside that psql session run:

       CREATE ROLE boggle_app LOGIN;
       \password boggle_app
       ALTER DATABASE family_boggle OWNER TO boggle_app;
       GRANT USAGE, CREATE ON SCHEMA public TO boggle_app;

   `\password` prompts for a new password without putting it in shell/SQL history.
   This assumes a fresh database dedicated to this app; keep Coolify's database
   credentials as the administrator account so its backup operations still work.
4. Copy **Postgres URL (internal)** from the database's General page. For the dedicated
   login, replace its username and password with `boggle_app` and the new password;
   URL-encode special characters in the password. Keep the generated hostname and
   `/family_boggle` database path. `localhost` points at the app container, not PostgreSQL.
5. In the **app's Environment Variables**, set `DATABASE_URL` to that private connection
   URL as a **runtime** variable. Keep it out of GitHub, browser code, screenshots and
   build-time/public variables. The existing `npm install` / `npm start` commands still work.
   The example `.env.example` is a reference only; `npm start` does not load `.env` files.
6. Follow the first-import steps below, then deploy this code. It creates the
   `boggle_state` table automatically; the login needs schema/table creation and read/write
   access in this database. There is no separate migration command.
7. Verify `/healthz`, `/stats.json` (including each `?room=name`), and `/rejected.json`.
   Finish a test round, restart the app, and confirm the leaderboard still includes it.

**First import from existing files / GitHub Gist:**

- Save a copy of the existing `stats.json` and `rejected.json` files/Gist before switching.
- Stop the old app (including any Render instance) before starting the PostgreSQL version.
  Keep one app instance/replica; live rooms, chat, current streaks and unfinished games still
  live in memory. Use a stop-then-start deployment rather than overlapping app instances.
- Keep `GITHUB_TOKEN` and, if already configured, `GIST_ID` set for the first start so the
  existing Gist history can be imported even when Docker has no old local files. If history
  exists only on disk, make those files available under the app's `DATA_DIR` for first start.
  Check the expected room/player records in the existing source before proceeding.
- An empty PostgreSQL database imports the newer local/Gist stats and rejected-word
  documents independently, preserving all rooms, player names, counters and timestamps.
  A failed Gist request or malformed/incomplete legacy document blocks the first import;
  fix the source and restart. With no existing sources, a new empty leaderboard is created.
- Once initialized, PostgreSQL is authoritative. Later starts never replace it with a
  local file or Gist, even if that backup has a newer timestamp. A database connection or
  write failure stops the app with a nonzero exit status; it never switches silently to
  empty/file storage. Configure Coolify to restart failed containers.
- PostgreSQL stores the existing versioned aggregate documents in JSONB. Both documents
  are updated atomically, and writes are serialized. An exclusive database advisory lock
  rejects a second running app instance instead of letting it overwrite the first.
- `GITHUB_TOKEN` can remain enabled as an additional backup. PostgreSQL mode does not write
  local JSON copies. Do not remove `DATABASE_URL` to roll back storage: export the latest
  database state first, or the app would resume from older local/Gist data.

**Backups:** In the PostgreSQL resource's **Backups** tab, schedule a daily backup of
`family_boggle`, keep a suitable retention period (for example 14 days), and store a copy
outside the VM using Coolify's S3-compatible backup destination. Run a manual backup and
test restoring it into a separate database. A persistent volume survives container/app
redeployments; it does not protect against deletion or loss of the VM's disk.

This change persists the data the server currently saves: all-time player statistics and
rejected-word reports. It does not introduce accounts or change identity (stats still count
by name). Browser-local settings, live chat and unfinished rounds are not migrated.

### Existing file and Gist storage (without DATABASE_URL)

On Render's free plan that folder is wiped whenever the service sleeps or redeploys, so the
stats are also copied to a **secret GitHub Gist** (free, on your own GitHub account) and loaded
back when the server starts. To turn that on, add one setting:

1. On GitHub: your picture > Settings > Developer settings > Personal access tokens >
   Tokens (classic) > Generate new token (classic). Name it `family-boggle backup`, pick an
   expiration, tick ONLY the `gist` box, and generate. Copy the token (it starts with `ghp_`).
2. On Render: your service > Environment > Add Environment Variable. Key `GITHUB_TOKEN`,
   value is the token. Save (Render redeploys).
3. After the first finished round, a secret gist called `family-boggle-stats.json` appears at
   https://gist.github.com. Leave it alone. The game reads and updates it by itself.

On a home server, point `DATA_DIR` at a folder that survives restarts (for example a Docker
volume). Set `GITHUB_TOKEN` there too to keep the Gist as a spare copy, and to pull in the
history already saved from Render. Only run ONE server against the same Gist at a time,
otherwise they overwrite each other's backup (stop or delete the Render service when you move).

You can look at the raw numbers at `/stats.json` (add `?room=name` for another room).

## Tests

Run `npm ci` and `npm test` for storage unit tests, file-mode regression tests and the
unreachable-database startup check. To also run PostgreSQL end-to-end tests, set
`TEST_DATABASE_URL` to a **dedicated disposable test database**, then run `npm test`.
The integration test drops `boggle_state` in that database; never use the production URL.
GitHub Actions runs the complete suite with a PostgreSQL 18 service, covering first
file/Gist import, a finished WebSocket round, rejected-word persistence, restart recovery,
database authority and exclusion of concurrent writers.

## Good to know

- Everyone who opens the same link plays together. To run a second, separate
  game (for example another branch of the family), add `?room=name` to the
  link, such as `https://family-boggle.onrender.com/?room=cousins`.
- There is a chat (speech-bubble button at the top). Everyone in the same room can chat during the lobby, countdown, round and results. The last 100 messages are kept while the server stays awake.
- The winner of each round gets a crown. Win streaks (rounds won in a row) show next to the crown from 2 wins on, and reset when someone else wins. Ties crown everyone tied, and a solo round never changes a streak. Streaks live in the server's memory, so they reset if Render restarts.
- Tap the "Family Boggle" title at any time to get back to the lobby (invite link, who is here, next round). While a round is running, the Start button waits until it ends, and a banner takes you back to the game.
- The gear button at the top lets anyone change their name at any time. Someone who opens the link in the middle of a round gets the name box right away.
- About 7 in 10 boards have at least 3 words ending in -er (not every board, but far more than pure chance gives). Tap the "N here" badge at the top to see who is connected.
- The page files (`index.html`, `manifest.webmanifest`, `icon.png`) can sit in a `public` folder or directly next to `server.js`; the server finds them either way.
- Every board is guaranteed to hold at least 50 words, including at least one word of 7 or more letters (the server re-rolls other boards before the round starts).
- If a phone loses Wi-Fi, it reconnects by itself and keeps the words it found.
- Word checking uses a list of about 50,000 everyday English words built into the page
  (obscure Scrabble-only words and names are left out). It lives in `public/index.html`.
