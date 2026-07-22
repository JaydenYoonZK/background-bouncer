# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.1.0] - 2026-07-22

### Changed

- Faster cutouts. The model now works on a 384-pixel canvas instead of 512, which nearly halves the time on your device (about 4.5 seconds instead of 8, a 1.85x speedup) with no visible change to the result. The download stays the same.

### Fixed

- Swapping the model no longer leaves the previous version's file cached in your browser.

## [2.0.2] - 2026-07-21

### Changed

- The sample is a sharper, more vivid frame of the boat scene. The stronger separation between the green dress and the boat gives the cleanest cut of the set: both hands kept, no boat rim left behind.

## [2.0.1] - 2026-07-21

### Changed

- The sample is a higher-resolution, higher-contrast frame of the same scene, cropped square to fill the card, for an even cleaner cutout.

## [2.0.0] - 2026-07-21

### Changed

- New engine. The cutout now runs on BiRefNet, a high-resolution segmentation model that tells subject from background far more precisely than the previous salient-object model. Low-contrast detail a lighter model gives up on, like a pale hand resting on pale wood, now comes out whole instead of as a smudge.
- The model is re-exported to a 512x512 ONNX and quantized to int8: about 40 MB gzipped, downloaded once and cached for offline use. Input normalization moved to ImageNet statistics.

### Added

- A new sample photo, framed on the subject, that shows off the sharper cut.

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
