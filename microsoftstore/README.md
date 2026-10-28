# Microsoft Store listing images

For Partner Center → the submission → **Store listings**. Everything here is
generated; edit the scripts and run them again rather than editing files:

- `node scripts/generate-store-art.mjs` — logos and promotional art (the
  CoreTools mark and Inter, as on the website).
- `node scripts/store-screenshots.mjs` — the screenshots, from the app
  itself with made-up demo data (Contoso, Fabrikam, Northwind…).

## Screenshots

Upload in this order (drag to reorder in Partner Center). All 1920 × 1080,
dark theme. Captions (max 200 characters):

| File | Caption |
| --- | --- |
| `screenshots/1-diff-checker.png` | Compare two versions of a file, review every change and choose which side to keep. Everything runs on your PC. |
| `screenshots/2-yml-validator.png` | Clean up Kubernetes manifests: strip server-managed and redundant fields and get an apply-ready file. |
| `screenshots/3-grammar-polisher.png` | Spelling, grammar and tone suggestions as you type, plus email checks. The grammar engine runs on your device. |
| `screenshots/4-authenticator.png` | Two-factor codes for all your accounts, encrypted with your master password and unlocked with Windows Hello. |
| `screenshots/5-credential-manager.png` | Keep your logins in an encrypted vault with categories, owners, tags, search and trash. |
| `screenshots/6-json-studio.png` | A full JSON workbench: format, query with JSONPath or JMESPath, validate schemas, diff, repair and convert. |

## Store logos

| Partner Center slot | File |
| --- | --- |
| 9:16 Poster art (720 × 1080) | `poster-art-720x1080.png` |
| 9:16 Poster art (1440 × 2160) | `poster-art-1440x2160.png` |
| 1:1 Box art (1080 × 1080) | `box-art-1080x1080.png` |
| 1:1 Box art (2160 × 2160) | `box-art-2160x2160.png` |
| 1:1 App tile icon (300 × 300) | `tile-300x300.png` |
| 1:1 (150 × 150) | `tile-150x150.png` |
| 1:1 (71 × 71) | `tile-71x71.png` |

The three tiles are optional: without them the Store uses the logos in the
MSIX package. They have transparent corners, like the app icon.

## Promotional images

| Partner Center slot | File |
| --- | --- |
| 16:9 Super hero art (1920 × 1080) | `super-hero-art-1920x1080.png` |
| 16:9 Super hero art (3840 × 2160) | `super-hero-art-3840x2160.png` |
| Xbox: Titled hero art (1920 × 1080) | `titled-hero-art-1920x1080.png` |
| Xbox: Featured promotional square art (1080 × 1080) | `promotional-square-art-1080x1080.png` |
| Xbox: Branded key art (584 × 800) | `branded-key-art-584x800.png` |

- Super hero art follows Microsoft's rules: no text, no app screenshots,
  nothing important in the bottom third. It's recommended for every app.
- Poster art and the three Xbox images matter only on Xbox, which CoreTools
  doesn't target (the package is Windows desktop only); uploading them does
  no harm. The titled hero art and key art carry the name in the top two
  thirds; the promotional square has none, as required.
- Where a slot takes either size, one upload is enough; the larger stays
  sharp on high-resolution screens.
