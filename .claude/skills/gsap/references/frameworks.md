# GSAP in frameworks

The whole problem in a component framework is **cleanup**. Components mount,
unmount and re-render; animations created on every render pile up, `from()`
tweens leave elements stuck at their start values, and ScrollTriggers survive
route changes pointing at DOM that no longer exists. `gsap.context()` and the
`useGSAP()` hook exist to solve exactly this — use them rather than hand-rolling
`useEffect` cleanup.

Contents:
- [React](#react)
- [Next.js](#nextjs)
- [Vue](#vue)
- [Svelte](#svelte)
- [Angular](#angular)
- [Framework-agnostic rules](#framework-agnostic-rules)

## React

Install the official hook alongside GSAP:

```bash
npm install gsap @gsap/react
```

```jsx
import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger);

function Hero() {
  const container = useRef(null);

  useGSAP(() => {
    // selectors are scoped to `container`, and every animation created here
    // is reverted automatically on unmount / before re-running
    gsap.from(".title", { y: 40, opacity: 0, duration: 0.8 });
    gsap.to(".bg", {
      yPercent: -20, ease: "none",
      scrollTrigger: { trigger: container.current, scrub: true }
    });
  }, { scope: container });

  return (
    <section ref={container}>
      <h1 className="title">Hello</h1>
      <div className="bg" />
    </section>
  );
}
```

**Dependencies and re-running:**

```jsx
useGSAP(() => { gsap.to(".box", { x: open ? 200 : 0 }); },
        { dependencies: [open], scope: container, revertOnUpdate: true });
```

Without `revertOnUpdate`, the previous animations are killed but inline styles
stay — which is what you want when animating *to* new values, and not what you
want for `from()` animations that must reset first.

**Event handlers and interaction** use `contextSafe` so animations created
outside the hook body are still tracked and cleaned up:

```jsx
const { contextSafe } = useGSAP({ scope: container });

const onEnter = contextSafe(() => { gsap.to(".btn", { scale: 1.1, duration: 0.2 }); });

return <button className="btn" onMouseEnter={onEnter}>Go</button>;
```

**Without `@gsap/react`**, the manual equivalent:

```jsx
useLayoutEffect(() => {
  const ctx = gsap.context(() => { gsap.from(".box", { y: 30, opacity: 0 }); }, container);
  return () => ctx.revert();
}, []);
```

Use `useLayoutEffect` (not `useEffect`) so start values are applied before the
browser paints, avoiding a one-frame flash of the un-animated state.

**Refs vs selectors:** scoped selector strings are fine and keep the code
readable; use refs when the element is conditionally rendered or when TypeScript
strictness makes selectors awkward. `const q = gsap.utils.selector(container)`
is the middle ground.

## Next.js

Everything above applies, plus:

- Animation code touches the DOM, so components using it need `"use client"`.
- With the App Router, ScrollTrigger positions must be refreshed after route
  transitions and after images settle:
  ```js
  useGSAP(() => { ScrollTrigger.refresh(); }, { dependencies: [pathname] });
  ```
- Server-rendered markup is visible before hydration. If elements are meant to
  start hidden, hide them in CSS and animate to visible, rather than relying on
  a `from()` that only runs after hydration — otherwise there is a flash of
  fully-styled content.
- Import plugins in client components only; importing them at module scope in a
  server component throws on `window`.

## Vue

```vue
<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import gsap from "gsap";

const root = ref(null);
let ctx;

onMounted(() => {
  ctx = gsap.context(() => {
    gsap.from(".card", { y: 40, opacity: 0, stagger: 0.1 });
  }, root.value);
});

onUnmounted(() => ctx && ctx.revert());
</script>

<template>
  <div ref="root"><div class="card" v-for="c in cards" :key="c.id">{{ c.name }}</div></div>
</template>
```

For list transitions driven by data, `<TransitionGroup>` hooks pair well with
GSAP, or use Flip: capture `Flip.getState()` before the data change and call
`Flip.from()` in `nextTick()`.

## Svelte

```svelte
<script>
  import { onMount } from "svelte";
  import gsap from "gsap";
  let root;
  onMount(() => {
    const ctx = gsap.context(() => { gsap.from(".box", { y: 30, opacity: 0 }); }, root);
    return () => ctx.revert();
  });
</script>
<div bind:this={root}><div class="box" /></div>
```

## Angular

```ts
export class HeroComponent implements AfterViewInit, OnDestroy {
  @ViewChild('root') root!: ElementRef;
  private ctx!: gsap.Context;

  ngAfterViewInit() {
    this.ctx = gsap.context(() => {
      gsap.from('.title', { y: 40, opacity: 0 });
    }, this.root.nativeElement);
  }

  ngOnDestroy() { this.ctx.revert(); }
}
```

Wrap animation setup in `NgZone.runOutsideAngular()` if `onUpdate` callbacks are
triggering change detection on every frame.

## Framework-agnostic rules

1. **Every animation must have an owner that can revert it.** A context, a
   matchMedia, or an explicit `.kill()` in the teardown path.
2. **Never animate an element that the framework also controls the styles of**
   without deciding who wins. If React re-renders `style={{opacity}}`, it will
   fight GSAP's inline styles.
3. **Register plugins once**, at module scope in the files that use them.
4. **Guard against SSR**: plugin registration and any `window`/`document` access
   belongs in client-only code.
5. **`ScrollTrigger.refresh()` after content changes** — route transitions,
   accordion opens, lazy-loaded images, fetched lists.
6. **Key your animations to data, not to render count.** Passing the right
   `dependencies` is what keeps a hover animation from being recreated 60 times
   a second by an unrelated state update.
