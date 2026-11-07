# Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| App | Expo (React Native) + TypeScript | One codebase for iOS, Android and web |
| Auth | Firebase Authentication | Login, sessions and tokens (JWT) |
| API | TypeScript API on Railway | Checks the Firebase token, enforces permissions, runs the game logic |
| Database | Postgres on Railway | All application data. Only the API connects to it |
| Hosting (web) | Firebase Hosting | Serves the Expo web build; preview channels for testing before release |
| Dev data (local only) | Postgres in Docker | 3 years of daily open/close from Yahoo: USD/ILS, 20 TASE and 20 US stocks. See [DECISIONS.md](DECISIONS.md) D-002 |

## Who handles what

Firebase knows **who** the user is. The API and Postgres decide **what** the user may do, and hold all the data.

```
App ──login──▶ Firebase Auth ──JWT──▶ App ──request + JWT──▶ API ──SQL──▶ Postgres
```

### Firebase handles

- **Sign-in:** email/password and Google.
- **Sessions:** issues the JWT (ID token), refreshes it every hour, keeps the user logged in across reloads.
- **Account emails:** password reset and email verification.
- **Authorized domains:** which websites are allowed to sign in (set in the Firebase console).
- **Hosting:** serves the web build.

Firebase stores no application data. Nothing is saved in Firestore.

### The API handles

- **Identity check:** verifies the JWT signature on every request with Google's public keys. The `uid` and `email` come from the verified token, never from the request body.
- **Permissions:** checks the user's roles (from Postgres) before every action. For example, advancing the clock returns 403 unless the user is an admin.
- **Game logic:** order execution, the 20% rule, scoring and advancing the clock, each in one database transaction.
- **CORS:** only the app's own web origins (the Hosting domains and `localhost`) may call it.

### Postgres handles

- **User data:** `users` table keyed by the Firebase `uid`, with `email`, `roles`, `theme` and `created_at`. The row is created by the API on the user's first request.
- **Roles:** `users.roles`. Admin is granted only with SQL. No endpoint lets a user change their own roles.
- **Game data:** securities, prices, the USD/ILS rate, the world clock, orders, portfolios, holdings, trades, snapshots and the leaderboard.
- **Data rules:** keys, foreign keys and `CHECK` constraints, so bad data is rejected even if the API has a bug.
- **Schema history:** versioned migrations in the repo, run on every deploy.

## General guidelines

- **Currency:**
  - Portfolio in ILS (₪).
- **Language:** Hebrew first, with an RTL design. English must also be supported.

- **The app never talks to Postgres directly.** Every read and write goes through the API.
- **The API is the permission layer.** Every endpoint checks the token and the roles. Never rely on client-side checks alone. Players can never write cash, holdings, prices, the clock, scores or roles.
- **Game logic is pure TypeScript** with no database or framework imports, so it can be unit tested. The API calls it and saves the result.
- **Money is `NUMERIC` in Postgres**, never float.

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
