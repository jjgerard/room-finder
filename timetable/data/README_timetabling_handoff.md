# Belfast Campus Timetabling — Handoff Pack

Snapshot of the **current Spring 2026** Ulster Belfast timetable, tagged with everything needed to
re-solve it from scratch. Goal of the project: give **every class a single room** (today many are
split across 2–3 rooms) while breaking no student/staff clash.

## Files

| File | What it is |
|---|---|
| `belfast_classes.csv` | One row per class (2,072). All attributes + constraint tags. |
| `conflicts_cannot_share_time.csv` | Pairwise "these two classes share students or staff — never overlap in time." Class-id level (16k+ pairs). |
| `cannot_share_day.csv` | Pairwise "these two classes may not fall on the same **day**" (unless they already do today). |
| `belfast_rooms.csv` | Room inventory: id, name, type, capacity (228 rooms). |

Join keys: `class_id` links the three class files; `current_room` / `candidate_rooms` are room **names**,
`room_id` in `belfast_rooms.csv` is the index.

## `belfast_classes.csv` columns

- `class_id` — stable id, used in the conflict files.
- `module`, `activity` (LEC/SEM/TUT/LAB/WOR/EXM/…), `title`.
- `programmes` — degree programmes that take this module (`;`-separated); `n_programmes`, `year_level` (1st digit of code).
- `size_estimate` — **proxy** for class size. `size_basis` says how: `room_capacity_proxy` (the current room's seats) for most, `known_headcount` for a handful. **Real enrolment figures are NOT in this data** — treat sizes as approximate.
- `current_day`, `current_start`, `current_end`, `duration_min` — current slot.
- `current_room`, `current_room_type` (general / theatre / computer / specialist), `current_room_capacity`.
- `n_current_rooms`, `is_multi_room` — `is_multi_room=1` is the problem to fix (class split across ≥2 rooms of its type).
- `weeks`, `n_weeks` — teaching weeks (1–16).
- `is_teaching`, `is_block_teaching` (≥5h continuous), `recommend_offsite` (see below).
- `linked_group`, `group_order` — classes with the same `linked_group` are the same module on the same day (a lecture + its seminar/tutorial). They must stay **same day, back-to-back, in `group_order`**.
- `n_candidate_rooms`, `candidate_rooms` — the rooms this class **could** be placed in (right type, capacity ≥ size). This is the movability set.
- `n_cannot_share_time`, `cannot_share_time_modules` — human-readable module summary; use the pairwise file for precision. (Includes the module's own other sessions.)
- `cannot_share_day_modules` — human-readable summary of the same-day restriction.

## Constraint model

**Hard (must hold):**
1. **No student/staff clash** — two classes joined in `conflicts_cannot_share_time.csv` must not overlap in time in any shared week.
2. **One room per class** — each class occupies a single room; no two classes share a room at the same time in a shared week (room double-booking).
3. **Room fit** — a class can only go in a room of the right type and capacity ≥ its size (`candidate_rooms`).
4. **Lecture + seminar same day & back-to-back** — every `linked_group` stays on one day, contiguous, in `group_order`. *(See caveat below — not fully achievable.)*
5. **No new same-day programme pairings** — pairs in `cannot_share_day.csv` may not be put on the same day unless they already are today.

**Soft (optimise, in priority order):**
1. Fewest classes in the unpopular **9–10am** and **4–5pm** edge slots.
2. **Wednesday afternoons** as free as possible.
3. Each programme's classes on **consecutive days** where possible.

## What we already know (learnings)

- **Rooms are ~2/3 empty** — this is not a room-shortage problem. Most multi-room classes resolve with a simple room swap; only a minority need a time move.
- **Min-conflicts local search** (repair loop) reaches zero clashes / one-room-per-class for the whole campus. A from-scratch ILP (CBC/PuLP) was **intractable** at this scale; commercial solver (Gurobi) or local search recommended.
- **Block teaching** (≥5h all-day sessions) is the one thing rooms can't absorb. Exactly **3** sessions (`NUS762/LEC`, `NUS767/LEC`, `BUS506/LEC`, flagged `recommend_offsite=1`) must move off-campus to reach a fully clean solution.
- **Back-to-back lecture/seminar is impossible for ~27 modules** (e.g. CMM151). Their year-group has classes scattered through every weekday, so **no free 4-hour window exists on any day** to hold a contiguous lecture+seminar. Best achievable: ~95 of 136 pairs back-to-back, the rest same-day with a gap. Enforce constraint 4 as "prefer back-to-back, fall back to same-day."

## Important caveats

- The **conflict graph is inferred from the current timetable**, not from enrolment/staff records:
  - *Student clash* = classes sharing a programme + year (cohort).
  - *Staff clash* = same school + shared dominant room + never currently overlapping (a proxy for "same lecturer").
  This can both over-constrain (two cohorts that don't really overlap) and under-constrain (a real shared lecturer the proxy missed). Replace with real enrolment + staff-assignment data if available.
- **Sizes are proxies** (room capacity), not headcounts.
- Weekend/non-teaching bookings (exams, events) are included as rows but `is_teaching=0`.
