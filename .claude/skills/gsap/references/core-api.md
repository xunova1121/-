# GSAP core API reference

Contents:
- [Tween methods](#tween-methods)
- [Special properties (tween vars)](#special-properties-tween-vars)
- [What you can animate](#what-you-can-animate)
- [Easing](#easing)
- [Stagger](#stagger)
- [Timelines](#timelines)
- [Position parameter](#position-parameter)
- [Control methods](#control-methods)
- [Callbacks](#callbacks)
- [gsap.utils](#gsaputils)
- [quickTo and quickSetter](#quickto-and-quicksetter)
- [gsap.matchMedia](#gsapmatchmedia)
- [gsap.context](#gsapcontext)
- [gsap.defaults and registerEffect](#gsapdefaults-and-registereffect)
- [CustomEase](#customease)

## Tween methods

```js
gsap.to(targets, vars)              // current values → vars
gsap.from(targets, vars)            // vars → current values
gsap.fromTo(targets, fromVars, toVars)
gsap.set(targets, vars)             // immediate, zero duration
gsap.timeline(vars)                 // returns a Timeline
gsap.registerPlugin(PluginA, PluginB)
gsap.killTweensOf(targets, props?)  // props e.g. "x,y"
gsap.getProperty(target, prop, unit?)  // read a current value
gsap.delayedCall(seconds, fn, params?) // a tween whose only job is a callback
gsap.exportRoot()                   // isolate existing animations from a new timeline
```

`targets` accepts a selector string, an element, an array/NodeList of elements,
or a plain JS object (animating arbitrary object properties works and is how
you animate canvas/WebGL values or counters).

## Special properties (tween vars)

Anything not in this list is treated as a property to animate.

| Property | Meaning |
|---|---|
| `duration` | seconds (default 0.5) |
| `delay` | seconds before starting |
| `ease` | see [Easing](#easing) |
| `stagger` | number or config object, for multiple targets |
| `repeat` | times to repeat; `-1` = infinite |
| `repeatDelay` | pause between repeats |
| `repeatRefresh` | re-evaluate start/end values each repeat (pairs with `random()`) |
| `yoyo` | reverse on alternate repeats |
| `yoyoEase` | different ease on the way back |
| `paused` | create in a paused state |
| `immediateRender` | force/prevent rendering start values on creation (`from()` defaults true) |
| `overwrite` | `true` (kill all other tweens of targets), `"auto"` (kill only conflicting properties), `false` (default) |
| `id` | string identifier, useful with GSDevTools |
| `data` | arbitrary payload stored on the instance |
| `keyframes` | array or object of sequential states in one tween |
| `onComplete`, `onStart`, `onUpdate`, `onRepeat`, `onReverseComplete`, `onInterrupt` | callbacks |
| `callbackScope` | `this` inside callbacks |
| `startAt` | object of values to jump to before animating |
| `lazy` | defer first render for performance (default true for most) |
| `inherit` | opt out of timeline `defaults` with `false` |

Keyframes:

```js
gsap.to(".box", {
  keyframes: [
    { x: 100, duration: 0.5 },
    { y: 100, duration: 0.5, delay: 0.1 },
    { rotation: 180, duration: 0.5 }
  ]
});

// object form — percentage-based, like CSS @keyframes
gsap.to(".box", {
  keyframes: { "0%": { x: 0 }, "50%": { x: 100, y: 50 }, "100%": { x: 0 } },
  duration: 2, ease: "none"
});
```

Function-based values receive `(index, target, targets)` and let one tween give
each element its own destination:

```js
gsap.to(".dot", { x: (i) => i * 40, opacity: (i, el) => el.dataset.op });
```

Relative strings work too: `x: "+=100"`, `rotation: "-=45"`.

## What you can animate

- **CSS transforms**: `x`, `y`, `z`, `xPercent`, `yPercent`, `scale`, `scaleX`,
  `scaleY`, `rotation`, `rotationX`, `rotationY`, `skewX`, `skewY`,
  `transformOrigin`, `transformPerspective`, `perspective`, `force3D`
- **Other CSS**: any property in camelCase (`backgroundColor`, `borderRadius`,
  `boxShadow`, `filter`, `clipPath`, CSS variables via `"--my-var"`)
- **`autoAlpha`**: opacity + `visibility: hidden` at 0 — use it instead of
  toggling `display`, which cannot be animated and breaks measurement
- **SVG attributes**: via `attr: { cx: 100, r: 20, points: "..." }`; transforms
  on SVG elements work with the same `x`/`y`/`rotation` shorthands
- **Plain objects**: `gsap.to(state, { value: 100, onUpdate: () => draw(state) })`

## Easing

```
none
power1 power2 power3 power4   (.in .out .inOut)
back(overshoot)  elastic(amplitude, period)  bounce
circ  expo  sine  steps(n)
rough  slow  expoScale         (EasePack)
```

Written as strings: `"power2.out"`, `"back.out(1.7)"`, `"elastic.out(1, 0.3)"`,
`"steps(12)"`. Defaults to `"power1.out"` for tweens; `"none"` for scrubbed
ScrollTriggers is effectively mandatory.

Rules of thumb: `.out` for anything entering or responding to a user action
(fast start, gentle settle — reads as responsive); `.in` for exits; `.inOut`
for movements between two resting states; `"none"` for loops, marquees and
scroll-linked motion.

## Stagger

```js
stagger: 0.1                      // 0.1s between each

stagger: {
  each: 0.1,                      // or: amount: 1.5  (total spread, auto per-item)
  from: "start",                  // "center" | "end" | "edges" | "random" | index
  grid: "auto",                   // or [rows, cols] for 2D wave
  axis: "y",                      // restrict grid distribution to one axis
  ease: "power2.in",              // ease applied to the distribution itself
  repeat: -1, yoyo: true
}
```

`amount` vs `each`: use `amount` when the total duration must stay fixed no
matter how many items there are (a grid whose length is data-driven), `each`
when the per-item rhythm matters more than the total.

## Timelines

```js
const tl = gsap.timeline({
  paused: true,
  repeat: -1, repeatDelay: 1, yoyo: true,
  defaults: { duration: 0.6, ease: "power2.out" },   // inherited by every child
  onComplete: () => {},
  smoothChildTiming: true,
  scrollTrigger: { /* ScrollTrigger.Vars */ }        // attach directly
});

tl.to(...).from(...).fromTo(...).set(...)
  .add(otherTimeline, "+=0.5")     // nest timelines
  .addLabel("mid")                 // named position
  .call(fn, params, "+=1")         // callback at a time
  .addPause("mid")                 // pause until played again
  .to(...) // chainable
```

`defaults` is worth using in every timeline: it removes the repetition of
`duration`/`ease` on each line and makes the whole sequence retunable from one
place.

Nesting timelines is the way to keep long sequences readable — build
`intro()`, `middle()`, `outro()` functions that each return a timeline, then
`master.add(intro()).add(middle(), "-=0.3")`.

## Position parameter

The optional last argument of every timeline method:

| Value | Meaning |
|---|---|
| *(omitted)* | at the end of the timeline |
| `2` | absolute time, 2s from the timeline start |
| `"+=1"` / `"-=0.5"` | 1s after / 0.5s before the current end (overlap) |
| `"<"` | at the **start** of the previous animation |
| `">"` | at the **end** of the previous animation |
| `"<0.2"` / `"<+=0.2"` | 0.2s after the previous animation's start |
| `">-0.3"` | 0.3s before the previous animation's end |
| `"myLabel"` | at a label |
| `"myLabel+=0.5"` | relative to a label |
| `"<<"` / `">>"` (rare) | relative to the start of the one before the previous |

## Control methods

Available on tweens and timelines alike:

```js
anim.play() .pause() .resume() .reverse() .restart(includeDelay?, suppressEvents?)
anim.seek(timeOrLabel) .progress(0..1) .totalProgress(0..1)
anim.time() .totalTime() .duration() .totalDuration()
anim.timeScale(2)          // 2x speed; animate it for ramping: gsap.to(tl, {timeScale: 0})
anim.reversed()            // boolean getter / setter
anim.paused()              // boolean getter / setter
anim.kill(targets?, props?)
anim.invalidate()          // discard recorded start/end values, re-read on next play
anim.then(fn)              // promise-based completion
anim.eventCallback("onComplete", fn)
anim.isActive()
```

Getters double as setters: `tl.progress()` reads, `tl.progress(0.5)` sets.

## Callbacks

```js
gsap.to(".box", {
  x: 100,
  onStart: () => {},
  onUpdate: function () { console.log(this.progress()); },
  onComplete: () => {},
  onRepeat: () => {},
  onInterrupt: () => {},        // fired if killed before completing
  callbackScope: someObject,
  onCompleteParams: ["a", "b"]
});
```

Tweens are promise-like, so `await gsap.to(...)` works and is often cleaner
than nesting `onComplete` callbacks for a linear async sequence.

## gsap.utils

```js
gsap.utils.clamp(0, 100, value)          // or clamp(0,100) → reusable fn
gsap.utils.mapRange(0, 100, 0, 1, 50)    // remap between ranges
gsap.utils.normalize(min, max, value)    // → 0..1
gsap.utils.interpolate(a, b, 0.5)        // numbers, colors, arrays, objects
gsap.utils.snap(5, 12)                   // → 10; also snap({values:[...], radius:10}, v)
gsap.utils.random(-100, 100, 5)          // optional snap increment
gsap.utils.random(["red","blue"], true)  // true → reusable fn
gsap.utils.wrap([a, b, c], index)        // cycle through an array
gsap.utils.wrapYoyo([a, b, c], index)
gsap.utils.distribute({ base: 0, amount: 100, from: "center" })
gsap.utils.pipe(fnA, fnB, fnC)           // compose
gsap.utils.unitize(fn, "px")             // apply a fn to the numeric part only
gsap.utils.toArray(".selector")          // → real Array (NodeList, string, element)
gsap.utils.selector(scopeEl)             // scoped query fn, key for React refs
gsap.utils.shuffle(array)
gsap.utils.splitColor("#f00")            // → [r,g,b]
gsap.utils.getUnit("100px")              // → "px"
gsap.utils.checkPrefix("filter")         // vendor-prefixed property name
```

`toArray` and `selector` matter more than they look: they turn selector strings
into arrays you can `.forEach()` over to build per-element ScrollTriggers, which
is the standard pattern for "each section animates as it enters".

## quickTo and quickSetter

For values updated on every pointer move or animation frame, the normal tween
creation cost is wasted. These reuse one instance:

```js
const xTo = gsap.quickTo(".cursor", "x", { duration: 0.4, ease: "power3" });
const yTo = gsap.quickTo(".cursor", "y", { duration: 0.4, ease: "power3" });
window.addEventListener("mousemove", (e) => { xTo(e.clientX); yTo(e.clientY); });

const setX = gsap.quickSetter(".box", "x", "px");  // no tween at all, instant
```

## gsap.matchMedia

Creates and reverts animations as media queries change — the correct tool for
responsive and reduced-motion behavior, because it cleans up automatically
instead of leaving desktop transforms applied on mobile.

```js
const mm = gsap.matchMedia();

mm.add("(min-width: 800px)", () => {
  const tl = gsap.timeline({ scrollTrigger: { trigger: ".sec", scrub: true } });
  tl.to(".sec", { xPercent: -50 });
  return () => { /* optional extra cleanup */ };
});

mm.add("(prefers-reduced-motion: reduce)", () => {
  gsap.set(".card", { opacity: 1, y: 0 });   // final state, no motion
});

// multiple conditions in one callback
mm.add({ isDesktop: "(min-width: 800px)", isMobile: "(max-width: 799px)" },
  (ctx) => {
    const { isDesktop } = ctx.conditions;
    gsap.to(".box", { x: isDesktop ? 400 : 100 });
  });

mm.revert();   // tear everything down
```

## gsap.context

Scopes selector text to a container and collects every animation created inside
so a single `revert()` undoes all of it. This is the foundation of framework
cleanup (in React, `useGSAP` wraps it for you).

```js
const ctx = gsap.context((self) => {
  gsap.to(".box", { x: 100 });        // ".box" resolved inside containerEl only
  self.add("blink", () => gsap.to(".led", { opacity: 0, repeat: 5, yoyo: true }));
}, containerEl);

ctx.blink();     // named, callable later
ctx.revert();    // kill animations AND restore original inline styles
ctx.kill();      // kill without reverting styles
```

## gsap.defaults and registerEffect

```js
gsap.defaults({ ease: "power2.out", duration: 0.6 });   // global tween defaults
gsap.config({ nullTargetWarn: false, force3D: true, autoSleep: 60 });

gsap.registerEffect({
  name: "fadeUp",
  effect: (targets, config) =>
    gsap.from(targets, { y: config.distance, opacity: 0, duration: config.duration }),
  defaults: { distance: 40, duration: 0.7 },
  extendTimeline: true          // makes it available as tl.fadeUp(...)
});

gsap.effects.fadeUp(".card", { distance: 80 });
```

Registering effects is worth it once the same 3-line animation appears in more
than a couple of places — it keeps the motion language consistent across a site.

## CustomEase

```js
import { CustomEase } from "gsap/CustomEase";
gsap.registerPlugin(CustomEase);

CustomEase.create("hop", "M0,0 C0,0 0.056,0.442 0.175,0.442 ...");
gsap.to(".box", { y: -100, ease: "hop" });

// from a CSS cubic-bezier
CustomEase.create("myEase", "0.65, 0, 0.35, 1");
```

`CustomBounce` and `CustomWiggle` build on it for bounce-with-squash and
wiggle effects respectively.
