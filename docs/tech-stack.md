# Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| App | Expo (React Native) + TypeScript | One codebase for iOS, Android and web |
| Auth | Firebase Authentication | Handles login, sessions and tokens |
| Database | Cloud Firestore | The app reads and writes it directly through the Firebase SDK; no separate API layer |
| Permissions | Firestore Security Rules | Enforce who can read and write each document, based on the signed-in user |
| Hosting (web) | Firebase Hosting | Serves the Expo web build; preview channels for testing before release |
| Dev data (local only) | Postgres in Docker | 3 years of daily open/close from Yahoo: USD/ILS, 20 TASE and 20 US stocks. The app never connects to it. See [DECISIONS.md](DECISIONS.md) D-002 |

## General guidelines

- **Currency:**
  - Portfolio in ILS (₪).
- **Language:** Hebrew first, with an RTL design. English must also be supported.

- **No custom backend:** Everything stays inside Firebase. Do not add a separate database or serverless API unless the assignment requires it.
- **Free Spark plan, so no Cloud Functions for now:** Trusted game logic (order execution, scoring) runs in the admin's browser. See [DECISIONS.md](DECISIONS.md) D-001. Keep that logic in pure TypeScript functions with no Firebase imports, so it can move to Cloud Functions later.
- **Security Rules are the permission layer:** Every collection needs rules before it ships. Never rely on client-side checks alone.

## Theme colors

These colors were eyeballed from a screenshot, so they are close approximations, not exact brand values. They describe the **dark** theme. Light-theme values still need to be chosen (Phase 1 requires a dark/light switch).

| Token | Role | Hex | Where it shows |
|-------|------|-----|----------------|
| `primary` | Primary accent (mint green) | `#5FE3B8` | Headlines, logo, tile borders, table headers |
| `background` | Dark background | `#0B2B30` | Main post backgrounds |
| `backgroundGlow` | Deep teal (gradient) | `#0F3D3B` | Radial glow behind the logo/text |
| `surfaceChart` | Navy (charts) | `#0E2233` | Chart and table backgrounds |
| `textHeading` | Headline text | `#FFFFFF` | Main titles |
| `textBody` | Body text | `#C9D6D3` | Subtitles and paragraphs |
| `divider` | Muted lines | `#2E4E50` | Table grid and dividers |
| `negative` | Negative / alert | `#E5484D` | Losses on charts (e.g. the red line) |
