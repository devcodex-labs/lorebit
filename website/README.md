# lorebit documentation build workspace

`website/` is the single dependency and command workspace for two isolated Rspress sites:

- **Public User Site** — tracked build surface at `user-site/`; Chinese user content remains in repository-root `../docs/zh/`; GitHub Pages may publish only `user-site/dist/`.
- **Maintainer Site** — internal truth root at `../../.devcodex/lorebit/maintainer-site/`; generated output goes to ignored `maintainer-site/dist/`; it must never enter product Git or Pages.

The sites share `package.json`, `package-lock.json` and `node_modules`, but they do not share content roots, configs, navigation, search indexes or output directories.

## Requirements

- Node.js `>=22.12.0`
- npm with lockfile-compatible `npm ci`

## Commands

```bash
npm ci

# Public User Site (also the default dev/build/test/preview target)
npm run dev:user
npm run test:user
npm run preview:user

# Internal Maintainer Site (localhost only)
npm run dev:maintainer
npm run test:maintainer
npm run preview:maintainer
```

## Change and verification flow

1. Change Public content only under `../docs/zh/`; keep user tasks free of internal maintenance material.
2. Change Maintainer content only in the internal truth root, and update its source digest manifest when an upstream contract changes.
3. Run the matching `test:*` command. Run both when package scripts, Rspress, shared dependencies or Pages boundaries change.
4. Treat every `dist/` as rebuildable output. Do not copy either site into the other.

`.github/workflows/pages.yml` installs from this root lockfile, runs `npm run test:user`, and uploads only `website/user-site/dist`.
