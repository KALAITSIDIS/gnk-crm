# Browser-agent test prompt — "work a day at the desk"

Paste the block below into **Claude in Chrome** with the CRM open and logged in.
It walks the app the way a working agent would, not screen by screen, and
reports what it finds.

**Why it is written this way.** A screen-by-screen sweep finds cosmetic things
and misses the ones that cost money: a save that silently does nothing, a
number that disagrees with itself across two pages, a nudge that never fires.
Those only show up when one story runs end to end. The prompt also front-loads
the browser-automation traps that have already produced three false bug reports
and one corrupted record — see `## The traps` inside it.

**Before you run it:** decide whether to point it at production or a local
copy. Production is the honest target and the prompt is written for it, with
hard rules about what it may touch. If you would rather it ran somewhere
disposable, say so in the first line and change the URL.

---

## The prompt

> You are a new estate agent at GN Kalaitsidis Capital, a two-person agency in
> Paphos, Cyprus. Today is your first full day using the agency's CRM. I want
> you to actually work a day in it — take a lead, list a property, book a
> viewing, push a deal — and then tell me everything that got in your way.
>
> You are not auditing screens. You are trying to get work done, and I want to
> know where the tool fought you.
>
> ### Hard rules — read these twice
>
> 1. **This is the live system with real client listings in it.** The
>    properties `PAF0001`, `PAF0002`, `PAF0003`, `PAF0004` and every contact
>    already present are REAL. You may open and read them freely. You may
>    **never** edit, archive, delete, publish, unpublish, or change the status
>    of anything that already exists.
> 2. **Everything you create must be findable and removable.** Put the exact
>    string `ZZTEST` at the start of every name, title, or note you type — test
>    contacts, test properties, test leads, all of it. No exceptions.
> 3. **Clean up at the end.** Archive or delete every `ZZTEST` record you made,
>    and list anything you could not remove.
> 4. **Never enter a real person's data**, and never upload a real document or
>    photo. Invent everything.
> 5. If an action looks destructive and you did not create the thing it would
>    destroy — stop and report it instead of clicking.
>
> ### The traps — these are tool problems, not app bugs
>
> These have already caused false reports. Read them before you touch anything.
>
> - **Dropdowns (Radix selects) do not respond correctly to positional
>   clicks** — a click can land one option off, so you pick "B" and it saves
>   "C". Always select by the option's **visible text**, and after saving,
>   **re-read the field** to confirm what was actually stored. If it saved the
>   wrong value, that is this trap, not a bug — retry by text and move on.
> - **Text fields do not clear themselves.** Typing into a field that already
>   has content APPENDS. This has already corrupted a real listing's title into
>   two titles run together. Always select-all and delete first, then type,
>   then re-read the field.
> - **Tabs sometimes need a real mouse event**, not a synthetic click. If a tab
>   does not switch, that is the tool, not the app.
> - **After every save, verify by re-reading the page.** A toast is not proof.
>   Reload and confirm the value persisted. Most real bugs in this class hide
>   behind a success toast.
>
> ### The day — work these in order
>
> Do each as a real task with a real goal, not as a click-through. If something
> blocks you, try the workaround a person would try, and record both.
>
> 1. **A lead lands.** A buyer enquires about a 2-bed near the harbour, budget
>    €300k. Capture them, log the call you made back, and record what they are
>    looking for.
> 2. **Find them something.** Use the system to find matching listings. Does it
>    surface the right ones? Would you trust it in front of a client?
> 3. **List a new property.** A private owner gives you a 3-bed villa to sell.
>    Enter it fully — owner, price, area, legal status, marketing text — and
>    add a couple of photos. Then check the quality score: does it tell you
>    what is missing, and does fixing it move the number?
> 4. **Book a viewing** for your buyer at one of the real listings. Send the
>    calendar file to yourself. Then reschedule it — the buyer moved the time.
> 5. **Run the viewing.** Sign the attendance slip. Check the PDF is real and
>    that a second attendee can be named.
> 6. **An offer comes in.** Record it, then accept it, then mark the deal won
>    with the final price. Does the price reach the reports?
> 7. **Send a proposal.** Create a share link for a buyer and open it the way a
>    client would (a private window, not logged in). Does it show what it
>    should, and hide what it must — owner details, your net price, internal
>    notes?
> 8. **Quote the buyer's costs.** Use the calculators for a €300k purchase.
>    Are the numbers current, and is the copy-paste summary something you would
>    actually send?
> 9. **Do the admin.** Register a key, check today's tasks, look at the
>    dashboard and the reports. Does the system tell you what needs doing, or
>    do you have to hunt?
> 10. **Try to break it, briefly.** Save a form with required fields empty.
>     Put text where a number goes. Put a price of -5000. Enter a viewing in
>     the past. Does it refuse cleanly with a sentence you understand, or does
>     it crash, swallow it, or save nonsense?
>
> ### What to report
>
> For each finding give me:
>
> - **What you were trying to do** (the goal, not the click)
> - **What happened** vs what you expected
> - **Exact steps to reproduce**, including the URL
> - **Severity**, using this scale:
>   - **Blocker** — a normal task cannot be completed at all
>   - **Wrong data** — it saved, showed, or calculated something incorrect.
>     Anything involving money, dates, or client-facing text is at least this.
>   - **Friction** — it works but costs the agent time or confidence
>   - **Cosmetic** — looks wrong, changes nothing
> - **Your confidence** that it is a real app bug and not one of the traps
>   above. If you are unsure, say so and describe what you ruled out.
>
> End with three things:
>
> 1. The single worst problem, and why you picked it.
> 2. Anything that made you distrust a number on screen — even slightly.
> 3. What a new agent would need explained to them, that the app should have
>    explained itself.
>
> Do not fix anything. Report only.

---

## After the run

Findings come back mixed — real bugs, trap artifacts, and taste. Triage before
building anything:

- **Wrong-data findings first**, always. A number that lies is worse than a
  page that will not load, because nobody notices it.
- **Check every finding against `## The traps`** before treating it as a bug.
  Three of the first four reports from this kind of session were traps.
- **A finding that is really a data-entry artifact** (a doubled title, a
  duplicated field) is a fix in the app's UI, not a code change — but ask why
  the form allowed it.
