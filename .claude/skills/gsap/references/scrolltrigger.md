# ScrollTrigger, ScrollSmoother, Observer

Contents:
- [Setup](#setup)
- [start and end](#start-and-end)
- [toggleActions vs scrub](#toggleactions-vs-scrub)
- [Full config reference](#full-config-reference)
- [Pinning](#pinning)
- [Recipes](#recipes)
- [batch](#batch)
- [Static methods and lifecycle](#static-methods-and-lifecycle)
- [ScrollSmoother](#scrollsmoother)
- [ScrollToPlugin](#scrolltoplugin)
- [Observer](#observer)
- [Debugging checklist](#debugging-checklist)

## Setup

```js
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);
```

Three ways to attach one, all equivalent:

```js
// 1. inside a tween
gsap.to(".box", { x: 400, scrollTrigger: ".box" });          // shorthand: trigger only

// 2. inside a tween, full config
gsap.to(".box", { x: 400, scrollTrigger: { trigger: ".box", start: "top 80%", scrub: true } });

// 3. standalone — no animation, just callbacks/classes
ScrollTrigger.create({ trigger: ".sec", start: "top center", onEnter: () => {} });
```

A ScrollTrigger attached to a **timeline** is the usual choice for multi-step
scroll sequences: build the timeline normally, then let scroll drive it.

## start and end

`start` and `end` are two-token strings: **`"<trigger position> <scroller
position>"`**. The first token is a point on the trigger element, the second a
point in the viewport.

```
start: "top bottom"   trigger's top hits viewport's bottom  (element just appears)
start: "top center"   trigger's top hits viewport's middle
start: "top 80%"      trigger's top hits 80% down the viewport
start: "center center"
end:   "bottom top"   trigger's bottom hits viewport's top   (element fully gone)
end:   "+=500"        500px of scrolling after the start
end:   () => "+=" + el.offsetHeight
```

Offsets are allowed on either token: `"top top+=100"`, `"center-=50 center"`.
Numbers are absolute scroll positions in px. Functions are re-evaluated on
refresh, which is what you want for anything depending on element size.

## toggleActions vs scrub

Two fundamentally different modes; picking the wrong one is the most common
design mistake.

**toggleActions** — the animation plays at its own speed when the trigger is
crossed. Use for entrances, reveals, counters. Four space-separated values for
`onEnter onLeave onEnterBack onLeaveBack`, each one of
`play pause resume reverse restart reset complete none`:

```js
scrollTrigger: { trigger: ".card", start: "top 85%", toggleActions: "play none none reverse" }
```

`"play none none none"` (play once, never undo) and `once: true` are the two
most common choices for content reveals.

**scrub** — the animation's playhead is tied to scroll position. Use for
parallax, progress bars, horizontal sections, pinned storytelling. `scrub: true`
locks exactly to the scrollbar; `scrub: 1` adds a 1-second catch-up smoothing
that usually feels better:

```js
scrollTrigger: { trigger: ".sec", start: "top top", end: "bottom top", scrub: 1 }
```

With `scrub`, always set `ease: "none"` on the tweens — an ease on top of a
scroll-linked playhead reads as lag or stutter.

## Full config reference

```js
{
  trigger, endTrigger,          // elements defining the range
  start, end,                   // see above
  scrub,                        // true | number (smoothing seconds)
  pin,                          // true | element | selector
  pinSpacing,                   // true (default) | false | "margin" | "padding"
  pinType,                      // "fixed" | "transform"
  pinReparent,                  // true if transforms on ancestors break pinning
  pinnedContainer,              // ancestor that gets pinned, for correct measurement
  anticipatePin,                // 1 — reduces flicker on fast scroll
  snap,                         // number | number[] | "labels" | "labelsDirectional" | fn | object
  toggleActions,                // "play pause resume reverse" etc.
  toggleClass,                  // "active" | { targets: ".x", className: "active" }
  once,                         // kill after first onEnter
  markers,                      // true — development only, remove before shipping
  id,                           // string, labels the markers
  scroller,                     // custom scroll container (default window)
  horizontal,                   // true for horizontal scrollers
  containerAnimation,           // link to a horizontally-scrubbed timeline
  invalidateOnRefresh,          // re-read start values on refresh (use with responsive values)
  refreshPriority,              // ordering when multiple pins interact (higher refreshes first)
  fastScrollEnd,                // true | velocity number — snap sequences to completion
  preventOverlaps,              // true | string group — cancel earlier animations in a group
  onEnter, onLeave, onEnterBack, onLeaveBack,
  onUpdate,                     // (self) => self.progress, self.direction, self.velocity()
  onToggle, onRefresh, onRefreshInit, onSnapComplete, onScrubComplete, onKill
}
```

Snap object form:

```js
snap: {
  snapTo: "labels",             // or 1/8, or [0,0.3,0.7,1], or (v) => ...
  duration: { min: 0.2, max: 0.6 },
  delay: 0.1,
  ease: "power1.inOut",
  directional: true,
  inertia: false
}
```

## Pinning

`pin: true` fixes the trigger element in place while the scroll range is
traversed, inserting padding so the rest of the page still flows correctly
(`pinSpacing: false` removes that padding, letting subsequent content scroll
over the pinned element).

```js
ScrollTrigger.create({
  trigger: ".panel",
  start: "top top",
  end: "+=1000",          // pin lasts 1000px of scrolling
  pin: true,
  anticipatePin: 1
});
```

Things that break pinning: `overflow: hidden` on an ancestor,
`transform`/`filter` on an ancestor (creates a containing block — use
`pinType: "transform"` or `pinReparent: true`), and CSS `position: sticky` on
the same element. If a pinned section jumps, it is almost always because
measurement happened before fonts/images loaded — call
`ScrollTrigger.refresh()` after `window.load`.

## Recipes

**Reveal every section as it enters:**

```js
gsap.utils.toArray(".reveal").forEach((el) => {
  gsap.from(el, {
    y: 60, opacity: 0, duration: 0.8, ease: "power2.out",
    scrollTrigger: { trigger: el, start: "top 85%", toggleActions: "play none none reverse" }
  });
});
```

**Parallax:**

```js
gsap.to(".bg", {
  yPercent: -30, ease: "none",
  scrollTrigger: { trigger: ".hero", start: "top bottom", end: "bottom top", scrub: true }
});
```

**Horizontal scroll section:**

```js
const panels = gsap.utils.toArray(".panel");
gsap.to(panels, {
  xPercent: -100 * (panels.length - 1), ease: "none",
  scrollTrigger: {
    trigger: ".panels-wrapper",
    pin: true, scrub: 1,
    snap: 1 / (panels.length - 1),
    end: () => "+=" + document.querySelector(".panels-wrapper").offsetWidth
  }
});
```

**Progress bar:**

```js
gsap.to(".progress", {
  scaleX: 1, transformOrigin: "left center", ease: "none",
  scrollTrigger: { trigger: document.body, start: "top top", end: "bottom bottom", scrub: true }
});
```

**Counter that counts up when visible:**

```js
const n = { v: 0 };
gsap.to(n, {
  v: 1280, duration: 2, ease: "power1.out", snap: { v: 1 },
  onUpdate: () => el.textContent = n.v.toLocaleString(),
  scrollTrigger: { trigger: el, start: "top 90%", once: true }
});
```

**Pinned storytelling (timeline scrubbed while pinned):**

```js
const tl = gsap.timeline({
  scrollTrigger: { trigger: ".story", start: "top top", end: "+=2000", pin: true, scrub: 1 }
});
tl.from(".step-1", { opacity: 0, y: 40 })
  .to(".step-1", { opacity: 0 }, "+=0.5")
  .from(".step-2", { opacity: 0, y: 40 });
```

## batch

For many similar elements, `batch` groups the ones entering in the same frame
so they stagger together instead of animating one-by-one — much better looking
for grids and much cheaper than one trigger per item:

```js
ScrollTrigger.batch(".card", {
  start: "top 85%",
  onEnter: (els) => gsap.from(els, { y: 50, opacity: 0, stagger: 0.1, overwrite: true }),
  onLeaveBack: (els) => gsap.set(els, { y: 50, opacity: 0, overwrite: true })
});
```

## Static methods and lifecycle

```js
ScrollTrigger.refresh()              // recalculate all positions (after DOM/size changes)
ScrollTrigger.update()
ScrollTrigger.getAll()               // → array of instances
ScrollTrigger.getById("id")
ScrollTrigger.killAll()
ScrollTrigger.create(vars)
ScrollTrigger.batch(targets, vars)
ScrollTrigger.matchMedia({...})      // deprecated — use gsap.matchMedia()
ScrollTrigger.addEventListener("refresh" | "refreshInit" | "scrollStart" | "scrollEnd" | "matchMedia", fn)
ScrollTrigger.normalizeScroll(true)  // fixes iOS address-bar resize jumps
ScrollTrigger.config({ limitCallbacks: true, ignoreMobileResize: true })
ScrollTrigger.scrollerProxy(el, {...}) // integrate a custom/virtual scroller
ScrollTrigger.isInViewport(el, ratio?)
ScrollTrigger.positionInViewport(el, "center")
ScrollTrigger.saveStyles(".selector") // preserve inline styles across matchMedia reverts
ScrollTrigger.clearScrollMemory()
ScrollTrigger.maxScroll(window)
```

Per-instance: `st.refresh() .kill(revert?) .disable() .enable() .progress
.direction .isActive .start .end .animation .labelToScroll("x")`.

`refresh()` after late-loading content is the single most useful call here —
images, web fonts, accordions and route changes all move the page, and
ScrollTrigger measures once unless told otherwise.

## ScrollSmoother

Requires ScrollTrigger. Needs a specific wrapper/content DOM structure.

```html
<div id="smooth-wrapper">
  <div id="smooth-content">
    <!-- all page content -->
  </div>
</div>
```

```js
import { ScrollSmoother } from "gsap/ScrollSmoother";
gsap.registerPlugin(ScrollTrigger, ScrollSmoother);

const smoother = ScrollSmoother.create({
  wrapper: "#smooth-wrapper",
  content: "#smooth-content",
  smooth: 1.5,               // seconds to catch up
  effects: true,             // enable data-speed / data-lag attributes
  smoothTouch: 0.1,          // usually keep small or false on touch
  normalizeScroll: true
});

smoother.scrollTo(".section", true, "top top");
smoother.paused(true);
smoother.effects(".parallax", { speed: 0.8, lag: 0.2 });
```

With `effects: true`, markup can drive parallax directly:
`<img data-speed="0.5">`, `<div data-lag="0.3">`.

Caveat: smooth scrolling overrides native scrolling, which some users and
accessibility tooling dislike. Gate it behind `prefers-reduced-motion` and
avoid it on touch devices unless the design truly needs it.

## ScrollToPlugin

```js
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
gsap.registerPlugin(ScrollToPlugin);

gsap.to(window, { duration: 1, scrollTo: "#section2", ease: "power2.inOut" });
gsap.to(window, { scrollTo: { y: "#s2", offsetY: 80, autoKill: true } });
gsap.to(".container", { scrollTo: { x: 400 } });   // scroll a div
```

`autoKill: true` cancels the tween if the user scrolls manually — usually the
right behavior for "scroll to top" buttons.

## Observer

A normalized "user tried to scroll/drag/swipe" listener, independent of actual
scroll position. Use it for full-page section snapping, or anywhere you want to
react to intent without a scrollbar.

```js
import { Observer } from "gsap/Observer";
gsap.registerPlugin(Observer);

Observer.create({
  target: window,
  type: "wheel,touch,pointer",
  wheelSpeed: -1,
  onDown: () => goToSection(index - 1),
  onUp: () => goToSection(index + 1),
  tolerance: 10,
  preventDefault: true
});
```

Other callbacks: `onChange`, `onDrag`, `onDragStart`, `onDragEnd`, `onHover`,
`onPress`, `onRelease`, `onStop`, `onLeft/onRight/onUp/onDown`, `onToggleY`.
Instance: `.disable() .enable() .kill()` plus `deltaX/deltaY/velocityX/velocityY`.

## Debugging checklist

1. `markers: true` — see exactly where start/end land. Most "it fires too
   early/late" bugs are visible immediately.
2. Nothing happens at all → plugin not registered, or the trigger element
   doesn't exist yet when the code runs.
3. Positions drift after load → call `ScrollTrigger.refresh()` on `window.load`
   and after fonts (`document.fonts.ready`).
4. Pinned element jumps → ancestor `transform`/`overflow`, or missing
   `anticipatePin: 1`.
5. Animations replay wrongly on resize → use `gsap.matchMedia()` and
   `invalidateOnRefresh: true`.
6. Broken inside React/Vue after navigation → animations were never reverted;
   see `frameworks.md`.
