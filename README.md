# Timetables

Rebuilds Ulster University's Autumn and Spring timetables for the Belfast campus so that every class has one room
and no hard rule is broken, and publishes the result as a site you can search:
**https://jjgerard.github.io/timetables/** — which is where the current figures live, kept
in step with the data rather than written down here.

A browser extension for live room searches lives here too — see [the extension](#the-extension).

## How the solver works

- **A class is a class, not a booking.** The timetable records one class as several rows —
  the same lecture in different weeks, sometimes at a different hour because something
  clashed once. Rows that share a module, an activity and a duration and never overlap in
  weeks are merged into one class, which must then hold one room and one hour across the
  term. Without that, the pieces can each take a room and the rebuild "solves" a fault it
  was built to remove.
- **Anything that cannot move independently is one object.** A lecture and its seminar,
  the sittings of a multi-room exam, a class holding several rooms at once: union-find
  with offsets groups them, so contiguity is a property of the representation rather than
  something the search has to achieve and then defend against its own later repairs.
- **The hard rules** are one room per class, no two classes in a room at once, no cohort
  or lecturer in two places, lecture and seminar back-to-back and in order, room type and
  size, exams in their usual slot, and the teaching day. Sessions longer than a day, and
  classes dragged past the end by a pinned chain, are excused the *end* of the day and
  never its start.
- **The soft goals** are fewer classes in the first and last slots of the day, and fewer
  days a cohort attends for one class alone.
- **Min-conflicts, from many starting points.** The search plateaus in seconds, so
  restarts buy far more than a longer run. Every seed is reported, which answers both
  "what is the best arrangement" and "how many starts reach zero at all".
- **The clash graph is inferred**, since the data carries no enrolment. Two classes
  running at the same time today cannot share an audience, so overlap is used to *remove*
  edges; absence of overlap proves nothing and never adds one. Each published term records
  which graph it was solved against.

## Running it

Node 18+, no dependencies (only the refresh needs any).

```
node timetable/test.js                          # the checks
node timetable/export.js                        # pack the site data
node timetable/solve.js --term spring --clashes evidenced --out docs/data
node timetable/seeds.js --term spring --out docs/data --in /tmp/s4 /tmp/s13 …
```

Solving into `docs/data` runs the export, since the solution and the packed site data are
a pair. Changing the model without re-solving needs the export too — CI fails if the
committed `docs/` is not what it produces. Run `git config core.hooksPath .githooks` once
and the pre-commit hook handles it.

A seed names a *search*, not a timetable, and only under one version of the rules and one
version of the data. `seeds.js` re-checks every arrangement against a freshly loaded model
before publishing it, and the site refuses a pack that no longer matches the timetable it
offers alternatives to.

## Refreshing from Resource Booker

The "as it stands" timetables come from a snapshot, refreshed on your own computer in a
clone of this repository — not from the published site, since the API wants a token
Microsoft issues inside the booking app.

```
npm install && npx playwright install chromium   # used only by the refresh
node tools/fetch-term.mjs --term autumn --refresh

git pull
node timetable/refresh.js timetable/data/snapshot-autumn.json
```

A real browser opens; **sign in yourself** — nothing here sees a password, an MFA code or
the token's value. The pull belongs before the refresh, since both write into `docs/`.
`--dry-run` shows what would change and writes nothing.

`refresh.js` compares, records every change beside the snapshot, **repairs** the rebuilt
term for whatever moved, and packs the site data — repair first, because the other order
publishes a rebuild full of violations and trusts a second command to clear them. It
refuses a snapshot that has lost a large part of the term, since that is a fetch that died
rather than a quiet week.

**A repair is only as good as the arrangement it starts from.** It re-places what moved
in about a second, against an hour for a full solve, and a term that has drifted much
wants a proper sweep instead. `docs/admin.html` does the same with buttons.

## Layout

| File | What it is |
|---|---|
| `timetable/data/` | The source: both terms as booked, the class and room CSVs, the conflict files, and timetabling's corrections. |
| `timetable/lib/model.js` | CSVs → in-memory model. Where classes are merged and the exam and same-day rules are derived. |
| `timetable/lib/components.js` | Union-find with offsets: what cannot move independently. |
| `timetable/lib/constraints.js` | The rules. Pure — runs in node and in the browser. |
| `timetable/lib/solver.js` | Min-conflicts local search. |
| `timetable/lib/suggest.js` | "Where else could this go, and what's blocking it?" Pure. |
| `timetable/lib/join.js` | Attaches a saved solution to a model by what a class *is* — title, day, start, room — not by position, since a refresh shifts every id after the first change. |
| `timetable/lib/diff.js` | One snapshot comparison, used by `refresh.js` and the refresh page. |
| `timetable/export.js` | Packs model + solution for the site; copies the shared pure modules into `docs/assets`. |
| `timetable/refresh.js` | Folds a snapshot back in, says what changed, repairs, exports. |
| `timetable/seeds.js` | Packs the alternative timetables a sweep found, re-checking each. |
| `timetable/labs.js`, `timetable/experiments/` | One-off studies a page quotes. |
| `tools/fetch-term.mjs` | Drives a signed-in browser to read a term out of Resource Booker. |
| `docs/` | The Pages site (**Settings → Pages → Deploy from a branch → `/docs`**). `docs/assets/constraints.js`, `suggest.js`, `diff.js` and `term-snapshot.js` are **generated copies** — edit the originals. |

Six pages: **About**, **Timetables** (each term as it stands and rebuilt, with a picker for
the alternative arrangements), **Find a free room**, **Search rooms**, **Ubook extension**
and **Room needs**, which writes the CSV a correction goes into. Search is by programme
first — a cohort is what people actually ask about.

## The UBook extension

A browser extension for Resource Booker. Ask it in plain words — *rooms seating 45+ in BC
or BD free 12:15–13:15 every Monday from 28 Sep to 7 Dec* — and it answers in words:
what's free on every date, what nearly is and in what shape, and what would open it up.
Clicking through the booking UI room by room does not scale, and it only ever answers for
one room in one week.

Download it from
[the site](https://jjgerard.github.io/timetables/extension.html), which also says how to
load it; `tools/pack-extension.sh` builds that zip from the four files at the top level of
this repository, and the test suite checks the archive against their CRCs so a stale
download cannot ship.

It is **read-only** and never submits a booking. It does not handle your login: you sign
in through Microsoft SSO as usual, and it reuses the authorisation header the booking app
attaches to its own requests without reading the token's value. No password, MFA code or
token is seen or stored; no API key of any kind, since the question is parsed in the
browser by rules; no server of ours exists; and `manifest.json` asks for no permissions at
all.

Three things it gets right that are easy to get wrong: the API returns `StartDateTime` as
true UTC while labelling it `+00:00`, and a term crossing the October clock change
corrupts half the results unless every instant goes through `Europe/London`; records named
`BT Room …` mirror real rooms, carry no events and look gloriously free; and bulk fetching
runs out of token in minutes, so searches retry through a refresh rather than failing
half-done. Every room links to its own day view — **check two before you rely on an
answer**, one inside British Summer Time and one after the clock change.

`parse.js` and `analyse.js` are pure and tested directly with `node test.js`; `content.js`
holds the auth capture, the API calls and the panel.
