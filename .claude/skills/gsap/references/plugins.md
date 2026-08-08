# GSAP plugins

Every plugin below is free. Import path is `gsap/<PluginName>`, and each must
be passed to `gsap.registerPlugin()` once before use.

Contents:
- [SplitText](#splittext)
- [Flip](#flip)
- [MotionPathPlugin](#motionpathplugin)
- [Draggable](#draggable)
- [InertiaPlugin](#inertiaplugin)
- [DrawSVGPlugin](#drawsvgplugin)
- [MorphSVGPlugin](#morphsvgplugin)
- [TextPlugin and ScrambleTextPlugin](#textplugin-and-scrambletextplugin)
- [Physics2DPlugin and PhysicsPropsPlugin](#physics2dplugin-and-physicspropsplugin)
- [PixiPlugin and EaselPlugin](#pixiplugin-and-easelplugin)
- [CustomEase, CustomBounce, CustomWiggle](#customease-custombounce-customwiggle)
- [GSDevTools and MotionPathHelper](#gsdevtools-and-motionpathhelper)
- [Which plugin for which job](#which-plugin-for-which-job)

## SplitText

Splits text into lines, words and characters so each piece can be animated.

```js
import { SplitText } from "gsap/SplitText";
gsap.registerPlugin(SplitText);

const split = SplitText.create(".headline", {
  type: "lines,words,chars",
  mask: "lines",          // wraps lines in overflow:hidden parents — clean reveals
  linesClass: "line",
  autoSplit: true,        // re-split on resize / font load, keeping animations
  aria: "auto",           // keeps the original text readable by screen readers
  onSplit: (self) => gsap.from(self.chars, {
    y: 20, opacity: 0, stagger: 0.02, duration: 0.6, ease: "power3.out"
  })
});

split.revert();   // restore original markup
```

Two things matter in practice: run the split **after fonts load** (or use
`autoSplit: true`), because splitting on fallback-font metrics produces wrong
line breaks; and return the animation from `onSplit` so re-splits don't stack
duplicates.

Other vars: `wordDelimiter`, `charsClass`, `wordsClass`, `tag`, `propIndex`
(adds `--char` CSS vars), `deepSlice`, `smartWrap`, `specialChars`,
`reduceWhiteSpace`, `ignore`, `prepareText`.

## Flip

Animates between two layout states, including changes CSS transitions cannot
touch — reparenting, grid reflow, `display` changes, filtered/sorted lists.
The pattern is always: record → change the DOM → `Flip.from()`.

```js
import { Flip } from "gsap/Flip";
gsap.registerPlugin(Flip);

const state = Flip.getState(".item");         // 1. record current positions
container.classList.toggle("grid-view");      // 2. make any DOM/CSS change
Flip.from(state, {                            // 3. animate the difference
  duration: 0.6,
  ease: "power2.inOut",
  stagger: 0.03,
  absolute: true,           // take items out of flow while animating (prevents shifting)
  scale: true,              // animate scale instead of width/height
  nested: true,
  onEnter: (els) => gsap.from(els, { opacity: 0, scale: 0.8 }),
  onLeave: (els) => gsap.to(els, { opacity: 0, scale: 0.8 })
});
```

`Flip.getState(targets, { props: "backgroundColor,color" })` also captures
arbitrary CSS props. `Flip.fit(elA, elB)` snaps one element onto another's
box — useful for shared-element transitions between routes.

## MotionPathPlugin

```js
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
gsap.registerPlugin(MotionPathPlugin);

gsap.to(".rocket", {
  duration: 5, ease: "none",
  motionPath: {
    path: "#route",          // SVG path, or an array of {x,y} points
    align: "#route",         // align coordinate systems (essential for SVG paths)
    alignOrigin: [0.5, 0.5], // element's own center follows the path
    autoRotate: true,        // rotate to face travel direction
    start: 0, end: 1
  }
});
```

Helpers: `MotionPathPlugin.convertToPath("circle")` turns primitives into
paths; `getRelativePosition`, `stringToRawPath`, `getLength` for math.

## Draggable

```js
import { Draggable } from "gsap/Draggable";
import { InertiaPlugin } from "gsap/InertiaPlugin";
gsap.registerPlugin(Draggable, InertiaPlugin);

Draggable.create(".box", {
  type: "x,y",              // "x" | "y" | "rotation" | "scroll" | "top,left"
  bounds: ".container",     // element, selector, or {minX, maxX, minY, maxY}
  inertia: true,            // momentum flick (needs InertiaPlugin)
  edgeResistance: 0.65,
  snap: { x: (v) => Math.round(v / 50) * 50 },
  onDrag() { console.log(this.x, this.y); },
  onDragEnd() {},
  onPress() {}, onRelease() {}, onClick() {},
  liveSnap: true,
  dragClickables: false,
  allowContextMenu: true
});

Draggable.get(".box").disable();
Draggable.hitTest(elA, elB, "50%");   // overlap test, for drop zones
```

## InertiaPlugin

Momentum-based motion from a velocity, used by Draggable but also directly:

```js
gsap.to(".box", { inertia: { x: { velocity: 500, min: 0, max: 1000, end: snapFn } } });
InertiaPlugin.track(".box", "x,y");     // start recording velocity
InertiaPlugin.getVelocity(el, "x");
```

## DrawSVGPlugin

Animates SVG stroke drawing by manipulating dash offsets.

```js
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
gsap.registerPlugin(DrawSVGPlugin);

gsap.fromTo("#path", { drawSVG: "0%" }, { drawSVG: "100%", duration: 2, ease: "none" });
gsap.to("#path", { drawSVG: "20% 80%" });   // draw a segment
```

Requires an actual `stroke` on the element; a fill-only path draws nothing.

## MorphSVGPlugin

```js
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
gsap.registerPlugin(MorphSVGPlugin);

gsap.to("#circle", { duration: 1, morphSVG: "#star" });
gsap.to("#a", { morphSVG: { shape: "#b", shapeIndex: 3, type: "rotational" } });
MorphSVGPlugin.convertToPath("circle, rect, ellipse, line, polygon");
```

If a morph looks like it turns inside-out, tune `shapeIndex` (or use
`MorphSVGPlugin.findShapeIndex(a, b)` in development to find a good value).

## TextPlugin and ScrambleTextPlugin

```js
import { TextPlugin } from "gsap/TextPlugin";
gsap.registerPlugin(TextPlugin);
gsap.to("#out", { duration: 2, text: "Typed out character by character" });
gsap.to("#out", { text: { value: "New text", delimiter: " ", newClass: "fresh" } });

import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
gsap.registerPlugin(ScrambleTextPlugin);
gsap.to("#out", {
  duration: 2,
  scrambleText: { text: "DECODED", chars: "upperCase", revealDelay: 0.4, speed: 0.4 }
});
```

## Physics2DPlugin and PhysicsPropsPlugin

```js
gsap.to(".particle", {
  duration: 2,
  physics2D: { velocity: 300, angle: -60, gravity: 500 }   // or acceleration/friction
});
gsap.to(obj, { physicsProps: { x: { velocity: 100, acceleration: 200 } } });
```

Good for confetti, sparks and debris where authoring each path by hand would be
absurd.

## PixiPlugin and EaselPlugin

Adapters so GSAP can animate canvas-library objects with the same syntax:

```js
gsap.registerPlugin(PixiPlugin);
PixiPlugin.registerPIXI(PIXI);
gsap.to(sprite, { pixi: { x: 100, rotation: 360, tint: 0xff0000, blurX: 8 } });
```

## CustomEase, CustomBounce, CustomWiggle

```js
CustomEase.create("hop", "M0,0 C0.14,0 0.242,0.438 0.272,0.561 ...");
CustomBounce.create("myBounce", { strength: 0.6, squash: 3, squashID: "myBounce-squash" });
CustomWiggle.create("myWiggle", { wiggles: 6, type: "easeOut" });

gsap.to(".ball", { y: 400, ease: "myBounce" });
gsap.to(".ball", { scaleX: 1.4, scaleY: 0.6, ease: "myBounce-squash" });
gsap.to(".card", { rotation: 8, ease: "myWiggle", duration: 1 });
```

## GSDevTools and MotionPathHelper

Development-only tools. `GSDevTools.create()` adds a scrubber/timeline UI for
any animation with an `id`; `MotionPathHelper.create(tween)` lets you drag a
motion path in the browser and copy the resulting path data. Remove both before
shipping — they are large and add UI to the page.

## Which plugin for which job

| Goal | Use |
|---|---|
| Scroll-driven anything | ScrollTrigger |
| Smooth/inertial page scrolling | ScrollSmoother |
| Animated scroll to an anchor | ScrollToPlugin |
| Per-letter or per-line text reveals | SplitText |
| Layout/filter/sort/reparent transitions | Flip |
| Element follows a curve | MotionPathPlugin |
| Drag, swipe, sliders, knobs | Draggable (+ InertiaPlugin) |
| SVG line drawing | DrawSVGPlugin |
| One shape becomes another | MorphSVGPlugin |
| Typewriter / decode effects | TextPlugin / ScrambleTextPlugin |
| Confetti, particles | Physics2DPlugin |
| Detect scroll/swipe intent without a scrollbar | Observer |
