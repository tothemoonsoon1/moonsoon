# tothemoonsoon — Project Context for Claude

## Who I am
- Twitter/X: @m00nsoon (https://x.com/m00nsoon)
- Website: https://tothemoonsoon.xyz
- Solana address: C5maywT6FNqLZVi9m94yKc1RCstd18gYs6Cv1bzFPyD3
- SKR domain: moonsoon.skr

## Repository
- GitHub: https://github.com/tothemoonsoon1/moonsoon
- Main branch: `main`
- Deployed at: https://tothemoonsoon.xyz

## Project overview
**tothemoonsoon Strategies Hub** — a multi-page web project focused on Solana ecosystem tools and strategies. Currently contains:

### Files
- `index.html` — Seeker Season 2 daily checklist (main page)
  - Interactive task tracker with on-chain level estimation
  - SKR staking calculator with Chart.js
  - Featured dApps with tabbed categories (Wallets, DEX, DeFi, NFT, DePIN, Staking)
  - Latest news panel (right sidebar on desktop, bottom sheet on mobile)
  - Responsive: 3-col desktop layout, mobile topbar + drawer
  - Umami Analytics: `data-website-id="289eb289-b024-4df5-b133-5c2b376c29de"`

## Tech stack
- Pure HTML/CSS/JS (no framework, no build step)
- Chart.js 4.4.0 (CDN)
- QRCodeJS 1.0.0 (CDN)
- Umami Cloud Analytics
- Hosted on: (static hosting, likely Cloudflare Pages or similar)

## Design system
- Background: `#0d0d1a` (dark navy)
- Purple: `#9945FF` (Solana purple)
- Teal: `#14F195` (Solana green)
- Blue: `#00C2FF`
- Font: system-ui / -apple-system stack
- All colors defined as CSS variables in `:root`

## How to work with Claude
1. At the start of each session, read this file to understand context
2. To make changes: read the current file from GitHub, apply changes, commit directly via GitHub MCP
3. Always fetch the latest file before editing — never work from memory
4. Commit messages should be descriptive (e.g. "Add Umami analytics", "Update news section")
5. When adding new pages, maintain the same design system and nav structure

## Workflow
```
User describes change
→ Claude reads latest file from GitHub
→ Claude makes changes
→ Claude commits directly to main branch
→ Changes are live (no manual steps needed)
```

## Key patterns in the codebase
- All sections are collapsible via `toggleSection(id)`
- Tasks use `toggleTask(id)` — IDs prefixed with `t-`
- dApps use `toggleDapp(id)` — IDs prefixed with `d-`
- Featured dApps filtered by `data-cat` attribute via `setDappCat(cat, btn)`
- State is in-memory only (no localStorage)
- Prices fetched from CoinGecko API on load

## Coming soon (planned pages)
- Airdrop strategy guides: Jupiter, Kamino, Drift, Meteora
