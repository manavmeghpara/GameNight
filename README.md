# 🎬 GameNight

A Kahoot-style movie trivia game you run on your own laptop. The host screen goes on the
TV, everyone else plays from their phone, and questions can be built around **images,
audio clips and video clips** as well as plain text.

Runs entirely on your local network — no accounts, no hosting, no internet needed once
the media is on your machine.

---

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Letting phones join](#letting-phones-join)
- [Building a quiz](#building-a-quiz)
- [Running a game](#running-a-game)
- [How scoring works](#how-scoring-works)
- [Supported media](#supported-media)
- [Limits](#limits)
- [Where your data lives](#where-your-data-lives)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## What you get

**Two modes**, on two different screens:

| | |
|---|---|
| **Admin** — `/admin.html` | Build quizzes. Upload media, trim clips, set timers and points, and add **anywhere from 2 to 8 answer options** per question. Autosaves as you type. |
| **Host** — `/host.html` | Open a room, show the game PIN on the TV, and run the game: media plays here, with a countdown ring, live answer counts, reveals, leaderboard and podium. |
| **Player** — `/` | Join with the PIN and a nickname, then answer from your phone. |

Highlights:

- **Clip-aware timing.** Trim a video to `1:10–1:22` and the answer pads appear exactly as
  the clip ends — no manual cueing.
- **Audio-only mode.** Play a video's sound with the picture hidden, so you can quiz on a
  line of dialogue without giving the scene away.
- **Speed scoring** with streak bonuses, like Kahoot.
- **Refresh-proof.** Host and players can both reload mid-game and land back where they
  were, with answers already locked in still locked in.

---

## Requirements

- **Node.js 20 or newer** ([download](https://nodejs.org)) — check with `node --version`
- A laptop for the host, and a phone per player, **all on the same Wi-Fi**

---

## Quick start

```bash
git clone https://github.com/<your-username>/GameNight.git
cd GameNight
npm install
npm start
```

The server prints everything you need:

```
  GameNight is up.

  Quiz builder: http://localhost:3000/admin.html
  Host screen : http://localhost:3000/host.html
  Players     : http://192.168.1.5:3000
```

Then:

1. Open the **quiz builder** and make a quiz (or you can't start a game).
2. Open the **host screen** on the TV and hit *Create a game*.
3. Players go to the **`Players`** address on their phones and enter the PIN.

> Use `npm run dev` instead of `npm start` while editing — it restarts on file changes.

To run on a different port:

```bash
PORT=8080 npm start          # macOS / Linux
$env:PORT=8080; npm start    # Windows PowerShell
```

---

## Letting phones join

Phones **cannot** reach `localhost` — that address means "this device". Use the
`Players` line the server prints, which is your laptop's address on the Wi-Fi
(something like `http://192.168.1.5:3000`). The host screen also shows it in big text
above the game PIN.

**If phones can't connect**, it is almost always the firewall on the host machine:

- **Windows** — the first time you run `npm start`, Windows asks whether to allow Node.js
  through the firewall. Tick **Private networks** and allow it. If you dismissed that
  prompt, re-allow it under *Windows Security → Firewall & network protection →
  Allow an app through firewall*.
- **macOS** — *System Settings → Network → Firewall → Options*, allow incoming
  connections for `node`.

Also check the laptop and phones are on the **same** network — a "guest" Wi-Fi or a phone
still on mobile data will not reach it.

---

## Building a quiz

Open `http://localhost:3000/admin.html` and hit **+ New quiz**.

For each question you can set:

- **The prompt** — what you're asking
- **Media** — drag and drop an image, audio file or video, or click to browse
- **Clip window** (audio/video) — *play from* `1:10` *to* `1:22`, with a **Preview clip**
  button. Leave the end blank to play from the start point onward
- **Audio only** (video) — hides the picture and plays just the sound
- **Time limit** — 5, 10, 20, 30, 45, 60, 90 or 120 seconds
- **Points** — no points, half (500), standard (1000) or double (2000)
- **Answer options** — **2 to 8 of them**. Add and remove freely; each gets its own colour
  and shape that matches exactly what players see on their phones. Click the circle to
  mark the correct one

Everything **autosaves** shortly after you stop typing. **Check quiz** lists anything that
would stop it being playable — a blank prompt, too few options, a blank correct answer, or
the same answer entered twice. A quiz only appears in the host's quiz picker once it's clean.

Use **Copy** in the library to duplicate a quiz — the copy gets its own copies of the media
files, so deleting one quiz never breaks the other.

---

## Running a game

On the host screen: **Create a game** → pick a quiz → **Start game** once players have joined.

Each question moves through four stages, driven by one button:

| Stage | What's happening |
|---|---|
| **Reading** | Prompt and media on the TV. Answers are **closed** — nobody can buzz early. Press **Open answers** to skip the wait |
| **Answering** | Pads appear on phones, countdown ring on the TV. Ends on the timer, or as soon as everyone has answered |
| **Reveal** | The correct answer, with how many people chose each option |
| **Scoreboard** | Standings; players see their rank and the gap to whoever's ahead |

Other controls:

- **End game** — stops the game and returns everyone to the lobby, ready to play again
- **Close game** — shuts the room down entirely and disconnects everyone
- **✕** next to a player's name in the lobby removes them

---

## How scoring works

A **wrong or missing answer scores 0** and resets your streak.

A **correct answer** scores between **50% and 100%** of the question's points, depending on
how fast you were — full points the instant the pads open, decaying to half at the buzzer.
Speed is what separates two people who both knew the answer.

Consecutive correct answers add a **streak bonus** of **+100 each**, capped at **+500**.

> Example: 1000-point question, answered a quarter of the way through the timer, third
> correct in a row → `1000 × 0.875 = 875`, plus a 200 streak bonus → **1075**.

---

## Supported media

Uploads are accepted by **file extension**, not by what the browser claims the file is.

| Type | Extensions |
|---|---|
| **Image** | `.jpg` `.jpeg` `.png` `.gif` `.webp` `.avif` |
| **Audio** | `.mp3` `.m4a` `.aac` `.ogg` `.oga` `.wav` `.flac` |
| **Video** | `.mp4` `.m4v` `.webm` `.ogv` `.mov` |

Playback uses your browser's own decoders, so **`.mp4` (H.264) and `.mp3` are the safest
bets**. An exotic codec in an `.mkv`-style container may upload fine and still refuse to
play — test it with **Preview clip** in the builder before game night.

---

## Limits

| | |
|---|---|
| Players per room | 60 |
| Nickname length | 16 characters |
| Answer options per question | 2 – 8 |
| Questions per quiz | 100 |
| Upload size | 250 MB per file |
| Idle room lifetime | 1 hour after the host disappears |

---

## Where your data lives

Both folders are created on first run and are **git-ignored**, so your quizzes and media
stay on your machine and never end up in a commit:

```
data/quizzes/     one .json file per quiz
uploads/          the images, audio and video you upload
```

To back up or move your quizzes to another machine, copy **both** folders — the quiz files
reference the uploads by filename.

Deleting a quiz in the builder also deletes the media it owned.

---

## Project layout

```
server/
  index.js      HTTP + socket wiring, LAN address discovery, room lifecycle
  rooms.js      rooms, players, PIN generation, nickname validation
  game.js       the game engine: phases, timers, scoring, what each side may see
  quizzes.js    quiz model, validation, saving to disk
  media.js      upload handling and the allowed file types
  api.js        REST API used by the quiz builder

public/
  index.html    player: join, then play
  host.html     host: lobby, question stage, scoreboard, podium
  admin.html    quiz builder
  js/
    common.js   shared helpers (storage, screens, socket acks)
    shapes.js   the colour + shape for each answer option
    pads.js     answer pads, shared by host and player
    stage.js    the host's media player (clips, audio-only, autoplay fallback)
    join.js     player logic
    host.js     host logic
    admin.js    builder logic
  css/          style.css (shared), game.css (play screens), admin.css (builder)

test/           see below
```

**The server is the referee.** It owns the clock, decides when answers are accepted, and is
the only place that knows the correct answer while a question is live — players are never
sent it, including when they reconnect mid-question.

---

## Tests

```bash
npm test
```

Runs five suites, roughly 280 checks:

| Suite | Covers |
|---|---|
| `pages.test.mjs` | Every referenced element, asset and button actually exists and is wired up |
| `screens.test.mjs` | Drives the real host and player scripts through a full game in jsdom and asserts on the DOM |
| `lobby.test.mjs` | Rooms, joining, kicking, reconnects |
| `builder.test.mjs` | Quiz CRUD, uploads, validation, hostile input |
| `game.test.mjs` | Scoring maths, phase timing, and everything the server should refuse |

Each suite starts its own server on its own port, so no setup is needed.

---

## Troubleshooting

**"No finished quizzes" in the host's quiz picker.**
The quiz has problems. Open it in the builder and press **Check quiz** — it lists exactly
what to fix. Only clean quizzes can be started.

**Media doesn't play on the host screen.**
If the browser blocked autoplay, a **▶ Tap to play** button appears — click it. If nothing
appears at all, the browser can't decode that file; re-encode it as H.264 `.mp4`.

**A player's phone shows "Reconnecting…".**
Their Wi-Fi dropped. It reconnects on its own and puts them back where they were, with
their score intact. Their name greys out in the host's roster until then.

**The host refreshed and lost the game.**
It shouldn't — the host screen resumes automatically. If it lands on *Create a game*, the
room was closed or the server restarted; rooms live in memory and don't survive a restart.

**Port 3000 is already in use.**
Run on another port: `PORT=8080 npm start`.

---

## License

No license chosen yet. Add a `LICENSE` file before publishing — without one, GitHub
treats the repo as all rights reserved.

**A note on the media you upload:** film clips, posters and soundtracks are copyrighted.
Keeping the uploads out of the repo (as `.gitignore` already does) is deliberate — play
your quizzes at home, but don't redistribute the media with the code.
