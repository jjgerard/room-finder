# Timetables

A solver that rebuilds Ulster Belfast's **Autumn 2026 and Spring 2026** timetables so
every class has one room and no hard rule is broken, with a site that shows the result
and lets you search it: **https://jjgerard.github.io/timetables/**

A browser extension for live room searches lives here too — see
[Room finder](#room-finder-the-extension). Same API, opposite ends: the extension asks
*"is this room free?"* against live data, the solver asks *"could the whole term be
arranged better?"* against a snapshot.

## The result

**Spring rebuilds to zero hard-rule violations. Autumn gets to four**, all of them two
classes wanting one room — against 123 and 41 in the timetables as they stand. Checked by
the same code that enforced them, and spring re-checked in your browser on every page load.

| | Autumn, today | Autumn, rebuilt | Spring, today | Spring, rebuilt |
|---|---|---|---|---|
| Lecture+seminar pulled apart | 0 of 218 | **0** | 75 of 146 | **0** |
| A session outside 09:15–17:15 | 41 | **0**\* | 48 | **0**\* |
| A class moving between rooms mid-term | 15 | **0** | 35 | **0** |
| Two classes in one room at once | 0 | **4** | 0 | **0** |
| A cohort or lecturer in two places | 0 | **0** | 0 | **0** |
| Classes in the 9–10 or 4–5 edge slots | 698 | **423** | 658 | **387** |
| Cohort gap-days | 429 | **337** | 408 | **291** |
| Classes left exactly where they are | — | 547 of 2,037 | — | 597 of 1,844 |

\* Nineteen sessions still finish after 17:15 — eleven in spring, eight in autumn.
Seventeen belong to a chain longer than a teaching day, which cannot fit inside one
whatever moves; the other two are chained in front of a pinned evening session. The rule
excuses both from the *end* of the day and neither from its start, and the site names
them rather than pretending they are inside it.

**Neither result is one lucky shuffle.** The search starts from a random arrangement, so
both terms were run from 30 starting points against the same rules:

| | Reached zero | Ended on 1 | on 2 | on 3 | on 4+ |
|---|---|---|---|---|---|
| Spring 2026 | **9 of 30** | 9 | 8 | 2 | 2 |
| Autumn 2026 | **0 of 30** | — | — | — | 30, the best of them on 4 |

Every one of spring's nine clean timetables is published, not just the one the site is
built from; the picker at the top of a rebuilt term switches between them.

### What counts as one class

A booking is not a class. The timetable records one class as several: ARC524's lecture is
three bookings at the same hour in different weeks, BEN147's is nine — eight at 09:15 and
one at 12:15 because something clashed that week. Counted as bookings the pieces can take
a room each, and an earlier rebuild put 105 autumn classes in different rooms for
different weeks: the exact fault the rebuild exists to remove.

So same module, same activity, same duration, non-overlapping weeks is now **one class**,
holding one room and one hour across the term. Spring got *better* under that rule (9 of
30 starting points reach zero, against 6) because there is less to place; autumn got worse
and no longer reaches zero at all, because it merges 169 classes against spring's 26 and
each merge spends slack.

Four autumn slots run at two different **durations** in different weeks — MKT703's lecture
is two hours in weeks 5 and 7 and three in the other ten — so they stay two classes, with
a rule that the pair must agree on a room. That rule is deliberately narrow: 130 autumn
slots share a title, day and start and are genuine parallel teaching whose weeks overlap.
What marks the four out is that their weeks never do.

**Two rooms at once is not the fault being fixed.** A booking holding several rooms in one
hour is parallel teaching, and the rebuild books every one: MEC114's tutorial teaches 350
students in seven rooms, the fine art studios keep fourteen.

**Getting autumn there took corrections, not a better search** — 62 confirmed cohort sizes
from timetabling, two classes told what kind of room they need, two told which room, one
told to keep its slot. Five modules were believed to need all 350 seats of Lecture Theatre
1 because that is where they sit; only one does.

A seed names a *search*, not a timetable, and only under one version of the rules and one
version of the data. `export.js` compares the published sweep against the file actually
shipped, and the site says so itself when they part company.

## Running it

Node 18+, no dependencies (only the refresh below needs any).

```
node timetable/test.js                          # the checks
node timetable/export.js                        # pack the site data
node timetable/solve.js --term spring --seeds 30 --clashes evidenced --out docs/data
node timetable/solve.js --term autumn --seeds 30 --clashes evidenced --out docs/data
```

118 checks: the rules themselves, the solver never making a timetable worse, the model's
own cost agreeing with the independent checker, and each thing that went wrong once and
would go wrong quietly again — the teaching day the solver grades itself against being the
one the site enforces; a class dragged past 17:15 by a pinned chain exempt from the end of
the day but never its start; neither rebuilt term splitting a class across rooms; a
refresh saying *which kind* of room it could not match; the repair after a refresh decided
on the solution rather than the snapshot. The About page is **rendered**, not just parsed:
a scope slip once shipped a page reading only `H is not defined` while every test passed.

`solve.js` restarts from many seeds and keeps the best — the search plateaus in seconds, so
restarts buy far more than a longer run. It prints every seed, which answers both "what is
the best arrangement" and "how many starting points reach zero at all".
`timetable/seeds.js` packs the clean ones for the site, re-checking each against a freshly
loaded model first: a seed is published as clean because it checks clean now, not because a
log said so when it ran.

Solving into `docs/data` runs the export for you, since `solution.json` and
`docs/data/timetable.json` are a pair. Changing the model or data without re-solving needs
the export too — CI fails if the committed `docs/` is not what it produces. Run
`git config core.hooksPath .githooks` once and the pre-commit hook handles it.

## Refreshing from Resource Booker

The "as it stands" timetables come from a snapshot, refreshed **on your own computer**, in
a clone of this repository — not from the published site, since the API wants a token
Microsoft issues inside the booking app.

```
git clone https://github.com/jjgerard/timetables.git
cd timetables
npm install && npx playwright install chromium   # used only by the refresh

node tools/fetch-term.mjs --term autumn --refresh
```

On the first run add `--url https://…/app/booking-types/<id>`; it is saved to
`.auth/config.json`. A real browser window opens — **sign in yourself**; nothing here sees
a password, an MFA code, or the token's value. It reads the term (about 550 rooms, two or
three minutes) into `timetable/data/snapshot-<term>.json`. The signed-in profile is kept in
the gitignored `.auth/`, after which `--headless` works.

To write it in — **pull first**, then one command:

```
git pull
node timetable/refresh.js timetable/data/snapshot-autumn.json
git add -A ; git commit -m "Refresh autumn" ; git push
```

The pull belongs before the refresh: both write into `docs/`, so a pull afterwards is
refused for the files the refresh just changed. `--dry-run` shows what would change and
writes nothing.

That one command compares, writes `terms.json`, writes every change to
`<snapshot>-changes.txt`, **repairs** the rebuilt term for whatever moved, and packs the
site data. The repair comes before the export, which is not an implementation detail: the
other order publishes a rebuild full of violations and trusts a second command to clear
them. Whether to repair is a question about the *solution*, not the snapshot — it joins the
published solution to the refreshed term and repairs when any class has no placement or
any placement has no class. A repair re-places only what moved: a second or so, against an
hour for a full solve, and only ever as good as the arrangement it starts from.

`refresh.js` refuses a snapshot that has lost more than a fifth of the term — that is a
fetch that died, not a quiet week. Rooms it cannot match are reported in two lines: one in
a building the site models is a real gap that loses bookings every refresh, while one in no
modelled building (`JSV Reception Beacon`, say) is space the inventory should not carry.

| Option | |
|---|---|
| `--term autumn\|spring` | which term (default autumn) |
| `--from` `--to` `--week1` | override the dates; autumn runs to week 13, spring to 16 |
| `--url` | the booking-type page; first run only |
| `--out` | where to write the snapshot |
| `--headless` | no window — only once a session is saved |
| `--refresh` | print what would change, straight after |

**What a refresh does not touch:** the clash graph. It was inferred from the timetable as
it stood and the API carries no enrolment data, so if much has moved, re-solve rather than
repair.

`docs/admin.html` does the same with buttons, including the full change report, and runs
`lib/diff.js` — the same comparison `refresh.js` uses, because the page and the script were
once separate copies and drifted.

## The site

Served straight from `docs/` by GitHub Pages (**Settings → Pages → Deploy from a branch →
`/docs`**). Five pages behind one bar:

| | |
|---|---|
| **About** | How it was built, what today's method produces, where the numbers are soft. The landing page. |
| **Timetables** ▾ | Each term as it stands and each rebuilt. Rebuilt spring is re-checked **in the browser on load**; each rebuilt term has a picker for the other clean arrangements. |
| **Find a free room** | Give days, time, weeks, seats, buildings, room type — get the rooms free in every week you ticked, smallest first, then near misses with what takes them. |
| **Search rooms** | Every room as a week calendar; tick several to compare side by side. |
| **Room needs** | Records what kind of room a module actually needs, and writes the CSV the solver reads. |

`docs/admin.html` is a sixth, `noindex` and not in the bar. Search is **by programme
first**, then module, then room — a cohort is what people actually ask about. CI runs the
tests and fails if the committed `docs/` differs from what `node timetable/export.js`
produces; Pages serves the folder directly.

## Layout

| File | What it is |
|---|---|
| `timetable/data/` | The source: `terms.json` (both terms as booked), class and room CSVs, the two pairwise conflict files, and timetabling's corrections. |
| `timetable/lib/model.js` | CSVs → in-memory model. Where classes are merged and the exam and same-day rules are derived. |
| `timetable/lib/components.js` | Union-find with offsets: groups classes that cannot move independently. |
| `timetable/lib/constraints.js` | The rules. Pure — runs in node and in the browser. |
| `timetable/lib/solver.js` | Min-conflicts local search. |
| `timetable/lib/suggest.js` | "Where else could this go, and what's blocking it?" Pure. |
| `timetable/lib/join.js` | Attaches a saved solution to a model by what a class *is* — title, day, start, room — not by position. Joining by id turned 0 violations into 7,263, because a refresh shifts every id after the first change. |
| `timetable/lib/diff.js` | One snapshot comparison, used by `refresh.js` and the refresh page. |
| `timetable/export.js` | Packs model + solution into what the site loads; copies the shared pure modules into `docs/assets`. |
| `timetable/refresh.js` | Folds a snapshot back into `terms.json`, says what changed, repairs, exports. |
| `timetable/seeds.js` | Packs the clean timetables a sweep found, re-checking each. |
| `timetable/labs.js` | The CEBE lab analysis behind the About page's **One room**. |
| `timetable/experiments/` | One-off studies a page quotes. `cebe-fence.js` is the ring-fence run; about an hour. |
| `tools/fetch-term.mjs` | Drives a signed-in browser to read a term out of Resource Booker. |
| `tools/term-snapshot.js` | The reader itself. Runs under the driver, or pasted into a console. |
| `docs/` | The Pages site. `docs/assets/constraints.js`, `suggest.js`, `diff.js` and `term-snapshot.js` are **generated copies** — edit the originals. |

## What this is not

A feasibility study, not a publishable timetable. Three things would have to be fixed
first, and all three are properties of the source data:

- **The clash graph is inferred from the current timetable**, not from enrolment or staff
  records. A student clash means "same programme and year"; a staff clash is a proxy. It
  both over- and under-constrains.
- **Class sizes are room capacities, not headcounts**, for most classes — 62 real figures
  aside.
- **115 of 228 rooms have no recorded capacity.** That used to leave 507 classes sitting in
  a room outside their own candidate set; with the corrections applied it is now none.

### How much does the inferred clash graph matter?

Two classes running at the same time today cannot share a lecturer or an audience, so
overlap is *positive proof* — but absence of overlap proves nothing, since across 5 days
and 13 slots most pairs miss each other by coincidence. Overlap is therefore used only to
**remove** edges, never to add them. Applied consistently that is damning: **476 of 948
cohorts already run their own classes overlapping today**, and only 2,663 of spring's
16,246 clash edges are evidenced by the current timetable. Autumn: 3,733 of 38,584.

| Clash edges trusted (spring) | Hard | Edge slots | Gap-days | Moved |
|---|---|---|---|---|
| 2,663 — drop the unevidenced | 1 | 405 | 288 | 1,285 |
| 1,714 — also drop the staff proxy | 0 | 407 | 296 | 1,270 |
| All 16,246, as given | did not finish a single seed in 25 minutes | | | |

**Dropping another third of the constraints barely changes the answer** — two edge slots
and eight gap-days, inside the noise between seeds. The weakest part of the data is not
what binds the problem; room availability and the back-to-back rule are. The full graph is
a different story: inside a 9-to-5 day the pruning decides whether there is an answer at
all, which is why both published terms record the graph they used. Reproduce with
`--clashes all`, `evidenced` or `cohort`.

### Exams and pinned rows

An exam is not a normal class, so the one-room rule does not apply. Each multi-room exam is
several sub-classes pinned to one slot — they move together, and the ordinary room-clash
rule keeps them apart. All 16 keep the rooms they use today, 40 between them. The same
machinery carries any class genuinely holding several rooms at once.

Ten rows titled `z Exams *Do NOT Edit or Remove booking*` block 26 rooms all day in weeks
15–16. They carry no module, cohort or clash edge and the data says not to touch them, so
they are **pinned**. Only their dominant room is recorded, so weeks 15–16 availability is
optimistic.

**`is_teaching=0` does not mean nobody attends.** All 66 exams carry it, as do 136
lectures — yet 281 such rows have a cohort attached. Scoring the soft goals on that flag
made them free to place, and exams were duly pushed into Friday evening at no cost; the
soft goals count every class a cohort attends instead. One-off `BK` bookings are excluded
entirely: 540 rows where a named person booked a room on a date, with no module, cohort or
place in the clash graph.

---

# Room finder, the extension

A browser extension for Ulster's Scientia Resource Booker. Ask it a question in your own
words:

> rooms seating 45+ in BC or BD free 12:15–13:15 every Monday from 28 Sep to 7 Dec

and it answers in words, not just a grid:

> **Nothing in the 34 rooms searched is free at 12:15–13:15 on all 11 dates.** Closest miss
> is B_BC-01-002 (48), busy on one date only (2 Nov) — taken by CMM125_S1/LEC/01 12:00–14:00.
> Move the slot to 12:45–13:45 and 4 rooms are free on every date.

Clicking through the booking UI room by room does not scale: ~550 rooms across a twelve-week
term is thousands of clicks, and the UI only ever tells you about one room in one week.

It is **read-only** — it lists rooms and reads busy times, and never submits a booking
request.

### How it handles your login

It doesn't. You sign in to Resource Booker yourself through Microsoft SSO; the extension
reuses the authorisation header the booking app attaches to its *own* requests, without
reading the token's value. No password, MFA code or token is seen or stored; **no API key
of any kind** — the question is parsed in your browser, by rules, with nothing leaving the
page; no server of ours exists; and `manifest.json` asks for **no permissions at all**. If
your session expires mid-search it nudges the app's UI to refresh its own session, the same
thing you would do by clicking a calendar arrow.

### Install

No store listing, so it loads unpacked.

**Chrome / Edge** (111+): download the repository (**Code → Download ZIP**) and unzip, or
`git clone https://github.com/jjgerard/timetables.git`. Go to `chrome://extensions`, turn on
**Developer mode**, click **Load unpacked**, pick the folder containing `manifest.json`.

**Firefox** (128+): `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
pick `manifest.json`. Firefox clears temporary add-ons on close.

### Use

Open Resource Booker and sign in. Click something in the app — the room search box, a
calendar arrow — so it issues its first authenticated request, which is what the extension
latches on to. Then **Find rooms**, bottom right. The booking type is read from the URL, so
it works for any you have access to.

### What it understands

Anything it can't place is listed back as "Ignored: …" rather than silently misread.

| You write | It reads |
|---|---|
| `12:15-13:15`, `12.15 to 1.15`, `9-11`, `2pm-4pm`, `2-4` | the slot — a bare `2-4` is the afternoon, `9-11` the morning |
| `Wednesday afternoons`, `Monday mornings`, `lunchtime` | 13:00–17:00, 09:00–13:00, 12:00–14:00 |
| `at 10 for 2 hours` | 10:00–12:00 |
| `every Monday`, `Tuesdays and Thursdays`, `weekdays`, `Mon-Fri` | which days |
| `from 28 Sep to 7 Dec`, `28/09 to 07/12`, `until 7 Dec`, `next 10 weeks` | the range; a bare month rolls forward, never into the past |
| `seating 45+`, `for 50 people`, `at least 20 seats` | the capacity floor, applied server-side against the real Capacity property |
| `Belfast`, `Coleraine`, `Magee`/`Derry` | the campus |
| `in BC or BD`, `blocks bc and bd` | Belfast blocks — the two letters after the prefix, as in `B_BC-03-104` |
| `including labs`, `any room` | keeps labs and studios in |
| `allow 1 clash`, `free every week` | how much imperfection you'll take |
| `where is CMM125`, `why isn't CMM125 in its usual room` | switches to module lookup |

It will not understand genuinely unusual wording; the read-back shows you immediately, and
**Refine by hand** has every field as a control.

Answers give rooms free on every date with real capacities, then near misses *with their
shape* (three dates in a row in the middle is not three scattered dates), then what would
open it up — shifting the slot smallest-shift-first, accepting a clash, dropping the
capacity floor, widening the blocks, putting the filtered labs back. Each is a button.
Module lookup splits missing weeks into the two cases that need different fixes: the room
is *free* (the event's week pattern just doesn't cover that week, so nobody has to move)
versus *taken* (named, with times).

### Traps a naive version falls into

- **Timezone.** The API returns `StartDateTime` as true UTC while serialising it with a
  `+00:00` offset. During BST that is an hour behind the UI, and a Sept–Dec term crosses the
  October change — so wall-clock arithmetic corrupts half the results. Every instant goes
  through `Europe/London`.
- **Phantom rooms.** Records named `BT Room …` mirror real Belfast rooms and carry zero
  events, so they look gloriously free. A room with no events at all is reported as a shell,
  not as available.
- **Session expiry.** Bulk fetching runs out of token in minutes; searches retry through a
  refresh rather than failing half-done.
- **Boundary dates.** Busy times are fetched a day wider than asked and filtered locally.

**Verify before you rely on it.** Every room links to its own day view in the booking app.
Check two — one date inside BST, one after the October change. That habit catches every
category of error above.

### Known limits

- **The parser is rules, not comprehension**; treat the read-back as part of the answer.
- **"This term" is guessed** as the next 12 weeks — there is no access to the academic
  calendar. Give real dates when it matters.
- **Module week numbers are not institutional**: the module view lists dates.
- **The Capacity property GUID** (`71bd4589-…` in `content.js`) is Ulster's. Re-derive it
  for another tenant by setting the capacity Minimum field and reading the request.
- **The pending-requests response shape** is read defensively and has had less exposure than
  the busy-times path.
- **The content script matches `*://*/app/booking-types/*`** on any host, since Resource
  Booker's hostname isn't hardcoded. Narrow `matches` in `manifest.json` to pin it.
- **Specialist-room exclusion is by name**, since nothing flags a lab as a lab; it shows
  what it removed and offers to put them back.
- Results are capped at 40 rooms.

| File | What it is |
|---|---|
| `parse.js` | question → search. Pure, no DOM, no network. |
| `analyse.js` | busy times → what fits, what nearly fits, what would open it up. Pure. |
| `content.js` | auth capture, the API calls, the panel. |
| `test.js` | 99 checks — `node test.js`. |
