# RadPad VIA

A build of [VIA](https://github.com/the-via/app) for the RadPad: a Razer Tartarus
on an RP2040 USB-host converter, running QMK. Hosted at
https://whyaaronbailey.github.io/radpad-via/

It is VIA with one change that matters: it can configure the converter's
PowerMic builds, which have no raw HID interface.

## Why the change

The converter presents itself to PowerScribe as a Nuance PowerMic II
(`0554:1001`). PowerScribe binds the first HID collection under that ID, so the
extra raw HID interface VIA normally talks to would take dictation away from the
PowerMic. Those builds carry VIA's packets inside the PowerMic's own 39-byte
Feature report instead:

    host -> device   [0x56, seq, packet(32)]
    device -> host   [0x56, seq, ready, packet(32)]

The firmware answers from its main loop, so the app sends a request and reads
until `ready` is 1. All of this is in `src/shims/node-hid.ts`; ordinary VIA
keyboards still use raw HID exactly as before.

## Other changes

- `scripts/build-converter-definitions.cjs` builds `public/definitions` from the
  converter's definitions in `converter/definitions/`, in place of the full
  via-keyboards catalogue, so the RadPad is recognised on connect with nothing
  to sideload.
- Served from a subfolder: routes and definition fetches follow the build base.

## Build

    npm ci
    node scripts/build-converter-definitions.cjs converter/definitions/*.json
    npx vite build --base=/radpad-via/

Then publish `dist` (plus a copy of `index.html` as `404.html`) to `gh-pages`.

Firmware: `keyboards/converter/adafruit_rp2040_usbh` in the converter's QMK tree
(`tartarus2_sk` for PowerMic + VIA, `tartarus2_via` for plain VIA).

Licensed GPL-3.0, like VIA.
