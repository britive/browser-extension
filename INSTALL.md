# Installation

## From Marketplace

### Firefox

Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/britive/).

### Chrome

Install from the [Chrome Web Store](https://chrome.google.com/webstore).

---

## Building from Source

### Build Environment Requirements

- **Operating system:** macOS, Linux, or Windows with a POSIX-compatible shell (bash/zsh)
- **zip:** Required for packaging. Pre-installed on macOS and most Linux distributions. On Windows, use Git Bash or WSL.

No other build tools, package managers, or dependencies (such as Node.js or npm) are required. The extension is plain JavaScript, HTML, and CSS with no compilation or transpilation step.

### Step-by-Step Build Instructions

1. Clone the repository:

```sh
git clone https://github.com/britive/browser-extension.git
cd browser-extension
```

2. Run the build script:

```sh
./build.sh
```

This produces two release archives in `dist/`:

| Archive | Browser | Description |
|---|---|---|
| `dist/firefox-extension-<version>.xpi` | Firefox | Manifest V2 extension package |
| `dist/chrome-extension-<version>.zip` | Chrome | Manifest V3 extension package |

The version number is read automatically from `firefox/manifest.json`.

### Manual Build (without script)

If you prefer to build manually or cannot run the script:

**Firefox:**

```sh
cd firefox
zip -r ../dist/firefox-extension-0.1.0.xpi .
```

**Chrome:**

```sh
cd chrome
zip -r ../dist/chrome-extension-0.1.0.zip .
```

### Verifying the Build

The packaged archives should contain only the files present in the `firefox/` or `chrome/` directories. No files are generated, compiled, or transformed during the build. The `zip` command packages the source files as-is.

To inspect an archive's contents:

```sh
unzip -l dist/firefox-extension-0.1.0.xpi
unzip -l dist/chrome-extension-0.1.0.zip
```

---

## Local Installation (Development/Testing)

### Firefox

**Option A: Temporary install (lost on restart)**

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select any file inside `firefox/` (e.g. `firefox/manifest.json`)

**Option B: Install from XPI**

1. Build the XPI using the instructions above
2. Open `about:addons`
3. Click the gear icon -> **Install Add-on From File...**
4. Select the `.xpi` file from `dist/`

> Note: Unsigned XPIs only work in Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false` in `about:config`.

### Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `chrome/` directory

> Chrome does not support installing unsigned CRX/ZIP files directly. Use "Load unpacked" for local testing.

---

## Post-Install Setup

1. Click the Britive icon in the toolbar
2. Enter your tenant name (e.g. `your-company` for `your-company.britive-app.com`)
3. Click **Start Login** - an authentication window will open
4. After login completes, the popup switches to the main view automatically
5. Click your avatar (top-right) to open Settings
