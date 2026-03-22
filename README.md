# iPhone Backup Explorer

Local web utility for browsing iTunes/iPhone backup folders on Windows, previewing image/PDF files, and extracting selected files.

## What it does

- Opens a backup directory containing `Manifest.db` (plus `Manifest.plist`/`Info.plist` when available).
- Reads `Manifest.db` and reconstructs a file tree using `domain + relativePath`.
- Offers an **App-centric** tree view that groups `AppDomain*`, `AppDomainPlugin*`, `AppDomainGroup*`, and matching Mobile Documents containers by app identifier.
- Includes directory-name search in the tree: partial matches keep directory ancestors for context and include full descendants for each match.
- Resolves each file from hashed backup storage (`<backup>/<first2>/<fileID>`, with fallback checks).
- Previews image/PDF files inline, parses XML/binary plist files into JSON, and falls back to text preview for other file types.
- Exports selected files to a target folder while preserving original logical paths (`domain/relativePath`).

## Requirements

- Node.js 18+ recommended.
- A local iPhone backup folder available on disk.

## Run

```bash
npm install
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## Usage

1. Click **Open Backup**, select a folder in the picker (defaulting to your iTunes backup location), and load it.
2. Use **Tree view** to switch between **App-centric**, **Camera**, **Files**, and **Raw domains**.
3. Browse the tree and tick files to extract.
4. Click a file to preview.
5. Enter an output folder and click **Extract Selected**.

## Notes

- This tool relies on `Manifest.db` schema used by modern iTunes backups.
- Encrypted backups are detected, but this app does not implement keybag decryption. Some previews/exports may fail for encrypted content.
- For very large backups, the initial tree load may take a bit of time.
- The backend is loopback-only (`127.0.0.1`) and rejects non-local requests.
- For Electron packaging, prefer loading `http://127.0.0.1:<port>` in the renderer so frontend and backend stay same-origin.
