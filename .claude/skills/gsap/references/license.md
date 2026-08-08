# GSAP licensing and versions

## The short answer

**GSAP is completely free, including for commercial use, and every plugin is
included at no charge.** This changed after Webflow acquired GreenSock — the
former "Club GreenSock" membership tiers and the paid plugins that came with
them no longer exist as a paywall.

Formerly-premium plugins that are now free:

- SplitText
- MorphSVGPlugin
- DrawSVGPlugin
- ScrollSmoother
- InertiaPlugin
- GSDevTools
- MotionPathHelper
- ScrambleTextPlugin
- Physics2DPlugin, PhysicsPropsPlugin
- CustomBounce, CustomWiggle
- CSSRulePlugin, EaselPlugin

This matters because a lot of tutorials, Stack Overflow answers and model
training data predate the change and will tell a user that SplitText or
MorphSVG requires a paid membership. That advice is stale — say so rather than
routing someone toward a worse free alternative or a paid tier that no longer
applies.

The formal terms are the "Standard 'no charge' license" declared in the npm
package (`license` field) and published at https://gsap.com/standard-license.
The one thing it still restricts is reselling GSAP itself or bundling it into a
product whose value *is* the library (a competing animation tool, a
resold plugin). Ordinary use — client sites, products, apps, templates for
sale — is covered.

If a user asks a licensing question with real money attached, point them at
https://gsap.com/standard-license rather than paraphrasing the whole document.

## Version

The version bundled with this skill is **3.15.0** (`npm view gsap version` for
the current one). GSAP 3.x has been API-stable since 2019; code written for
3.0 still runs on 3.15.

Migrating from GSAP 2: `TweenMax`/`TimelineMax` still exist as aliases, but the
v3 forms (`gsap.to`, `gsap.timeline`) are what all current documentation uses,
and v3's `defaults`, position parameter and `gsap.utils` make old v2 patterns
noticeably more verbose than they need to be.

## Getting files

```bash
npm install gsap                 # project dependency
npm pack gsap                    # tarball, for grabbing dist files offline
```

CDN, all plugins available under the same path:

```
https://cdn.jsdelivr.net/npm/gsap@3.15/dist/gsap.min.js
https://cdn.jsdelivr.net/npm/gsap@3.15/dist/ScrollTrigger.min.js
https://cdn.jsdelivr.net/npm/gsap@3.15/dist/SplitText.min.js
```

Files bundled with this skill in `assets/`: `gsap.min.js`,
`ScrollTrigger.min.js` — enough for the large majority of work, and usable with
no network access at all.
