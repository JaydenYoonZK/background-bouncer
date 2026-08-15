# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.19.1] - 2026-08-15

### Added

- The footer now carries the version, linked to this changelog. The tool works offline from a cached copy, which means the page in front of you can be one release behind the one just shipped; a visible version number settles in one glance which one you are holding. The footer also now credits libwebp and jSquash for the shipped WebP encoder.

## [2.19.0] - 2026-08-15

### Fixed

- An iPhone's download is now smaller than the photo it came from. The palette PNG of the last two releases was the best a browser without a WebP encoder could be handed, and at 1.7 MB for a 1.5 MB HEIC it was still larger than the input, which is not what compression means. So the tool now brings its own encoder: libwebp, the same encoder desktop browsers use internally, compiled to WebAssembly at 0.3 MB, fetched once on first use and cached like the rest of the runtime. A browser whose canvas cannot make WebP files, iPhone Safari above all, now produces the same WebP a desktop does: the complaint's own 4032 by 2268 photo comes back at 416 KB, less than a third of its 1.5 MB original, where the last release gave 1.7 MB and the one before that 4.7. The SIMD build is tried first and the plain build catches older engines; if the encoder cannot load at all, the palette PNG remains, and the lossless PNG behind it.

## [2.18.0] - 2026-08-15

### Changed

- The palette PNG compresses harder and lands truer at once. The 256 colours from the median cut now get three Lloyd rounds, reassigning the photo's pixels and re-centering each colour on what actually chose it, and the dithering backs off to half strength because the better-fitted palette needs less noise to hide its rounding. Measured on the same iPhone photo as the last release: 1.70 MB where 2.17.0 gave 1.81, with the average colour error down from 2.5 to 2.2 parts in 255. Each change alone measured worse, the refined palette without the gentler dither was larger, not smaller; the pair is the point.
- The close-up second look now gets the same mirrored double-read the whole-frame pass got in 2.16.0: when a small subject earns the zoom, the model reads that crop straight and mirrored and the two mattes are averaged, steadying the exact edges the zoom exists to sharpen. Graphics path only, about a quarter second, and only on photos where the zoom runs at all.

## [2.17.0] - 2026-08-15

### Fixed

- iPhones finally get a compressed download. Safari cannot make WebP files at all, so on an iPhone the tool's compressed path simply did not exist and the only file on offer was the lossless PNG: a 1.5 MB photo came back as 4.7 MB, which reads as the opposite of compression. On a browser without a WebP encoder the compressed download is now a palette PNG: up to 256 colours chosen for that particular photo by median cut, the rounding hidden in Floyd-Steinberg dithering, which is the same trade the well-known PNG shrinking services make. Transparency survives in the palette itself. Measured on the very photo that raised the complaint, 4032 by 2268 from an iPhone: 1.8 MB where the lossless file is 3.9, with faces, glasses, and the jacket's shading indistinguishable at full size. The palette file only ships when it is genuinely smaller, the whole encode yields to the page as it works, and the lossless PNG stays one tap away next to it.

## [2.16.0] - 2026-08-14

### Changed

- Saved files carry the name they came from plus the tool's own: a photo called beach.jpg comes back as beach_JaydenART_Background_Bouncer.webp, and a photo that arrives without any name falls back to JaydenART_Background_Bouncer.webp.
- The PNG is now assembled by the tool itself instead of the browser's canvas encoder. Still lossless, and at the soft edges truer than before: the canvas encoder rounds every semi-transparent pixel through a premultiplied store on the way out, and this path does not. The size comes from each row getting whichever of PNG's five predictors leaves the least to compress, which the canvas encoder does not bother with. Measured: 12% smaller on the sample cutout and 17% smaller on a 16-megapixel photo, 4.8 MB down to 4.0. The browser still writes the colour profile, harvested from a one-pixel canvas encode so the file carries exactly what the canvas would have declared. The encode waits out the reveal sweep and then yields to the page every few dozen rows, and anything failing falls back to the canvas encoder.
- A note under the download buttons now says plainly which file is which: the WebP is the compressed one, usually a fraction of the photo you gave; the PNG is lossless, and a lossless photo is usually far larger than the compressed one. The note only appears when both files exist, so a browser that can only make PNGs is not told about a WebP it will never see.
- On the graphics path the model now reads the photo twice, once as it is and once mirrored, and the two mattes are averaged. Where the two views disagree is exactly where the model was guessing, and averaging steadies those pixels; on the sample the fingertip edges settle slightly cleaner and nothing else moves. Costs about a quarter of a second, taken only where a second look is that cheap.

## [2.15.0] - 2026-08-14

### Added

- The compare box's border now reports the run at a glance. While the cut is being made it turns amber, glows, and carries a light sweeping around its edge; when the cutout lands it settles to green; when the run fails, including the photo with nothing to cut, it turns red. The colours come from the site's own palette in both themes, and reduced motion gets a steady amber border with no movement.

## [2.14.0] - 2026-08-14

### Added

- A photo with no clear subject now gets an honest answer instead of an empty file. When the model keeps under 0.2% of the frame, it found nothing it believed in; when it keeps over 99.5%, it could not tell a subject from the background, which is no cut at all. Either way the tool now says so, apologises, and points at the premium tap-to-select version coming to JaydenART.com, where you point at what should stay.

### Changed

- Cleaner edges from a tighter final alignment. The colour-evidence rounds reshape the matte from colour alone, without looking at where the photo's edges actually run; a tight second guided pass now re-snaps the reshaped boundary onto the real edges before it sets. On the sample this keeps 13% more genuine soft edge and visibly smooths the finger contours and the flecked shoulder line.
- Smaller files. The WebP quality moves from 0.92 to 0.85, measured before it was touched: the sample cutout drops from 70 KB to 56 KB at an average colour difference of 2.4 parts in 255, and a 16-megapixel photo comes back at a third of a megabyte, a quarter smaller than before, at 1.3 parts in 255. The transparency is exact at both settings, so the cut itself gives up nothing.

### Tried and not shipped

- Pushing the matte harder where the photo draws a hard edge, gentler where it is smooth, moved fewer than one pixel in a thousand: the matte is already committed wherever the photo commits. Not worth a pass over every pixel.
- Raising the graphics path's refinement ceiling from 3072 to 4096 pixels cost five extra seconds on a 16-megapixel photo and measured worse, not better: at that scale the extra resolution is noise to the guided filter, not detail.

## [2.13.0] - 2026-08-14

### Added

- A processing chip on the photo itself while the cut runs. The progress bar lives up in the tool card, so with the page scrolled to the compare view a photo mid-cut looked exactly like a photo done; now a pill with a spinning ring sits on the image and mirrors the live progress stage, and it comes off the moment the cutout lands or the cut fails. Reduced motion gets the pill without the spin.

## [2.12.0] - 2026-08-14

### Added

- The photo now appears on the page the moment it is readable, before the cut is done. Dropping, pasting, or uploading used to buy a progress bar and nothing else, and on a second photo the previous result kept the screen with nothing saying which image was being worked on. The compare view now shows the incoming photo whole while the progress bar narrates the cut, with no divider and nothing to grab, because there is nothing to compare yet; when the cutout lands, the sweep starts from that full view and walks the background out. If the cut fails, the photo stays with the message under it, so what failed is as visible as what succeeded.

## [2.11.0] - 2026-08-14

### Fixed

- The sample button could feel dead on a return visit. The early warm-up used to build the whole inference session, and with the model already cached that meant unpacking and compiling it on the main thread in the second between the first mouse move and the click, which is exactly when the button had to answer; measured on a fast desktop the page froze for about 1.4 seconds right there. The warm-up now only downloads, which the page never feels, and the compile happens inside the run where the progress bar narrates it.
- Leaving the page mid-cut and coming back through the browser's back-forward cache restored it exactly as it left: buttons disabled, progress lingering, for a run frozen mid-flight. Nothing was clickable until a hard reload. The page now takes its screen back on that restore, and an outdated run can no longer disturb it afterwards: not the result, not the progress bar, not an error message. One cut still runs at a time, and a frozen run that never comes back ages out of its claim instead of holding it forever. A PNG that was still encoding when the page left no longer strands its button on "PNG…".
- Pinch-zoom was refused when it started on the compare view, which is the one thing on the page a phone wants to zoom into. The stage and the divider now yield the pinch to the browser and keep only deliberate drags for the wipe. A finger touching the stage also no longer moves the divider on contact; it moved it directly under the finger, so the second finger of a pinch landed on the one element that refused all touches and the gesture died. A drag starts wiping on the first move, a tap positions on release, and a pinch touches nothing.
- On phones the compare view now shows a downscaled copy of each side instead of the full originals. A 48-megapixel photo decodes to about 190 MB and sat in the page for as long as the result was on screen; pinch-zooming re-rasters it, and that spike could take the whole tab down and reload the page. The download is untouched, full resolution from the real result.

## [2.10.0] - 2026-08-14

### Changed

- The matte now stays in floating point from the model to the finished pixels. It used to pass through a browser canvas every time it changed size, and a canvas rounds every value to one of 255 steps, twice per photo. Each rounding is invisible alone; together they turn the smooth ramp across a strand of hair into a small staircase. The resizing is now done in plain float math and the ramp arrives at the output as the model drew it.
- Un-mixing the old background out of the edges now uses the background next to each pixel instead of one colour averaged from the whole photo. On the sample scene that average sat between dark wood and bright mist and was wrong on both sides of the subject. Each soft edge pixel is now compared against what was actually removed around it, so an edge over the bench gives up brown and an edge against the sky gives up white. Where there is no confident background nearby the old whole-photo colour still applies, so nothing is ever worse than before.

## [2.9.0] - 2026-08-14

### Fixed

- A phone's cutout was quietly a second-class one: the close-up second look was graphics-path only, so a phone ran the small model AND never got the pass that removes kept bench and shadow. It runs on every engine now. On the processor it roughly doubles the wait when the subject is small in the frame, and that trade is taken on purpose: slower and right beats fast and wrong.
- The colour-evidence pass was taking bites out of sunlit edges. An overexposed rim on a shoulder is near-white and colourless, exactly like a bright misty background, and the pass was removing it. A confident bright colourless pixel is no longer its to judge, with a test pinning the lit rim in place.

## [2.8.0] - 2026-08-14

### Fixed

- The colour-evidence pass now runs twice: what the first round clears becomes confident background, which sharpens the local evidence and lets the second round remove what was ambiguous the first time. The dark fragments beside the cuffs come down with it.
- A final sweep on the finished matte. The early fleck pass ran on the raw model output, so specks that formed during refinement were never seen; now every floating solid speck goes at the end, and after it every soft wisp attached to nothing. Real soft detail always grows out of something solid, so hair is untouched by construction.

### Tried and not shipped

- Matching kept pixels against the photo's whole background palette, not just the local one, removed the last dark flecks inside the bright gaps, and also removed pieces of both hands: sunlit skin is too close to sunlit wood. No guard survived that, so the idea is dead and the flecks it would have removed remain the honest limit of what colour evidence can do. Removing them by hand is what the tap-to-select premium is for.

## [2.7.0] - 2026-08-14

### Fixed

- The model sometimes kept a solid strip of background that touched the subject: a piece of dark bench along a sleeve, a shadow hugging the waist, bits of wood under the hands. No edge filter could question those, because the model called them certain. A new pass can: near the matte's own boundary, each kept pixel is compared with the local colour of the confident subject and the confident background, and a pixel that plainly matches the background while plainly not matching the subject comes down. Evidence only ever lowers alpha, and a pixel that resembles the subject at all is left alone, which is what keeps fabric edges from being chewed. Costs about 60 milliseconds on a typical photo. Two earlier shapes of this pass failed and were not shipped: a projection-based version ate into the dress, and it took a clear-evidence rule to remove the bench without touching a stitch.

### Changed

- A sharper frame of the boat scene for the sample photo.

## [2.6.0] - 2026-08-14

### Changed

- Large photos get sharper edges on the graphics path: the pass that re-cuts the mask against the photo's real edges now works at up to 3072 pixels instead of 2048. A photo smaller than the old cap is untouched; a 4000-pixel one has its strands re-cut against half again as much real detail.
- The finishing sweep over the output, which un-mixes the old background's colour from the edges and writes the transparency, walks the pixels once instead of twice. On a 16-megapixel photo that is a pass over 16 million pixels that no longer happens. An 8000x8000 upload measures about 2.6 seconds end to end on the graphics path, sharper edge pass included.
- When the cutout lands, the compare view now starts on the original and sweeps to the result, so you watch the background leave. Grabbing the divider mid-sweep, or preferring reduced motion, gets the resting view at once. Next to the file size the tool now also says how long the cut took and which chip did it, because a quarter of a second is worth saying out loud.

### Not changed, on purpose

- The edge-trim threshold stays where it was. Loosening it to chase fainter hair strands was measured and it mostly re-admits the background haze the trim exists to remove.
- The model download stays at about 83 MB on the graphics path. Recompressing it harder saves 0.5%, which is not worth invalidating every returning visitor's cached copy.

## [2.5.0] - 2026-08-14

### Changed

- The 85 MB graphics model is no longer offered to phones, or to anyone who switched on data saving in their browser. That download is the whole cost of the fast path and it is spent before anything can be checked, so the decision is now made up front; both keep the 40 MB engine, which is the tool as it worked before the graphics path existed. The browser's connection-speed guess was tried as a third signal and rejected: it called a wired desktop "3g".

### Fixed

- A graphics driver that accepted the model and then failed to run it used to leave the tool broken until reload, and would be walked into the same failure on every visit. It now finishes the photo on the processor instead, remembers the failure for next time, and lets go of the 85 MB that browser will never use.
- A truncated model download could be cached and then fail on every visit after. Downloads are now checked against the expected byte count before caching, and a bad cached copy is evicted rather than served forever.
- The ONNX runtime was cached in the version's own bucket, so every release wiped it and the tool stopped working offline until the next online run. It lives in its own long-lived cache now, and offline use survives version bumps. Navigating straight to index.html while offline also gets the app now instead of the not-found page.
- The theme was applied by an inline script that the page's own security policy had been silently blocking, so the saved choice did not take effect until the main script loaded. It is an ordinary file now and runs before first paint.
- Dropping a second photo while the first was still decoding slipped past the in-progress guard, and both would fight over one inference engine. The guard now closes before any waiting starts, and a drop during a run says so instead of vanishing.
- A leftover timer from a finished run could hide the progress bar of the next one mid-inference. A photo dragged in from another tab, rather than from the file system, navigated the page away, taking an un-downloaded cutout with it. Starting over kept the previous photo and cutout pinned in memory, and could lose the PNG button of the next result if an old encode failed at the wrong moment. All four are fixed.
- A panorama could pass the megapixel cap and still be too long-sided for WebP to encode, failing at the save. The output is now also bounded to WebP's 16383-pixel side limit.
- The page overstated a few numbers: the colour difference against a PNG is about two parts in 255, not one and a half, and the guided filter reads the photo at a working size of up to 2048 pixels, not "full detail". The copy now matches what the code does, including in the README.

## [2.4.0] - 2026-08-14

### Added

- A second, closer look at the subject, on browsers with a graphics chip. The model reads the whole frame through one square canvas, so a subject that fills a third of the photo only ever gets a third of that resolution, and detail it never saw cannot be recovered afterwards. Once the first pass has found where the subject is, the model now looks again at just that region and spends the whole canvas on it. On a wide test frame that resolved 13% more of the edge as real partial coverage, which is what a hair strand is, while touching under half a percent of the picture: the edges, and nothing else.
- It only runs when the crop is meaningfully tighter than the frame, so a subject already filling the picture is not made to wait for a pass that would tell it nothing, and only on the graphics path, where a second look costs a quarter of a second rather than another four. If anything about it fails, the whole-frame result is still there and the cutout still happens.

## [2.3.0] - 2026-08-14

### Added

- The cutout is saved as a WebP now, which is the difference between a file you can send in a message and one you cannot. Its transparency is bit-for-bit identical to the PNG of the same image, measured pixel by pixel, and only the colour gives anything up: about 2 parts in 255 on average, which is not something an eye finds. On the sample photo that is 72 KB instead of 402 KB.
- A PNG button next to it, for anything that will only take a PNG. It shows both sizes so the difference is visible rather than claimed, and it is encoded quietly after the cutout is already on screen, so nobody waits on it.

### Fixed

- The page said a photo takes several seconds on a modern laptop. That stopped being true when the graphics path landed, and it now describes both engines.

## [2.2.0] - 2026-07-28

### Added

- A GPU engine. If your browser can reach your graphics chip, the cutout now runs there at the model's native 1024 pixels instead of 384, and finishes in about a quarter of a second instead of four and a half. The extra resolution is what keeps single hairs and thin edges intact rather than averaging them into the background. That model is float16 and downloads once at about 85 MB; it is stored gzipped because the raw file is past the 100 MB a file can be in a git repository.

### Changed

- Browsers without WebGPU are unaffected: same 40 MB int8 model, same speed, same result as before. If a graphics driver claims WebGPU and then fails, the cutout quietly falls back to the processor instead of breaking.

## [2.1.1] - 2026-07-26

### Changed

- The model sometimes left a stray fleck of background floating in the transparent area. Those are dropped now. The pass only touches islands far smaller than the subject, so a hand or a second person survives it.

## [2.1.0] - 2026-07-22

### Changed

- The model works on a 384-pixel canvas instead of 512. That takes about 4.5 seconds where 512 took 8, with no difference I could see in the result. 320 was quicker again but started leaving pieces of the background behind. The model file is the same, so the download has not changed.

### Fixed

- Swapping the model no longer leaves the previous version's file cached in your browser.

## [2.0.2] - 2026-07-21

### Changed

- Another pass at the sample photo. This frame is sharper and the green reads more clearly against the wood, which is what the cut kept struggling with. Both hands come back complete, no rim of boat attached.

## [2.0.1] - 2026-07-21

### Changed

- A higher-resolution frame of the same scene for the sample, cropped square to fill the card. The old shot was soft enough that her left hand came back as a ghost.

## [2.0.0] - 2026-07-21

### Changed

- The cutout runs on BiRefNet instead of ISNet. The old model was a salient-object detector: it locked onto the one obvious subject and gave up on anything low-contrast, so a pale hand resting on pale wood came back as a smudge. BiRefNet cuts it whole.
- The model is re-exported to a 512x512 ONNX and quantized to int8, about 40 MB gzipped, downloaded once and cached for offline use. Input normalization moved to ImageNet statistics.

### Added

- A new sample photo, framed tight on the subject.

## [1.3.1] - 2026-07-20

### Fixed

- Two FAQ entries opened and closed together because they shared one container. Each question is back in its own panel and toggles on its own.

## [1.3.0] - 2026-07-20

### Changed

- Cleaner edges. The cutout used to carry a faint halo of the old background's color, a pale ring on a bright scene, a brown one on wood, which showed when you dropped it on a different background. The edge pixels are now un-mixed to recover their true color, and the faintest fringe is trimmed, so the subject sits cleanly on any backdrop.

### Added

- A note in the FAQ: a premium version with tap-to-select objects is coming to JaydenART.com.

## [1.2.1] - 2026-07-20

### Fixed

- Links no longer show an open-in-new icon on every link. That marker belongs only to document links inside a result, which this tool does not have, so the footer and prose links are plain again, matching the rest of the suite.

## [1.2.0] - 2026-07-20

### Fixed

- The progress bar no longer shows a "Working…" label on load. It was visible with nothing running because a stylesheet rule was overriding the hidden state; it now stays hidden until a photo is actually being processed.
- The FAQ heading now uses the same speech-bubble icon as the rest of the suite.

### Changed

- The sample is now a photo card that shows the shot before you try it: "The Girl on the Boat", by Jayden. Framed on the subject so the cutout comes back clean.
- The model download now starts on the first sign of engagement, so by the time you click the sample the only wait left is the model thinking, not the download. The sample photo itself is already on the page, so it loads instantly.

## [1.1.0] - 2026-07-20

### Changed

- Renamed to Background Bouncer. The bouncer checks the guest list: your subject is on it and stays, the background is not and gets walked to the door. The name says what the tool does at a glance, and it is easier to find. The copy across the page now speaks in that voice.

## [1.0.1] - 2026-07-20

### Fixed

- Very large photos no longer risk a blank export or a crashed tab. A phone camera can shoot 48 megapixels, past the canvas size a mobile browser will hold, so the output is now bounded to a safe area while keeping the aspect ratio. Ordinary photos are unaffected; only very large ones are scaled down, which is invisible for web use.

## [1.0.0] - 2026-07-20

### Added

- The whole tool. Drop, paste, or upload a photo and get a transparent PNG back, entirely in the browser: ISNet finds the subject, a guided filter re-cuts the edges against the full-resolution photo, and nothing is ever uploaded.
- A before-and-after wipe with checkerboard, white, black, and custom preview backgrounds, sharing the suite's color picker.
- Offline support: the 44 MB model is cached after the first run and the page itself is precached by a service worker.
- The suite shell: dark and light themes, the sponsor button, the animated scene, and a 404 page that knows where the tool lives.
