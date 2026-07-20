# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
