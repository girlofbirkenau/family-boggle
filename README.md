# Family Boggle

A live Boggle game for the whole family. Everyone opens the same link in a
browser (phone, tablet or computer), no accounts or app installs. Anyone can
start a round; everyone plays the same board at the same time.

## Single-player Sudoku

Choose **Play Sudoku** at the bottom of the lobby, below **How to play**.
The **← Boggle** button returns to the same room. Sudoku runs locally and
does not create a Boggle round or write to the multiplayer leaderboard.

Tap a square, then a number. Use Notes to enter pencil marks, Undo to reverse
an edit, Erase to clear a square, and Hint to reveal a value. Keyboard controls:
1–9 enter numbers, arrow keys select squares, N toggles notes, and Backspace
or Delete erases. Pause hides the board. The timer excludes time in a hidden
tab or while the phone is locked. Progress and display preferences are saved
on this device; when browser storage is unavailable, a message explains that
closing the tab will lose progress. Undo history lasts for the current visit.

Easy, Medium, and Hard use curated, uniquely solvable base puzzles transformed
by shuffled digits, bands, stacks, rows/columns within them, and transposition.
These transformations preserve solving logic and uniqueness. Easy is solvable
with naked singles, Medium also needs hidden singles, and Hard needs techniques
beyond those two. Each generated puzzle is checked for exactly one solution.
Difficulty changes apply when **New puzzle** is confirmed. Hints reveal a value;
they do not teach a solving technique. There is no hint limit.

Deploy `sudoku.html`, `sudoku.css`, `sudoku-engine.js`, and `sudoku.js` beside
`index.html` in the same directory served by `server.js` (root or `public/`).
No new dependencies or environment variables are required.

## Scoring and boards

Words score 1 point for 3 letters, 2 for 4, 3 for 5, and one more point for
each additional letter. Qu is one tile but counts as two letters. In multiplayer,
words found by just one player earn double points when the round ends; shared
words still earn base points. Solo rounds use base points. Word-entry feedback
shows base points; the unique-word bonus is determined at the end.

New rounds use these rules for results, wins, and saved statistics. Existing
leaderboard history is preserved at its original scores.

Boards roll one face from each of the 16 classic English dice, then shuffle
their positions. By default, the generator favors boards with at least 50 words,
a word of at least 7 letters, and at least 3 distinct words of 4+ letters ending
in "er". Boards below the "er" target have a 30% chance of passing that filter.
These thresholds can be overridden with the `BOGGLE_MIN_WORDS`, `BOGGLE_MIN_LONG`,
`BOGGLE_MIN_ER`, and `BOGGLE_ER_SOFT` environment variables.

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
6. Mount a persistent backup directory (for example `/backups`) and set
   `BOGGLE_BACKUP_DIR=/backups` as a runtime variable. First import refuses to proceed
   without writing, syncing, reading back, and verifying a complete backup there.
   Follow the first-import steps below, then deploy this code. It creates the
   `boggle_state` table automatically; the login needs schema/table creation and read/write
   access in this database. There is no separate migration command.
7. Verify `/healthz`, `/stats.json` (including each `?room=name`), and `/rejected.json`.
   Finish a test round, restart the app, and confirm the leaderboard still includes it.

**First import from existing files / GitHub Gist:**

- **Before merging/deploying this PR**, copy the current app’s entire `DATA_DIR` to the
  VM (outside the app container), and download both raw files from the existing Gist.
  The public `/stats.json` endpoint is a leaderboard view, not a full backup: it omits
  aliases, merge history and internal timestamps. Verify the saved JSON parses, record
  its checksums, and keep a copy outside the VM. Do not rely only on the mutable Gist.
- If you need to deploy this code to use its new backup download first, leave
  `DATABASE_URL` unset, open `/admin`, and choose **Download full data backup**.
  This exports every room, player, alias, merge archive, and rejected-word record.
  Verify it with `node scripts/verify-backup.js /path/to/backup.json`. A deployment
  can replace container-local data, so take the VM/Gist copy above before any redeploy.
- Stop the old app (including any Render instance) before starting the PostgreSQL version.
  Keep one app instance/replica; live rooms, chat, current streaks and unfinished games still
  live in memory. Use a stop-then-start deployment rather than overlapping app instances.
- Keep `GITHUB_TOKEN` and, if already configured, `GIST_ID` set for the first start so the
  existing Gist history can be imported even when Docker has no old local files. If history
  exists only on disk, make those files available under the app's `DATA_DIR` for first start.
  Check the expected room/player records in the existing source before proceeding.
- Before inserting into an empty PostgreSQL database, the selected source data is
  saved as a checksum-protected `pre-postgres-*.json` in `BOGGLE_BACKUP_DIR`. The
  snapshot is verified from disk; any backup failure blocks the import. This must
  be a mounted persistent directory. Copy that snapshot off the server as well.
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

## Room voice chat

The compact voice bar is available in the lobby, during rounds, and on results.
Enter a name, choose **Join Voice**, and allow microphone access. The microphone
icon is green while on and red while muted; click it to toggle outgoing audio
while you keep listening. A speech activity pulse uses local microphone levels
without recording. The exit icon stops the microphone and closes calls.
Click the avatar stack to see everyone and their connection and microphone status.
Avatars wrap after five participants. Joining is always manual, including after a lost
connection. Game sound settings do not mute voice. If the browser blocks incoming
sound, tap **Enable voice audio**. Headphones help prevent echo.

Voice is audio-only WebRTC, with up to eight participants per room. The app server
relays connection messages through the existing WebSocket; audio travels between
participants directly or through your configured TURN relay. The app does not
record audio. Production microphone access requires HTTPS (localhost works for
local testing). Room links grant access to both the game and its voice channel.

### Relay configuration for Coolify

STUN discovery works by default, but **configure TURN before relying on voice
across different households, cellular connections, or restrictive Wi-Fi**. TURN
provides an alternate route when browsers cannot connect directly.

Use either of these configurations in the Boggle application's Coolify environment:

- For a coturn-compatible relay using shared-secret authentication, set
  `VOICE_TURN_URLS` to comma-separated URLs such as
  `turn:relay.example.com:3478,turns:relay.example.com:5349`, and
  `VOICE_TURN_SECRET` to the same shared secret configured on that relay. The
  application issues credentials valid for 24 hours; the shared secret is never
  sent to browsers. Rejoin voice to obtain fresh credentials for a longer session.
- For a relay provider that supplies ICE configuration, set `VOICE_ICE_SERVERS`
  to its JSON array of `RTCIceServer` objects, for example
  `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turns:relay.example.com:5349","username":"<relay-user>","credential":"<relay-password>"}]`.
  These client credentials are delivered to voice participants; use credentials
  intended for browser clients. This variable replaces the default STUN list.

Save the environment and redeploy. A TURN relay is a separate service and must
be reachable directly on its configured transport and media ports; the existing
Cloudflare HTTP tunnel for the game does not supply a TURN relay. There is no
need to change the game's HTTP port or WebSocket route.

Try two devices on different networks before inviting everyone. If a participant
shows a failed connection, check relay configuration, then leave and rejoin voice.
Mobile browsers may interrupt calls when backgrounded or the phone locks; keep
the game open during play.

### Checks

Run `npm test` for room isolation, session validation, mute/leave/disconnect,
replacement tabs, capacity, TURN credentials, and asset delivery checks.


### Merge duplicate player stats

Set `BOGGLE_ADMIN_PASSWORD` to a long, unique password in the server environment (Coolify: Environment Variables), redeploy, then visit `/admin` on the game’s HTTPS address. Admin access is disabled until the variable is set. The password stays in page memory only; locking or reloading clears it.

Select a room, the duplicate name, and the profile to retain. Review the preview and confirm. Games, wins, points, and words are added; best round, longest word, most words, and best streak retain the better record. Existing totals cannot reveal overlapping rounds, so review before merging. Merges are blocked during active rounds and when the preview is stale.

The old name redirects future scores to the retained stats record. This does not combine browser sessions or introduce login profiles. Original records and previous aliases are archived in `rooms[room].mergeHistory` in the saved stats document (PostgreSQL when enabled, otherwise `stats.json`), including the existing Gist backup. Download a full backup before editing data. Recovery is manual: stop the app and restore to the authoritative store; editing `stats.json` does not change PostgreSQL. Do not restore blindly after additional games.


### Verify and restore a full backup

The admin download and pre-import snapshot use the same checksum-protected format.
`node scripts/verify-backup.js /path/to/backup.json` verifies integrity and prints counts.
To restore into a **separate test database**, stop any app pointed at it, verify the
backup, then decode the payload into `stats.json` and `rejected.json` in a temporary
`DATA_DIR`. Start the app with that directory, the empty test database’s `DATABASE_URL`,
and a persistent `BOGGLE_BACKUP_DIR`. First import will back up and import those files.
Leave `GITHUB_TOKEN` unset during this restore so a Gist cannot supersede them. Check
all rooms and records before selecting a restored database for production.
Never remove `DATABASE_URL` as a rollback after PostgreSQL has accepted new games.

The test suite exercises a full export/restore drill, merge history and alias retention,
restarted browser scoring under an old name, missing backup directories, migration,
writer exclusion, and database failures. PostgreSQL tests require a disposable database.
