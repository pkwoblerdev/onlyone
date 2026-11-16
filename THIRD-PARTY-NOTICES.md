> **Release review required:** This historical inventory has not been verified against the final installer and portable artifacts. Confirm package versions, complete copyright notices, license texts, and asset provenance for each actual distribution before publishing.

The design review workflow references material from Trystan Sarrade's [design system prompt repository](https://github.com/Trystan-SA/claude-design-system-prompt/tree/3c3ddb07d7aa3fef051d83608596470c95cfd8fe). The accompanying [MIT license and copyright notice](LICENSES/design-workflow-MIT.txt) are retained; upstream provenance and all other assets still require review.

# Third-Party Software Notices and Provenance

License texts accompanying this inventory are available in the [LICENSES](LICENSES/) directory. See [release status](docs/RELEASE-STATUS.md) for outstanding review items.

## onlyone (Installer and Portable Edition v1.3.38)

This document contains third-party software notices and license information for components
distributed in or bundled with the **onlyone** desktop application (v1.3.38 for Windows,
including the standard installer and portable builds).

### Project & Proprietary Notice

- **Project:** onlyone
- **Copyright:** Copyright © 2026 onlyone.labs, onlyone.dev, pkwoblerdev. All rights reserved.
- **License:** Apache License 2.0 / MIT.
- **Provenance & Integrity:** Original code, UI components, application logic, and workflow
  integrations are authored by onlyone.labs, onlyone.dev, pkwoblerdev.
- All third-party copyright notices, trademarks, and open-source licenses are acknowledged
  and retained below in compliance with their respective license conditions.

---

## 1. Desktop Runtime Environment

The desktop application runs on the Electron framework, which bundles the Chromium browser engine,
Node.js runtime, V8 JavaScript engine, and associated media libraries.

| Component | Bundled Version | License | Copyright Holder / Notice |
|---|---|---|---|
| **Electron** | 44.11.3 | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. Text in `LICENSES/MIT.txt`. |
| **Chromium & Blink** | 152.0.7977.169 / bundled | BSD-3-Clause, Apache-2.0, MIT, LGPL and others | Copyright The Chromium Authors and respective contributors. Full component inventory and licenses in `LICENSES.chromium.html` in the application root. |
| **Node.js** | 24.22.2 / bundled | MIT and others | Copyright Node.js contributors. Additional component licenses in Node.js documentation. |
| **V8** | bundled | BSD-3-Clause | Copyright 2014 the V8 project authors. |
| **ffmpeg.dll** | bundled | LGPL 2.1+ / Chromium build | Distributed as part of Chromium within Electron for audio/video playback. |

---

## 2. Bundled Production NPM Dependencies (app.asar)

The runtime dependency verifier checks the production dependency graph in `resources/app.asar`. Package manifests may include nested copies; verify the final artifact inventory before release.
These packages provide runtime services for MCP (Model Context Protocol), secure settings persistence,
and application update verification.

### Direct Dependencies

| Package | Version | License | Role / Purpose |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | Model Context Protocol client and server runtime integration. |
| `electron-store` | 8.2.0 | MIT | Encrypted and structured desktop settings persistence. |
| `electron-updater` | 6.8.9 | MIT | Auto-update engine with channel and integrity verification. |

### Complete Inventory of Bundled Production Dependencies

The package table below is supplemented by license texts in `LICENSES/runtime-additional-notices.md` and `LICENSES/runtime-updated-notices.md`. Verify the final artifact inventory before release. The table lists versions,
declared licenses, and copyright holder notices:

| Package | Version | License | Copyright Holder / Attribution |
|---|---|---|---|
| `@hono/node-server` | 2.1.8 | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | Copyright (c) 2024 Anthropic, PBC; Copyright (c) 2015 Douglas Christopher Wilson |
| `accepts` | 2.0.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `ajv` | 8.20.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin |
| `ajv-formats` | 2.1.1 | MIT | Copyright (c) 2020 Evgeny Poberezkin |
| `ajv-formats` | 3.0.1 | MIT | Copyright (c) 2020 Evgeny Poberezkin |
| `argparse` | 2.0.1 | Python-2.0 | Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam, |
| `atomically` | 1.7.0 | MIT | Copyright (c) 2020-present Fabio Spampinato |
| `body-parser` | 2.4.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `builder-util-runtime` | 9.7.0 | MIT | Copyright (c) 2015 Loopline Systems |
| `bytes` | 3.1.2 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2015 Jed Watson <jed.watson@me.com> |
| `call-bind-apply-helpers` | 1.0.2 | MIT | Copyright (c) 2024 Jordan Harband |
| `call-bound` | 1.0.4 | MIT | Copyright (c) 2024 Jordan Harband |
| `conf` | 10.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com); Copyright (c) 2020 Evgeny Poberezkin; Copyrigh... |
| `content-disposition` | 1.1.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| `content-type` | 1.0.5 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| `content-type` | 2.1.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| `cookie` | 0.7.2 | MIT | Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.... |
| `cookie-signature` | 1.2.2 | MIT | Copyright (c) 2012–2024 LearnBoost <tj@learnboost.com> and other contributors; |
| `cors` | 2.8.6 | MIT | Copyright (c) 2013 Troy Goode <troygoode@gmail.com> |
| `cross-spawn` | 7.0.6 | MIT | Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> |
| `debounce-fn` | 4.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| `debug` | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2018-2021 Josh Junon |
| `depd` | 2.0.0 | MIT | Copyright (c) 2014-2018 Douglas Christopher Wilson |
| `dot-prop` | 6.0.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| `dunder-proto` | 1.0.1 | MIT | Copyright (c) 2024 ECMAScript Shims |
| `ee-first` | 1.1.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com |
| `electron-store` | 8.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| `electron-updater` | 6.8.9 | MIT | Copyright (c) 2015 Loopline Systems; Copyright (c) Isaac Z. Schlueter and Contributors |
| `encodeurl` | 2.0.0 | MIT | Copyright (c) 2016 Douglas Christopher Wilson |
| `env-paths` | 2.2.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `es-define-property` | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| `es-errors` | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband |
| `es-object-atoms` | 1.1.2 | MIT | Copyright (c) 2024 Jordan Harband |
| `escape-html` | 1.0.3 | MIT | Copyright (c) 2012-2013 TJ Holowaychuk; Copyright (c) 2015 Andreas Lubbe; Copyright (c) 2015 Tiancheng "Timothy" Gu |
| `etag` | 1.8.1 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| `eventsource` | 3.0.7 | MIT | Copyright (c) EventSource GitHub organisation |
| `eventsource-parser` | 3.1.1 | MIT | Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com> |
| `express` | 5.2.1 | MIT | Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2013-2014 Roman Shtylman <shtylman+expressjs@gmail.c... |
| `express-rate-limit` | 8.6.2 | MIT | Copyright 2023 Nathan Friedly, Vedant K; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `fast-deep-equal` | 3.1.3 | MIT | Copyright (c) 2017 Evgeny Poberezkin |
| `fast-uri` | 3.1.9 | BSD-3-Clause | Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team> |
| `finalhandler` | 2.1.1 | MIT | Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `find-up` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `forwarded` | 0.2.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| `fresh` | 2.0.0 | MIT | Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2016-2017 Douglas Christopher Wilson <doug@somethingdoug.... |
| `fs-extra` | 10.1.0 | MIT | Copyright (c) 2011-2017 JP Richardson |
| `function-bind` | 1.1.2 | MIT | Copyright (c) 2013 Raynos. |
| `get-intrinsic` | 1.3.0 | MIT | Copyright (c) 2020 Jordan Harband |
| `get-proto` | 1.0.1 | MIT | Copyright (c) 2025 Jordan Harband |
| `gopd` | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband |
| `graceful-fs` | 4.2.11 | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors |
| `has-symbols` | 1.1.0 | MIT | Copyright (c) 2016 Jordan Harband |
| `hasown` | 2.0.4 | MIT | Copyright (c) Jordan Harband and contributors |
| `hono` | 4.13.18 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| `http-errors` | 2.0.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com; Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com |
| `iconv-lite` | 0.7.3 | MIT | Copyright (c) 2011 Alexander Shtuchkin |
| `inherits` | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |
| `ip-address` | 10.7.6 | MIT | Copyright (C) 2011 by Beau Gunderson |
| `ipaddr.js` | 1.9.1 | MIT | Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org> |
| `is-obj` | 2.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `is-promise` | 4.0.0 | MIT | Copyright (c) 2014 Forbes Lindesay |
| `isexe` | 2.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| `jose` | 6.2.10 | MIT | Copyright (c) 2018 Filip Skokan |
| `js-yaml` | 4.3.2 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin |
| `json-schema-traverse` | 1.0.0 | MIT | Copyright (c) 2017 Evgeny Poberezkin |
| `json-schema-typed` | 7.0.3 | BSD-2-Clause | Copyright (c) 2018 IETF Trust, Austin Wright, Henry Andrews, Geraint Luff, and Cloudflare, Inc. All rights reserved. |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause | Copyright (c) Remy Rylan (https://github.com/RemyRylan) |
| `jsonfile` | 6.2.1 | MIT | Copyright (c) 2012-2015, JP Richardson <jprichardson@gmail.com> |
| `lazy-val` | 1.0.5 | MIT | Copyright (c) Vladimir Krivosheev |
| `locate-path` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `lodash.escaperegexp` | 4.1.2 | MIT | Copyright jQuery Foundation and other contributors <https://jquery.org/>; Copyright and related rights for sample code are waiv... |
| `lodash.isequal` | 4.5.0 | MIT | Copyright JS Foundation and other contributors <https://js.foundation/>; Copyright and related rights for sample code are waive... |
| `math-intrinsics` | 1.1.0 | MIT | Copyright (c) 2024 ECMAScript Shims |
| `media-typer` | 1.1.1 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| `merge-descriptors` | 2.0.0 | MIT | Copyright (c) Jonathan Ong <me@jongleberry.com>; Copyright (c) Douglas Christopher Wilson <doug@somethingdoug.com>; Copyright (... |
| `mime-db` | 1.54.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `mime-types` | 3.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `mimic-fn` | 2.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `mimic-fn` | 3.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `ms` | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |
| `negotiator` | 1.1.0 | MIT | Copyright (c) 2012-2014 Federico Romero; Copyright (c) 2012-2014 Isaac Z. Schlueter; Copyright (c) 2014-2015 Douglas Christophe... |
| `object-assign` | 4.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `object-inspect` | 1.13.4 | MIT | Copyright (c) 2013 James Halliday |
| `on-finished` | 2.4.1 | MIT | Copyright (c) 2013 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `once` | 1.4.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| `onetime` | 5.1.2 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com); Copyright (c) Sindre Sorhus <sindresorhus@gmai... |
| `p-limit` | 2.3.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `p-locate` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `p-try` | 2.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `parseurl` | 1.3.3 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2017 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `path-exists` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `path-key` | 3.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `path-to-regexp` | 8.4.2 | MIT | Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com) |
| `pkce-challenge` | 5.0.1 | MIT | Copyright (c) 2019 |
| `pkg-up` | 3.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `proxy-addr` | 2.0.8 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| `qs` | 6.17.1 | BSD-3-Clause | Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors) |
| `range-parser` | 1.3.0 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2015-2016 Douglas Christopher Wilson <doug@something... |
| `raw-body` | 3.0.2 | MIT | Copyright (c) 2013-2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdo... |
| `require-from-string` | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop) |
| `router` | 2.2.0 | MIT | Copyright (c) 2013 Roman Shtylman; Copyright (c) 2014-2022 Douglas Christopher Wilson |
| `safer-buffer` | 2.1.2 | MIT | Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com> |
| `sax` | 1.6.1 | BlueOak-1.0.0 | copyright in it. |
| `semver` | 7.7.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| `semver` | 7.8.5 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| `send` | 1.2.1 | MIT | Copyright (c) 2012 TJ Holowaychuk; Copyright (c) 2014-2022 Douglas Christopher Wilson |
| `serve-static` | 2.2.1 | MIT | Copyright (c) 2010 Sencha Inc.; Copyright (c) 2011 LearnBoost; Copyright (c) 2011 TJ Holowaychuk; Copyright (c) 2014-2016 Dougl... |
| `setprototypeof` | 1.2.0 | ISC | Copyright (c) 2015, Wes Todd |
| `shebang-command` | 2.0.0 | MIT | Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva) |
| `shebang-regex` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `side-channel` | 1.1.1 | MIT | Copyright (c) 2019 Jordan Harband |
| `side-channel-list` | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| `side-channel-map` | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| `side-channel-weakmap` | 1.0.2 | MIT | Copyright (c) 2019 Jordan Harband |
| `statuses` | 2.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `tiny-typed-emitter` | 2.1.0 | MIT | Copyright (c) 2020 Zurab Benashvili (binier) <zura.bena@gmail.com> |
| `toidentifier` | 1.0.1 | MIT | Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `type-fest` | 2.19.0 | (MIT OR CC0-1.0) | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| `type-is` | 2.1.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `universalify` | 2.0.1 | MIT | Copyright (c) 2017, Ryan Zimmerman <opensrc@ryanzim.com>; COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY... |
| `unpipe` | 1.0.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `vary` | 1.1.2 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| `which` | 2.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| `wrappy` | 1.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| `zod` | 4.6.7 | MIT | Copyright (c) 2025 Colin McDonnell |
| `zod-to-json-schema` | 3.25.2 | ISC | Copyright (c) 2020, Stefan Terdell |

### License Summary of Bundled Production Dependencies

- **MIT License** (110 package entries): Full text in [`LICENSES/MIT.txt`](LICENSES/MIT.txt).
- **ISC License** (10 package entries): Full text in [`LICENSES/ISC.txt`](LICENSES/ISC.txt).
  Packages: `graceful-fs`, `inherits`, `isexe`, `once`, `semver`, `setprototypeof`, `which`, `wrappy`, `zod-to-json-schema`.
- **BSD 3-Clause License** (2 packages): Full text in [`LICENSES/BSD-3-Clause.txt`](LICENSES/BSD-3-Clause.txt).
  Packages: `fast-uri`, `qs`.
- **BSD 2-Clause License** (2 package entries): Full text in [`LICENSES/BSD-2-Clause.txt`](LICENSES/BSD-2-Clause.txt).
  Package: `json-schema-typed` (7.0.3, 8.0.2).
- **Blue Oak Model License 1.0.0** (1 package): Full text in [`LICENSES/BlueOak-1.0.0.txt`](LICENSES/BlueOak-1.0.0.txt).
  Package: `sax`.
- **Python Software Foundation License 2.0** (1 package): Full text in [`LICENSES/Python-2.0.txt`](LICENSES/Python-2.0.txt).
  Package: `argparse`.
- **Dual MIT / CC0-1.0** (1 package):
  Package: `type-fest`.

---

## 3. Bundled Typography & Fonts

### Embedded WOFF2 Web Fonts (`src/renderer/fonts/`)

The 26 `.woff2` font files located in `src/renderer/fonts/` are unmodified web font distributions
from Fontsource under the **SIL Open Font License 1.1 (OFL-1.1)**.
The complete OFL 1.1 text, SHA-256 hashes, and per-family copyright notices are preserved in [`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt).

| Font Family | Bundled Files | Package | Version | Copyright Notice |
|---|---|---|---|---|
| **Instrument Sans** | 6 files (`latin`, `latin-ext` 400, 500, 600) | `@fontsource/instrument-sans` | 5.3.0 | Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans) |
| **Fira Code** | 8 files (`cyrillic`, `cyrillic-ext`, `latin`, `latin-ext` 400, 500) | `@fontsource/fira-code` | 5.3.0 | Copyright 2014-2020 The Fira Code Project Authors (https://github.com/tonsky/FiraCode) |
| **Newsreader** | 4 files (`latin`, `latin-ext` 300, 400) | `@fontsource/newsreader` | 5.3.0 | Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader) |
| **Onest** | 8 files (`cyrillic`, `cyrillic-ext`, `latin`, `latin-ext` 400, 500) | `@fontsource/onest` | 5.3.1 | Copyright 2021 The Onest Project Authors (https://github.com/simpals/onest) |

*Additional typography standards referenced in system fallback stacks:*
- **Inter**: Copyright 2016-2024 The Inter Project Authors (Rasmus Andersson). SIL Open Font License 1.1.
- **JetBrains Mono**: Copyright 2020 The JetBrains Mono Project Authors (Philipp Nurullin, Konstantin Bulenkov, JetBrains s.r.o.). SIL Open Font License 1.1.

### Emoji Typography (`src/renderer/fonts/twemoji.ttf`)

- **File:** `src/renderer/fonts/twemoji.ttf` (1,474,284 bytes, SHA-256 `6d90152ee0d29e82fe2a87793af5aa4b7ad13e6538360889e141e81ed299ee8e`)
- **Distribution:** Twemoji Mozilla 0.7.0 (via Mozilla twemoji-colr project: https://github.com/mozilla/twemoji-colr).
- **Emoji Artwork:** Twemoji, Copyright © 2019 Twitter, Inc. and other contributors.
  Licensed under **Creative Commons Attribution 4.0 International (CC-BY 4.0)**.
  Full license text in [`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt).
- **Font Build & Generation Code:** Copyright Mozilla Corporation, licensed under **Apache License 2.0**.
  Full license text in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

---

## 4. Vendored Browser Libraries (`src/renderer/vendor/`)

Standalone client-side libraries embedded directly into the renderer UI:

| Component | File | Version | License | Copyright Notice |
|---|---|---|---|---|
| **React** | `src/renderer/vendor/react.production.min.js` | 18.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates (Facebook, Inc.). Text in `src/renderer/vendor/react-LICENSE.txt` and `LICENSES/MIT.txt`. |
| **ReactDOM** | `src/renderer/vendor/react-dom.production.min.js` | 18.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates (Facebook, Inc.). Text in `src/renderer/vendor/react-dom-LICENSE.txt` and `LICENSES/MIT.txt`. |
| **QR Code Generator** | `src/renderer/vendor/qrcode.js` | 2009 | MIT | Copyright (c) 2009 Kazuhiko Arase (http://www.d-project.com/). 'QR Code' is a registered trademark of DENSO WAVE INCORPORATED. |
| **Marked** | `src/renderer/vendor/marked.min.js` | 16.x / 18.x | MIT (Markdown: BSD-3) | Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Markdown engine portions Copyright © 2004, John Gruber. Full text in `LICENSES/MIT.txt` and `LICENSES/BSD-3-Clause.txt`. |
| **Highlight.js** | `src/renderer/vendor/highlight.min.js` | 11.12.0 | BSD-3-Clause | Copyright (c) 2006, Ivan Sagalaev and Highlight.js contributors (https://highlightjs.org/). Full text in `LICENSES/BSD-3-Clause.txt`. |

---

## 5. Mobile Application & Relay Server

### Mobile Client (`mobile/`)

The mobile companion application is built using the Capacitor runtime.
The following core packages are licensed under **MIT**:

| Package | Version | License | Copyright Holder |
|---|---|---|---|
| `@capacitor/android` | 6.2.2 | MIT | Copyright (c) 2017-present Drifty Co. |
| `@capacitor/app` | 6.0.3 | MIT | Copyright (c) 2017-present Drifty Co. |
| `@capacitor/cli` | 6.2.2 | MIT | Copyright (c) 2017-present Drifty Co. |
| `@capacitor/core` | 6.2.2 | MIT | Copyright (c) 2017-present Drifty Co. |
| `@capacitor/local-notifications` | 6.1.3 | MIT | Copyright (c) 2017-present Drifty Co. |

### Relay Server (`server/relay/`)

- **Package:** `ws` (v8.22.0)
- **License:** MIT
- **Copyright:** Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>, Copyright (c) 2013 Luigi Pinca <luigipinca@gmail.com>.

---

## 6. Graphical Assets & Trademarks

- **Application Mark & Icons:** `resources/1code.ico`, `resources/mark-variants/*`, application branding
  and logos are included in the project; their provenance and redistribution rights require confirmation.
- **Device Frame Mockups:** `src/renderer/assets/iphone-16-plus-dark.png` is used for responsive
  viewport previews; its provenance and redistribution rights require confirmation.
- **Twemoji:** All emoji glyphs displayed in the UI are authored by Twitter, Inc. / Twemoji contributors,
  licensed under Creative Commons Attribution 4.0 International (CC-BY 4.0).
- All other product names, logos, and brands mentioned are property of their respective owners.

---

## 7. License Directory Reference

Full copies of all applicable open source licenses are available in the [`LICENSES/`](LICENSES/) directory:

- [`LICENSES/MIT.txt`](LICENSES/MIT.txt) — The MIT License
- [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) — Apache License, Version 2.0
- [`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt) — SIL Open Font License, Version 1.1
- [`LICENSES/BSD-3-Clause.txt`](LICENSES/BSD-3-Clause.txt) — The 3-Clause BSD License
- [`LICENSES/BSD-2-Clause.txt`](LICENSES/BSD-2-Clause.txt) — The 2-Clause BSD License
- [`LICENSES/ISC.txt`](LICENSES/ISC.txt) — ISC License
- [`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt) — Creative Commons Attribution 4.0 International
- [`LICENSES/Python-2.0.txt`](LICENSES/Python-2.0.txt) — Python Software Foundation License Version 2
- [`LICENSES/BlueOak-1.0.0.txt`](LICENSES/BlueOak-1.0.0.txt) — Blue Oak Model License Version 1.0.0
- `LICENSES/runtime-updated-notices.md` — exact license texts for updated runtime packages
