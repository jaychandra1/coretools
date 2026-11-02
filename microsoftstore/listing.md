# Microsoft Store listing text

Paste into Partner Center → the submission → **Store listings → English**.
Keep this file in step with the app when a tool is added or changes.

## Description

```
CoreTools brings seven everyday tools for developers and IT pros into one fast, private desktop app. Everything runs on your PC: no account, no ads, no tracking.

• Diff-Checker: compare two versions of a file side by side, choose which side to keep for each change, and save the merged result.
• YML-Validator: check a Kubernetes manifest, strip server-managed and redundant fields, and get a clean, apply-ready file.
• Grammar-Polisher: spelling, grammar and style suggestions as you type, with one-click fixes, a rewrite in a professional, friendly or concise tone, and email checks. The grammar engine runs on your device.
• Authenticator: two-factor codes (TOTP and HOTP) with QR scanning, protected by a master password and optional Windows Hello.
• Credential-Manager: keep your logins in the same encrypted vault, sorted into spaces, with search, trash and an activity log.
• JSON-Studio: a full JSON workbench with validation, tree editing, JSON Schema, JSONPath queries, diff, repair, and conversion to CSV, XML, YAML and Excel.
• Codec: encode and decode Base64, URL, hex and Unicode; hash with SHA-256, SHA-512, MD5 or bcrypt; encrypt with AES-256; and inspect JWTs, JSON and hex dumps.

Private by design
Your vault is encrypted with Argon2id and AES-256-GCM. The only feature that uses the internet is an optional Google Drive backup, which is end-to-end encrypted before it leaves your PC.

Before you uninstall: removing the app deletes its data on this PC. Export a backup, or turn on Google Drive backup, first.
```

## Product features

One per line (max 20, 200 characters each):

```
Compare and merge files side by side
Clean, validate and optimize Kubernetes YAML
Spelling, grammar and tone checks that run on your device
Two-factor codes with QR scanning and Windows Hello unlock
Encrypted password vault with spaces, search and trash
JSON workbench: schema, queries, diff, repair and conversion
Encode, decode, hash and encrypt: Base64, SHA-256, bcrypt, AES-256, JWT
Works offline: no account, ads or tracking
Optional end-to-end encrypted Google Drive backup
```

## Supplemental fields

| Field | Text |
| --- | --- |
| Short title (max 50) | `CoreTools` |
| Voice title | `Core Tools` |
| Short description (best under 270) | `Seven private, offline tools in one desktop app: compare files, clean up Kubernetes YAML, check grammar, generate 2FA codes, keep logins in an encrypted vault, work with JSON, and encode, hash or encrypt data. Everything runs on your PC.` |

## Additional information

| Field | Text |
| --- | --- |
| Keywords (max 7; Enter after each) | `diff checker` · `Kubernetes YAML validator` · `JSON editor` · `grammar checker` · `authenticator` · `password manager` · `base64 encoder decoder` |
| Copyright and trademark info | `© 2026 JDG Initiates. Released under the MIT License.` |
| Additional license terms | Leave empty (Microsoft's Standard Application License Terms apply), or paste the repository's `LICENSE` text. |
| Developed by | `JDG Initiates` |

## Restricted capability (Submission options → runFullTrust)

```
CoreTools is a standard Win32 desktop application (built with Rust and Tauri, its window drawn with Microsoft Edge WebView2) that we package as MSIX for the Store. It is not a UWP app, so it needs runFullTrust simply to start: the package contains the same desktop executable we also distribute directly.

As a full-trust desktop app it uses these Windows APIs, all for user-initiated features:
- Windows Credential Manager, to keep the optional Google Drive backup sign-in on this device.
- Windows Hello (KeyCredentialManager), to unlock the user's encrypted vault.
- Standard Open/Save file dialogs, to read and write only the files the user picks.
- The clipboard, with copied passwords excluded from clipboard history and cloud sync, and read only when the user clicks Paste.
- A temporary local loopback listener (127.0.0.1) during Google sign-in, used only when the user connects the optional backup.

It runs with normal user rights only: no administrator elevation, no services, drivers or startup tasks, no changes to system settings, and no background activity. It collects no telemetry. In the Store package the app's own updater is switched off, so updates come only through the Microsoft Store.
```

Screenshot captions are in [README.md](README.md).
