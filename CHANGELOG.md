# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-07-20

### Added

- The whole tool. Drop, paste, or upload a photo and get a transparent PNG back, entirely in the browser: ISNet finds the subject, a guided filter re-cuts the edges against the full-resolution photo, and nothing is ever uploaded.
- A before-and-after wipe with checkerboard, white, black, and custom preview backgrounds, sharing the suite's color picker.
- Offline support: the 44 MB model is cached after the first run and the page itself is precached by a service worker.
- The suite shell: dark and light themes, the sponsor button, the animated scene, and a 404 page that knows where the tool lives.
