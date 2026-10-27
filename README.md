# Multi AI

One app, one home screen of icons: Claude 1 to 4, ChatGPT, Gemini, Grok, DeepSeek, Perplexity, Copilot, NotebookLM, Mistral, plus anything you add.

## Features

- **Home screen of icons.** Click one to open that service full-size. Each service keeps its saved login.
- **Background tabs.** Opened services keep running. Switch with the tabs in the top bar, or press Home. The x on a tab closes it (the login stays saved).
- **Split screen.** Press Split in the top bar and pick a second app to show beside the current one, or right-click an icon or tab and choose "Show beside current app". Split also offers Swap sides and Close split screen.
- **Zoom.** Use the - / 100% / + buttons in the top bar, or Ctrl +, Ctrl -, Ctrl 0 inside a page. Zoom is remembered per service and acts on the pane you last clicked in.
- **Right-click menu** on any icon or tab: Open, split screen, zoom, Reload, Close, Edit. Right-clicking inside a page gives Copy / Paste / Open link in browser.
- **Remembers your session.** Window size and position, which apps were open, the split layout and zoom levels come back the next time you start the app.
- **More reliable.** Only one copy can run at a time, settings are saved safely, a crashed page reloads itself, and pages retry if the internet was down at start.
- **Passkey prompt turned off** inside the app (`webauthn-off.js`), so Google and other sites fall back to the normal password screen.
- **Claude usage bars** on the Claude tiles, read from each account's claude.ai Settings > Usage page (refresh every 5 minutes).
- Hover a tile and click the pencil (or right-click > Edit) to rename it, change its address, choose whether it shares a login with other apps, or remove it. The + tile adds a new service.

## Build the Windows app on GitHub

1. Upload these files to your GitHub repository and commit: `main.js`, `preload.js`, `webauthn-off.js`, `index.html`, `package.json`, `README.md`, and the `.github/workflows/build.yml` workflow. Files with the same names replace the old ones.
2. Open the Actions tab and wait for the green check (about 3 minutes). The workflow runs on every push to main, and can also be started by hand with "Run workflow".
3. Open the run, download `Claude-Multi-Windows` from Artifacts, unzip, and run the Setup .exe. Installing over the old version keeps your saved logins.

## Run locally instead

```
npm install
npm start
```

Run these in the folder that contains `package.json`.

## Notes

- Google blocks its own sign-in inside apps like this one. Gemini and NotebookLM (and any tile with the blue arrow) therefore open in your normal browser, where you are already signed in. Turn this on for any other tile with "Open in my browser instead" in its Edit window. For other services, use email or password login (for Claude, "Continue with email") instead of "Continue with Google". Manus also offers email, Microsoft and Apple sign-in.
- Usage bars rely on the text of claude.ai's usage page, so they may need a small update if that page changes.
