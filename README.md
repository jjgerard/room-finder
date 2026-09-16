# Ulster Room Finder

A browser extension that finds rooms free in a **recurring slot** — "which rooms seating
45+ in BC or BD are free 12:15–13:15 every Monday from 28 Sep to 7 Dec?" — in Ulster
University's Scientia Resource Booker.

Clicking through the booking UI room by room does not scale: ~550 rooms against a
twelve-week term is thousands of clicks. This drives the booking app's own JSON API
instead, from inside the tab you are already signed in to, and prints the answer as a
table.

It is **read-only**. It lists rooms and reads busy times. It never submits a booking
request — that booking type is view-only anyway, and bookings go through Ulster's
Timetabling and Attendance contact form.

## How it handles your login

It doesn't. You sign in to Resource Booker yourself, exactly as you always do, through
Microsoft SSO. The extension then reuses the authorisation header the booking app
attaches to its *own* requests, without reading the token's value.

Concretely, that means:

- no password, MFA code or token is seen, stored, or sent anywhere;
- no server of ours exists, so there is nothing to send it to;
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
4. Fill in the slot and hit **Search**.

The booking type is read from the URL, so the same extension works for any booking type
you have access to — nothing to configure.

| Field | What it does |
|---|---|
| **Campus prefix** | `B_` Belfast, `C_` Coleraine, `M_` Derry/Londonderry. Blank returns everything (~550 rooms — slow). |
| **Buildings** | Belfast blocks are the two letters after the prefix: `B_BC-03-104` is block BC. Comma-separate, or leave blank. |
| **Min capacity** | Filtered by the room's real Capacity property, server-side — not by the number in the room's name, which is often missing. |
| **Dates / Weekdays / Time** | The recurring slot. Every matching date in the range is checked. |
| **Show up to N clashes** | `0` lists only rooms free on every single date. `2` also shows "free 10 of 12 Mondays", which is often the more useful answer. |
| **Ordinary teaching rooms only** | Drops labs, studios and specialist space by name. Everything it removed is listed under the results so you can see what was taken out and re-run without it. |
| **Count pending booking requests as busy** | Pending requests don't appear in busy times, so a room can look free when someone is already asking for it. |

## Things it gets right that are easy to get wrong

These are the traps, and the reason a naive version of this tool quietly returns wrong
answers:

- **Timezone.** The API returns `StartDateTime` as true UTC while serialising it with a
  `+00:00` offset. During BST that is an hour behind what the UI shows, and a Sept–Dec
  term crosses the October clock change — so wall-clock arithmetic corrupts roughly half
  the results. Every instant here goes through `Europe/London`.
- **Phantom rooms.** Records named `BT Room …` mirror real Belfast rooms but carry zero
  events. They look gloriously free. Any room with no events at all across the whole
  period is treated as a shell record and listed separately rather than reported as
  available.
- **Session expiry.** Bulk fetching runs out of token after a few minutes. Searches
  retry through a refresh rather than failing half-done.
- **Boundary dates.** Busy times are fetched a day wider than asked and filtered
  locally, so nothing falls through the UTC/local seam.

## Verify before you rely on it

The results table links each room to its own day view in the booking app. **Check two of
them** before acting — one date inside BST and one after the October clock change. That
single habit catches every category of error above.

## Known limits and unverified bits

- **The Capacity property GUID** (`71bd4589-…` in `content.js`) is Ulster's. Another
  Scientia tenant would need its own. To re-derive it: set the capacity Minimum field in
  the app's UI and read the request the app sends.
- **The pending-requests response shape** is read defensively — items are used when they
  carry `StartDateTime` and `Duration`, and ignored otherwise. This has had less exposure
  than the busy-times path; if pending bookings seem to be missed, that's the first place
  to look.
- **The date parameter format** sent to the API (`…T00:00:00.000Z`) matches what the app
  appears to use, but the widened range means a mismatch would show up as extra results
  rather than missing ones.
- **The content script matches `*://*/app/booking-types/*`**, i.e. that path on any host,
  because Resource Booker's hostname isn't hardcoded. To narrow it, edit `matches` in
  `manifest.json` to the actual host, e.g. `"https://resourcebooker.ulster.ac.uk/app/booking-types/*"`.
- **Specialist-room exclusion is by name**, since nothing flags a lab as a lab. It will
  occasionally take out a room you wanted; that's why it shows you what it removed.
- Results are capped at 40 rooms to keep the capacity lookups quick.

## Tests

```
node test.js
```

Covers the date/time core — UTC-to-London conversion either side of the October clock
change, the half-open overlap test, events running past midnight, and weekday
generation across a term. The rest needs a signed-in session to exercise, but this is
the part that goes wrong quietly.
