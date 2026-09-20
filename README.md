# Ulster Room Finder

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

While this repository is private, anyone you send it to needs to be signed in to GitHub
with access to it before that download link will work. Adding them as a collaborator, or
making the repository public, both fix that — as does sending them the unzipped folder
directly.

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

# Belfast Spring timetable

A second, self-contained piece of work in this repository: a solver that rebuilds
Ulster Belfast's Spring 2026 timetable so that **every class has one room and no hard
rule is broken**, plus a companion site that shows the result and lets you try moves of
your own.

The extension answers *"is this room free?"* against live booking data. This answers
*"could the whole term be arranged better?"* against a snapshot. Same problem, opposite
ends.

## The result

Starting from a spring timetable with **309 room double-bookings** (once every
multi-room class is collapsed into a single room) and **75 lecture/seminar pairs running
with a gap**:

| | Today | Rebuilt |
|---|---|---|
| Room double-bookings | 309 | **0** |
| Cohort / staff clashes | 0 | **0** |
| Lecture+seminar back-to-back | 73 of 146 | **146 of 146** |
| Block teaching sent off campus | — | **none** |
| Classes in 9–10am / 4–5pm edge slots | 391 | **255** |
| Cohort gap-days | 399 | **205** |
| Classes left untouched | — | 912 of 1,532 |

Two results contradict the earlier analysis this work started from, which concluded that
~27 modules could never be back-to-back and that three all-day sessions had to move
offsite. Both turned out to be achievable. The difference is not a better search — it is
that a linked group is represented as **one object with a fixed internal offset**, so
contiguity is a property of the representation rather than something a search has to
achieve and then defend against its own later repairs.

## Running it

Node 18+, no dependencies.

```
node timetable/test.js                              # 56 checks
node timetable/solve.js --seeds 30 --out docs/data  # rebuild the timetable
node timetable/export.js                            # pack the data the site loads
```

`solve.js` restarts from many seeds and keeps the best, because the search plateaus in
seconds — restarts buy far more than a longer single run.

## Layout

| File | What it is |
|---|---|
| `timetable/data/` | The source CSVs: classes, rooms, and the two pairwise conflict files. |
| `timetable/lib/model.js` | CSVs → in-memory model. Also where the exam and same-day rules are derived. |
| `timetable/lib/components.js` | Union-find with offsets: groups classes that cannot move independently. |
| `timetable/lib/constraints.js` | The rules. Pure — runs in node and in the browser. |
| `timetable/lib/suggest.js` | "Where else could this go, and what's blocking it?" Pure. |
| `timetable/lib/solver.js` | Min-conflicts local search. |
| `timetable/test.js` | The tests. |
| `docs/` | The GitHub Pages site. `docs/assets/constraints.js` and `suggest.js` are **generated copies** — edit the originals. |

## The site

Four pages, served from `docs/` via GitHub Pages (Settings → Pages → source: the
development branch, `/docs` folder):

- **The result** — what holds and what it cost. The rules are re-checked **in the
  browser on page load**, so the headline claim is verified rather than asserted.
- **Timetable** — week grid and list, current vs rebuilt, filterable.
- **Explore moves** — pick a class, see every slot it could legally move to, and for the
  ones it can't, exactly what is in the way. Same idea as the extension's alternatives
  engine, applied to a whole term.
- **Method** — how it works and where the numbers are soft.

## What this is not

It is a feasibility study, not a publishable timetable. Three things would have to be
fixed first, and all three are properties of the source data rather than the solver:

- **The clash graph is inferred from the current timetable**, not from enrolment or staff
  records. A student clash means "same programme and year"; a staff clash is a proxy
  (same school, shared dominant room, never currently overlapping). It both
  over-constrains and under-constrains.
- **Class sizes are room capacities, not headcounts** — for all but 17 of 1,532 rows.
- **138 of 228 rooms have no recorded capacity**, which is why 507 classes currently sit
  in a room outside their own candidate set, and why a class staying put is exempt from
  the room-fit rule while a class that moves is not.

### How much does the inferred clash graph matter?

Overlap in the current timetable is *positive proof* — two classes running at the same
time cannot share a lecturer or an audience. Absence of overlap proves nothing, since
across 5 days and 13 slots most pairs miss each other by coincidence. So overlap is used
only to **remove** edges, never to add them.

Applied consistently, that is damning on paper: **353 of 948 cohorts already run their own
classes overlapping today** (so they are split into groups), and **12,702 of 16,246 clash
edges rest only on such cohorts**. Only 2,595 edges are backed by a cohort that never
overlaps internally.

So it was tested rather than argued about — re-solving with the doubtful edges dropped:

| Clash edges trusted | Hard | Edge slots | Gap-days | Moved |
|---|---|---|---|---|
| All 16,246, as given | 0 | 255 | 205 | 620 |
| 3,544 — drop the unevidenced | 0 | 222 | 194 | 594 |
| 2,595 — also drop the staff proxy | 0 | 211 | 189 | 622 |

**Dropping 84% of the clash constraints barely changes the answer.** The weakest part of
the data is not what binds the problem — room availability and the back-to-back rule are.
Reproduce with `--clashes evidenced` or `--clashes cohort`.

Exams deserve their own warning: some currently run across 26 rooms, and the size proxy
reads only the dominant one. Putting such an exam in a single room is almost certainly
wrong. One-off `BK` room bookings are excluded entirely — they were specific to spring
2026 and carry no module, cohort or clash information.
