---
name: gsap
description: Build web animations with GSAP (GreenSock Animation Platform) v3 — tweens, timelines, ScrollTrigger scroll effects, SplitText, Flip layout transitions, Draggable, MotionPath, SVG morphing, and easing. Use this skill whenever the user wants to animate anything on a web page — scroll-driven effects, entrance/exit transitions, hero sequences, staggered lists, counters, parallax, text reveals, SVG line drawing, drag-and-drop, or "make this move / feel smoother / add motion" — and whenever GSAP, GreenSock, ScrollTrigger, ScrollSmoother, SplitText, MorphSVG, or Flip is mentioned by name. Also use it when deciding between CSS animations and a JS animation library, when fixing janky or broken animations, or when animations must survive React/Vue re-renders or run fully offline in a single HTML file.
---

# GSAP v3

GSAP is a framework-agnostic animation engine: one timeline API that animates
CSS, SVG attributes, canvas objects, and plain JavaScript values with the same
syntax. It is **completely free**, including every plugin that used to be
premium (SplitText, MorphSVG, ScrollSmoother, DrawSVG, Inertia…) — see
`references/license.md` before telling a user anything about cost or tiers,
because the old "Club GreenSock" paywall information is outdated.

Current version: **3.15.0**.

## Getting GSAP into the project

Pick the option that matches how the page is already built — matching the
project's existing loading strategy matters more than any of these being
"correct".

| Situation | Approach |
|---|---|
| Bundler (Vite/webpack/Next) | `npm install gsap`, then `import { gsap } from "gsap"` |
| Ordinary HTML page with network | `<script src="https://cdn.jsdelivr.net/npm/gsap@3.15/dist/gsap.min.js"></script>` |
| Single-file / offline page | Inline the bundled copy — see "Offline pages" below |

Plugins are separate files and must be registered once before use:

```js
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);
```

Registration is a no-op if repeated, so registering at module top level in
every file that needs a plugin is safe and avoids "plugin not loaded" bugs
when tree-shaking drops the import.

### Offline pages

This skill bundles `assets/gsap.min.js` (73 KB) and
`assets/ScrollTrigger.min.js` (45 KB) so a page can animate with **zero
network requests** — paste the file contents inside a `<script>` tag. That
matters for demos meant to run from `file://` or behind an air gap, where a
CDN `<script src>` silently fails and every animation just never starts.

For other plugins offline, run `npm pack gsap` and take the file you need
from `package/dist/`. The umbrella `dist/all.js` has everything, but it is
large; prefer the individual files.

## The mental model

Three ideas cover most of GSAP. Get these right and the rest is lookup.

**1. A tween animates from a state to a state.** `gsap.to()` animates from the
element's *current* values to the ones you give. `gsap.from()` does the
reverse — it is what you want for entrance animations, because it animates
*from* an offset to wherever CSS already put the element, so you never have to
hardcode the final position.

```js
gsap.to(".card", { x: 200, rotation: 15, duration: 1, ease: "power2.out" });
gsap.from(".hero h1", { y: 40, opacity: 0, duration: 0.8 });     // entrance
gsap.fromTo(".bar", { scaleX: 0 }, { scaleX: 1, duration: 1.2 }); // both ends explicit
gsap.set(".card", { opacity: 0 });                                // instant, no animation
```

**2. A timeline sequences tweens.** Reach for one as soon as there is a second
step, rather than chaining `delay` values — delays have to be recalculated by
hand every time a duration changes, and that is where multi-step sequences rot.

```js
const tl = gsap.timeline({ defaults: { duration: 0.6, ease: "power2.out" } });
tl.from(".title", { y: 30, opacity: 0 })
  .from(".subtitle", { y: 20, opacity: 0 }, "-=0.3")  // overlap 0.3s
  .from(".btn", { scale: 0.8, opacity: 0 }, "<")      // start with previous
  .to(".hint", { opacity: 1 }, "+=0.5");              // 0.5s gap
```

The third argument is the **position parameter** and it is the single most
useful thing to learn: `"<"` (start of previous), `">"` (end of previous),
`"-=0.3"` / `"+=0.5"` (relative to the end), `1.5` (absolute time), `"label"`.

**3. Everything returns a controllable instance.** Tweens and timelines both
have `.play() .pause() .reverse() .restart() .seek(t) .timeScale(n) .progress(p)
.kill()`. This is why interactive UI (menus, accordions, hovers) is usually
*one paused timeline you reverse*, not two separate animations that can fight
each other:

```js
const menu = gsap.timeline({ paused: true })
  .to(".panel", { xPercent: 100, duration: 0.4, ease: "power3.inOut" })
  .from(".panel li", { x: 20, opacity: 0, stagger: 0.05 }, "-=0.2");

btn.addEventListener("click", () => menu.reversed() ? menu.play() : menu.reverse());
```

## Things that decide whether the result looks good

**Animate transforms and opacity.** `x`, `y`, `scale`, `rotation`, `opacity`
are compositor-friendly. Animating `left`, `top`, `width`, `height`, or
`margin` forces layout on every frame and is the usual cause of "it's janky on
mobile". GSAP gives shorthands: `x`/`y` (px), `xPercent`/`yPercent` (% of the
element's own size — the reliable way to center or slide fully offscreen),
`scale`, `rotation` (degrees), `skewX`, `transformOrigin`.

**Use `ease` deliberately.** The default `power1.out` is fine; the shape of the
motion is what makes animation feel designed rather than mechanical.
`power2.out`/`power3.out` for things entering (fast then settle),
`power2.in` for things leaving, `back.out(1.7)` for a slight overshoot on
playful UI, `elastic.out(1, 0.3)` sparingly, `"none"` for continuous loops and
scroll-linked motion where any easing reads as lag. Never ease a `scrub`
animation — the scrollbar is already the timing function.

**Stagger instead of looping.** Pass `stagger` to animate a set with offsets;
the object form gives control over direction and origin:

```js
gsap.from(".grid img", {
  opacity: 0, y: 30, duration: 0.5,
  stagger: { each: 0.06, from: "center", grid: "auto" }
});
```

**Respect reduced motion.** `gsap.matchMedia()` scopes animations to a media
query and reverts them automatically when it stops matching:

```js
const mm = gsap.matchMedia();
mm.add("(prefers-reduced-motion: no-preference)", () => {
  gsap.from(".card", { y: 50, opacity: 0, stagger: 0.1 });
});
```

## Common pitfalls

These account for most "GSAP isn't working" reports:

- **Animation runs before layout is ready.** Fire on `DOMContentLoaded`, or put
  the script after the markup. For anything measured (ScrollTrigger positions,
  Flip states) also wait for fonts and images, then `ScrollTrigger.refresh()`.
- **`from()` re-running on re-render** leaves elements stuck at their start
  values. In React/Vue, see `references/frameworks.md` — `useGSAP`/`gsap.context`
  exist precisely for this.
- **Two animations fighting over one property.** GSAP resolves this with
  `overwrite: "auto"` on the newer tween, or keep one timeline and reverse it.
- **`display: none` elements** have no measurable size; animate `autoAlpha`
  (opacity + visibility) instead of toggling `display`.
- **Percent-based `x` in CSS vs GSAP**: `x: "50%"` is 50% of the element's own
  width in GSAP too, but `xPercent: 50` is the form that composes correctly
  with other transforms — prefer it.

## Where to look next

Read the reference file that matches the task instead of guessing at an API —
GSAP's option names are specific and a near-miss silently does nothing.

| File | Covers |
|---|---|
| `references/core-api.md` | Full tween/timeline vars, callbacks, control methods, `gsap.utils`, `quickTo`, `matchMedia`, `context`, custom easing |
| `references/scrolltrigger.md` | ScrollTrigger (start/end, scrub, pin, snap, toggleActions, batch), ScrollSmoother, Observer, ScrollToPlugin |
| `references/plugins.md` | SplitText, Flip, MotionPath, Draggable, DrawSVG, MorphSVG, Text/ScrambleText, Inertia, Physics2D, Pixi |
| `references/frameworks.md` | React (`useGSAP`), Next.js, Vue, Svelte, Angular — cleanup and re-render safety |
| `references/license.md` | Licensing facts (all free now), version, what to tell users about cost |
