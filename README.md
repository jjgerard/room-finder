# Ulster Room Finder

> Two related things live here. **Ulster Room Finder** is a browser extension that
> answers "which rooms are free for this recurring slot?" against live booking data.
> [**Belfast timetable**](#belfast-timetable) is a solver that rebuilds both terms so
> every class has one room and no rule is broken, with a site to show it. They share the
> same API and the same caution about it.

A browser extension for Ulster University's Scientia Resource Booker. Ask it a question
in your own words:

> rooms seating 45+ in BC or BD free 12:15–13:15 every Monday from 28 Sep to 7 Dec

and it answers in words, not just a grid:

> **Nothing in the 34 rooms searched is free at 12:15–13:15 on all 11 dates from 28 Sep to 7 Dec.**
>
> Closest miss is B_BC-01-002 (48), busy on one date only (2 Nov) — taken by CMM125_S1/LEC/01 12:00–14:00.
>
> Move the slot to 12:45–13:45 (30 min later) and 4 rooms are free on every date.

Clicking through the booking UI room by room does not scale: ~550 rooms against a
twelve-week term is thousands of clicks, and the UI can only ever tell you about one
room in one week. This drives the booking app's own JSON API from inside the tab you are
already signed in to, and works out what actually fits.

It is **read-only**. It lists rooms and reads busy times. It never submits a booking
request — that booking type is view-only anyway, and bookings go through Ulster's
Timetabling and Attendance contact form.

## How it handles your login

It doesn't. You sign in to Resource Booker yourself, exactly as you always do, through
Microsoft SSO. The extension then reuses the authorisation header the booking app
attaches to its *own* requests, without reading the token's value.

Concretely:

- no password, MFA code or token is seen, stored, or sent anywhere;
- **no API key of any kind** — the question is parsed in your browser, by rules, with no
  AI service involved and nothing leaving the page;
- no server of ours exists, so there is nothing to send anything to;
- every request goes to the same API the page itself calls, from the same origin, with
  your own permissions;
- the extension asks for **no permissions at all** in `manifest.json` — no
  `host_permissions`, no storage, no network beyond the page's own origin behaviour.

If you close the tab, it stops. If your session expires mid-search, it nudges the app's
UI to make the app refresh its own session, then carries on — the same thing you'd do by
clicking a calendar arrow.

## Install

There is no store listing, so it loads unpacked. That is a two-minute job and survives
browser restarts.

**Chrome / Edge** (needs Chrome 111 or newer)

1. Download this repository — **Code → Download ZIP** at the top of the repository page —
   and unzip it. Or clone it: `git clone https://github.com/jjgerard/room-finder.git`
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).

**Firefox** (needs Firefox 128 or newer)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `manifest.json` in that folder.

Firefox's temporary add-ons are cleared when the browser closes, so it needs reloading
each session unless it's signed and installed properly.

This repository is public, so that download link works for anyone you send it to.

## Use

1. Open Resource Booker and sign in, so you're on a `…/app/booking-types/<id>` page.
2. Click something in the app — type in the room search box, or click a calendar arrow.
   This is what makes the app issue its first authenticated request, which is what the
   extension latches on to. Without it the first search will say so and ask you to.
3. Click **Find rooms**, bottom right.
4. Type your question and hit **Search** (or Ctrl/Cmd+Enter).

The booking type is read from the URL, so the same extension works for any booking type
you have access to — nothing to configure.

### What it understands

Everything below is recognised. Anything it can't place is listed back to you as
"Ignored: …" so you know it was dropped rather than silently misread.

| You write | It reads |
|---|---|
| `12:15-13:15`, `12.15 to 1.15`, `9-11`, `2pm-4pm`, `2-4` | the slot — a bare `2-4` is the afternoon, a bare `9-11` the morning |
| `Wednesday afternoons`, `Monday mornings`, `lunchtime` | 13:00–17:00, 09:00–13:00, 12:00–14:00 |
| `at 10 for 2 hours` | 10:00–12:00 |
| `every Monday`, `Tuesdays and Thursdays`, `weekdays`, `Mon-Fri` | which days |
| `from 28 Sep to 7 Dec`, `28/09 to 07/12`, `until 7 Dec`, `next 10 weeks` | the range; a bare month always rolls forward, never into the past |
| `seating 45+`, `for 50 people`, `at least 20 seats` | the capacity floor, applied server-side against the real Capacity property |
| `Belfast`, `Coleraine`, `Magee`/`Derry` | the campus |
| `in BC or BD`, `blocks bc and bd` | Belfast blocks — the two letters after the prefix, as in `B_BC-03-104` |
| `including labs`, `any room` | keeps labs and studios in |
| `allow 1 clash`, `free every week` | how much imperfection you'll take |
| `where is CMM125`, `why isn't CMM125 in its usual room` | switches to module lookup |

It will not understand genuinely unusual wording. When it gets something wrong, the
read-back shows you immediately, and **Refine by hand** has every field as a control.

### What it tells you

- **Rooms free on every date**, with real capacities.
- **Near misses, with their shape** — the difference between "busy for 3 dates in a row
  in the middle (5 Oct–19 Oct)" and "busy on 3 scattered dates" matters, and so does the
  longest unbroken stretch a room *is* free.
- **What would open it up.** When little or nothing fits, it works out the alternatives
  rather than leaving you to guess: shifting the slot (computed from data already
  fetched, so the room count is real, and offered smallest-shift-first), accepting a
  clash or two, using the longest clear run, or — as a fresh search — dropping the
  capacity floor, widening beyond your chosen blocks, or putting the filtered labs back.
  Each one is a button.
- **Module lookup.** Ask where a module sits and it finds the pattern across the term,
  then splits the missing weeks into the two cases that need different fixes: the room
  is *free* (nothing is blocking it — the event's week pattern just doesn't cover that
  week, so timetabling can extend it without moving anyone) versus the room is *taken*
  (named, with times, so you know what you're up against).

## Things it gets right that are easy to get wrong

These are the traps, and the reason a naive version of this tool quietly returns wrong
answers:

- **Timezone.** The API returns `StartDateTime` as true UTC while serialising it with a
  `+00:00` offset. During BST that is an hour behind what the UI shows, and a Sept–Dec
  term crosses the October clock change — so wall-clock arithmetic corrupts roughly half
  the results. Every instant here goes through `Europe/London`.
- **Phantom rooms.** Records named `BT Room …` mirror real Belfast rooms but carry zero
  events. They look gloriously free. Any room with no events at all across the whole
  period is treated as a shell record and reported separately rather than as available.
- **Session expiry.** Bulk fetching runs out of token after a few minutes. Searches
  retry through a refresh rather than failing half-done.
- **Boundary dates.** Busy times are fetched a day wider than asked and filtered
  locally, so nothing falls through the UTC/local seam.

## Verify before you rely on it

Every room links to its own day view in the booking app. **Check two of them** before
acting — one date inside BST and one after the October clock change. That single habit
catches every category of error above.

## Known limits and unverified bits

- **The parser is rules, not comprehension.** It covers the phrasings in the table above
  and will misread things outside them. That is why it always shows its reading and
  lists what it ignored — treat the read-back as part of the answer, not decoration.
- **"This term" is guessed** as the next 12 weeks, because the extension has no access
  to Ulster's academic calendar. It says so when it does this. Give real dates when it
  matters.
- **Module week numbers are not institutional.** The module view lists dates, not week
  numbers, rather than invent a numbering that might not match yours.
- **The Capacity property GUID** (`71bd4589-…` in `content.js`) is Ulster's. Another
  Scientia tenant would need its own. To re-derive it: set the capacity Minimum field in
  the app's UI and read the request the app sends.
- **The pending-requests response shape** is read defensively — items are used when they
  carry `StartDateTime` and `Duration`, and ignored otherwise. This has had less exposure
  than the busy-times path; if pending bookings seem to be missed, look there first.
- **The date parameter format** sent to the API (`…T00:00:00.000Z`) matches what the app
  appears to use; the widened range means a mismatch would show up as extra results
  rather than missing ones.
- **The content script matches `*://*/app/booking-types/*`**, i.e. that path on any host,
  because Resource Booker's hostname isn't hardcoded. To narrow it, edit `matches` in
  `manifest.json`, e.g. `"https://resourcebooker.ulster.ac.uk/app/booking-types/*"`.
- **Specialist-room exclusion is by name**, since nothing flags a lab as a lab. It will
  occasionally take out a room you wanted; that's why it shows you what it removed and
  offers to put them back.
- Results are capped at 40 rooms to keep the capacity lookups quick.

## Layout

| File | What it is |
|---|---|
| `parse.js` | question → search. Pure, no DOM, no network. |
| `analyse.js` | busy times → what fits, what nearly fits, what would open it up. Pure. |
| `content.js` | auth capture, the API calls, the panel. |
| `test.js` | the tests. |

## Tests

```
node test.js
```

99 checks, no dependencies. `parse.js` and `analyse.js` are pure and tested directly —
every phrasing in the table above is a test case, as is each near-miss shape, the
alternatives engine, and both module-gap cases. `content.js` needs a signed-in session,
so only its date/time core is covered, pulled out of the file between its banner
comments: UTC-to-London either side of the October clock change, the half-open overlap
test, events past midnight, and weekday generation across a term. That is the part that
goes wrong quietly.

---

# Belfast timetable

A second, self-contained piece of work in this repository: a solver that rebuilds
Ulster Belfast's **Autumn 2026 and Spring 2026** timetables so that every class has one
room and no hard rule is broken, plus a companion site that shows the result and lets
you try moves of your own.

The extension answers *"is this room free?"* against live booking data. This answers
*"could the whole term be arranged better?"* against a snapshot — which
[can be refreshed](#refreshing-from-resource-booker) from the same API the extension
uses. Same problem, opposite ends.

## The result

Both terms rebuild to **zero hard-rule violations**, checked by the same code that
enforced them — spring re-checked in your browser every time the page loads.

| | Autumn, today | Autumn, rebuilt | Spring, today | Spring, rebuilt |
|---|---|---|---|---|
| Lecture+seminar pulled apart | 0 of 224 | **0** | 75 of 146 | **0** |
| A session outside 09:15–17:15 | 40 | **0**\* | 48 | **0**\* |
| A class moving between rooms mid-term | 13 | **0** | 35 | **0** |
| Two classes in one room at once | 0 | **0** | 0 | **0** |
| A cohort or lecturer in two places | 0 | **0** | 0 | **0** |
| Classes in the 9–10 or 4–5 edge slots | 794 | **507** | 668 | **394** |
| Cohort gap-days | 436 | **319** | 399 | **307** |
| Classes left exactly where they are | — | 656 of 2,261 | — | 587 of 1,870 |

\* Eighteen sessions still finish after 17:15 — eleven in spring and seven in autumn.
Seventeen of them belong to a chain of classes longer than a teaching day, which cannot
fit inside one whatever else moves. The eighteenth is autumn's COM772 lecture, chained
back-to-back in front of a session starting at 18:15 that the model pins because evening
teaching stays where it is. The rule excuses both cases from the *end* of the day and
neither from its start; the site names them rather than pretending they are inside it.

**Neither result is one lucky shuffle.** The search starts from a random arrangement, so
both terms were run from 30 different starting points against the same rules:

| | Reached zero | Ended on 1 | on 2 | on 3+ |
|---|---|---|---|---|
| Spring 2026 | **6 of 30** | 9 | 6 | 9 |
| Autumn 2026 | **10 of 30** | 16 | 4 | 0 |

Every one of those 16 clean timetables is published, not just the two the site is built
from — the picker at the top of either rebuilt term switches between them. No clean run
had to split a class across two rooms.

**Two rooms at once is not the fault being fixed.** A booking holding several rooms in
the same hour is parallel teaching, and the rebuild books every one of them: MEC114's
tutorial teaches 350 students in seven rooms, the fine art studios keep fourteen. What
is wrong is a class meeting in one room for six weeks and another for the rest, because
nobody could hold one room for the term — 35 classes in spring, 13 in autumn, none in
either rebuild.

**Getting autumn there took corrections, not a better search.** Under the sizes first
read off the booking data it could not get close. What changed was the data: 62
confirmed cohort sizes from timetabling, two classes told what kind of room they need,
two told which room, one told to keep the slot it has. Five modules were each believed
to need all 350 seats of Lecture Theatre 1, because that is the room they sit in — only
one of them does. Every such correction hands a room back to the classes queueing for
it.

**A 9-to-5 day only works if the inferred clash graph is pruned** — see
[how much the clash graph matters](#how-much-does-the-inferred-clash-graph-matter)
below. The published solution records which graph it used, and the site says so.

Two results contradict the earlier analysis this work started from, which concluded that
~27 modules could never be back-to-back and that three all-day sessions had to move
offsite. Both turned out to be achievable. The difference is not a better search — it is
that a linked group is represented as **one object with a fixed internal offset**, so
contiguity is a property of the representation rather than something a search has to
achieve and then defend against its own later repairs.

## Running it

Node 18+. The solver and the site need no dependencies; only the refresh below
does.

```
node timetable/test.js                          # the checks
node timetable/export.js                        # pack the site data
node timetable/solve.js --term spring --seeds 30 --clashes evidenced --out docs/data
node timetable/solve.js --term autumn --seeds 30 --clashes evidenced --out docs/data
```

109 checks. They cover the rules themselves, the solver never making a timetable worse,
the model's own cost agreeing with the independent checker, and the things that went
wrong once and would go wrong quietly again: that the teaching day the solver grades
itself against is the one the site enforces, that a class dragged past 17:15 by a pinned
chain is exempt from the end of the day but never from its start, and that neither
rebuilt term contains a class moving between rooms mid-term.

Solving into `docs/data` runs the export for you, since `solution.json` and
`docs/data/timetable.json` are a pair and a stale second one publishes a timetable
that no longer exists. Changing the model or the data without re-solving needs the
export too — CI fails if the committed `docs/` is not what it produces. Run

```
git config core.hooksPath .githooks
```

once, and the pre-commit hook does it for you.

`solve.js` restarts from many seeds and keeps the best, because the search plateaus in
seconds — restarts buy far more than a longer single run. It prints every seed, so the
same command answers both "what is the best arrangement" and "how many starting points
reach zero at all".

A seed names a *search*, not a timetable, and only under one version of the rules: the
solver's own cost reads the teaching-day exemptions, so changing those moves every seed
onto a different path. `timetable/seeds.js` packs the clean ones for the site, and
re-checks each against a freshly loaded model before it does — a seed is published as
clean because it checks clean now, not because a log said so when it ran.

```
node timetable/seeds.js --term autumn --out docs/data --in /tmp/s1 /tmp/s5 …
```

## Refreshing from Resource Booker

The two "as it stands" timetables come from a snapshot. When timetabling moves a
class, the site does not know until somebody refreshes it — and that has to happen
**on your own computer**, in a terminal, in a clone of this repository. Not on the
published site: the API wants a token Microsoft issues inside the booking app, and a
page on github.io has no way to get one.

Once:

```
git clone https://github.com/jjgerard/room-finder.git
cd room-finder
git checkout claude/upbeat-volta-azwnt1
npm install                        # Playwright, used only by the refresh
npx playwright install chromium    # the browser it drives
```

Then, each time:

```
node tools/fetch-term.mjs --term autumn --refresh
```

On the very first run add `--url https://…/app/booking-types/<id>` — your booking-type
page. It is saved to `.auth/config.json` and never asked for again.

A real browser window opens. **Sign in yourself**, exactly as you always do; nothing
here sees a password, an MFA code, or the token's value. It then reads the term —
about 550 rooms, four at a time, two or three minutes — and writes
`timetable/data/snapshot-<term>.json`. `--refresh` prints what would change.

The signed-in profile is kept in `.auth/`, which is gitignored because it holds a live
Microsoft session. After the first run `--headless` works and it needs no attention.

To write it in — one command, which packs the site data itself:

```
node timetable/refresh.js timetable/data/snapshot-autumn.json
```

Type it as far as the space and drag the file onto the terminal window if you would
rather not type a path. `--dry-run` shows what would change and writes nothing.

`refresh.js` refuses a snapshot that has lost more than a fifth of the term, because
that is a fetch that died rather than a quiet week, and the file it would overwrite is
the only record of the timetable the site was built from.

| Option | |
|---|---|
| `--term autumn\|spring` | which term (default autumn) |
| `--from` `--to` `--week1` | override the dates; autumn runs to week 13, spring to 16 |
| `--url` | the booking-type page; first run only |
| `--out` | where to write the snapshot |
| `--headless` | no window — only once a session is saved |
| `--refresh` | print what would change, straight after |

**What a refresh does not touch.** The clash graph — which classes share students — was
inferred from the timetable as it stood, and the API carries no enrolment data, so it
stays as it is. The rebuilt terms are solutions to the old timetable too: if much has
moved, re-solve them rather than leaving them claiming to repair something that has
changed.

`docs/admin.html` does the same thing with buttons, including the change report, for
when a terminal is not to hand. `tools/term-snapshot.js` is the same reader as a
console paste, for when node is not.

## Layout

| File | What it is |
|---|---|
| `timetable/data/` | The source: `terms.json` (both terms as booked), the class and room CSVs, the two pairwise conflict files, and the correction files timetabling supplies — confirmed sizes, room types, kept slots. |
| `timetable/export.js` | Packs the model + solution into what the site loads, and copies the shared pure modules into `docs/assets`. |
| `timetable/lib/model.js` | CSVs → in-memory model. Also where the exam and same-day rules are derived. |
| `timetable/lib/components.js` | Union-find with offsets: groups classes that cannot move independently. |
| `timetable/lib/constraints.js` | The rules. Pure — runs in node and in the browser. |
| `timetable/lib/suggest.js` | "Where else could this go, and what's blocking it?" Pure. |
| `timetable/lib/solver.js` | Min-conflicts local search. |
| `timetable/test.js` | The tests. |
| `docs/` | The GitHub Pages site. `docs/assets/constraints.js`, `suggest.js` and `term-snapshot.js` are **generated copies** — edit the originals. |
| `tools/fetch-term.mjs` | Drives a signed-in browser to read a term out of Resource Booker. |
| `tools/term-snapshot.js` | The reader itself. Runs under the driver, or pasted into a console. |
| `timetable/refresh.js` | Folds a snapshot back into `terms.json`, and says what changed. |
| `timetable/seeds.js` | Packs the clean timetables a sweep found, re-checking each one. |

## The site

Served straight from `docs/` by GitHub Pages — **Settings → Pages → Deploy from a branch
→ `/docs`**. Live at **https://jjgerard.github.io/room-finder/**.

Five pages, behind one bar:

| | |
|---|---|
| **About** | How it was built, what today's method produces, and where the numbers are soft. The landing page. |
| **Timetables** ▾ | Four of them: each term as it stands, and each rebuilt. The rebuilt spring is re-checked **in the browser on load**, so its headline is verified rather than asserted. Each rebuilt term has a picker for the other clean arrangements. |
| **Fix a clash** | Pick a module and see every slot its classes could legally move to together — and for the ones they cannot, exactly what is in the way. Ranked, including two-room options when the hour has to be kept. |
| **Rooms** | Every room as a week calendar. Tick several and see them side by side, in any of the four timetables. |
| **Room needs** | Records what kind of room a module actually needs, and writes the CSV the solver reads. This is how a correction gets made. |

`docs/admin.html` is a sixth, `noindex` and not in the bar: it is for whoever refreshes
the data, and is described [above](#refreshing-from-resource-booker).

Search is **by programme first**, then module, then room — a cohort is what people
actually ask about. The terms as they stand are shown one row per class-room booking, so
a class in several rooms appears once per room.

`.github/workflows/ci.yml` does not deploy; Pages serves the folder directly. It runs
the tests and fails if the committed `docs/` differs from what `node timetable/export.js`
produces — those files are generated, and a hand-edited copy would put the site and the
solver quietly out of step, live.

## What this is not

It is a feasibility study, not a publishable timetable. Three things would have to be
fixed first, and all three are properties of the source data rather than the solver:

- **The clash graph is inferred from the current timetable**, not from enrolment or staff
  records. A student clash means "same programme and year"; a staff clash is a proxy
  (same school, shared dominant room, never currently overlapping). It both
  over-constrains and under-constrains.
- **Class sizes are room capacities, not headcounts** for most classes. Timetabling has
  since confirmed 62 real figures, which is what got autumn to zero — but the rest are
  still the room a class sits in, standing in for its cohort.
- **115 of 228 rooms have no recorded capacity.** This used to leave 507 classes sitting
  in a room outside their own candidate set; with the capacity and room-type corrections
  applied that is now **none**. A class staying put is still exempt from the room-fit
  rule while a class that moves is not.

### How much does the inferred clash graph matter?

Overlap in the current timetable is *positive proof* — two classes running at the same
time cannot share a lecturer or an audience. Absence of overlap proves nothing, since
across 5 days and 13 slots most pairs miss each other by coincidence. So overlap is used
only to **remove** edges, never to add them.

Applied consistently, that is damning on paper: **476 of 948 cohorts already run their
own classes overlapping today** (so they are split into groups), and most of spring's
16,246 clash edges rest only on such cohorts. Just **2,663** are backed by something the
current timetable actually evidences. Autumn is looser still: 3,733 of 38,584.

So it was tested rather than argued about — re-solving spring with the doubtful edges
dropped, four seeds each so the three are comparable:

| Clash edges trusted | Hard | Edge slots | Gap-days | Moved |
|---|---|---|---|---|
| 2,663 — drop the unevidenced | 1 | 405 | 288 | 1,285 |
| 1,714 — also drop the staff proxy | 0 | 407 | 296 | 1,270 |
| All 16,246, as given | did not finish a single seed in 25 minutes | | | |

**Dropping another third of the clash constraints barely changes the answer** — two edge
slots and eight gap-days between them, either side of the noise between seeds. The
weakest part of the data is not what binds the problem; room availability and the
back-to-back rule are.

The full graph is a different story, and not a subtler one: where the pruned graphs do
four seeds in under ten minutes, it did not complete one in twenty-five. Inside a 9-to-5
day the pruning decides whether there is an answer at all, which is why both published
terms record the graph they used and the site says so on its face. Reproduce with
`--clashes all`, `evidenced` or `cohort`.

### Exams

An exam is not a normal class, so the one-room-per-class rule does not apply to it. Each
multi-room exam is modelled as several sub-classes pinned to the same slot, which reuses
the component machinery — they move together, and the ordinary room-clash rule stops two
of them landing in the same room. All 16 keep the number of rooms they use today — 40
rooms between them — in distinct rooms.

The same machinery carries any class that genuinely holds several rooms at once, not
just exams: that is what keeps MEC114's seven rooms and the fine art studios' fourteen.

Ten further rows titled `z Exams *Do NOT Edit or Remove booking* Sem2 Exam Set Up Week`
block 26 rooms all day, Monday to Friday, in weeks 15–16. They carry no module, no cohort
and no clash edge, and the data says not to touch them, so they are **pinned** — never
moved in day, time or room. Only their dominant room is recorded, so the other 25 are not
reserved against and weeks 15–16 availability is optimistic.

### `is_teaching=0` does not mean nobody attends

All 66 exams carry `is_teaching=0`, as do 136 lectures — yet **281 such rows have a cohort
attached**. Scoring the soft goals on the teaching flag made all of them free to place,
and exams were duly pushed into Friday evening at no cost. The soft goals count every
class a cohort attends instead, which is why the edge-slot baseline reads 668 for spring
here rather than the smaller number a teaching-only count gives.

One-off `BK` room bookings are excluded entirely — 540 rows where a named person booked
a room on a specific date, with no module, cohort or place in the clash graph. They were
specific to spring 2026 and are not rescheduled, so their rooms are not reserved here
either.
