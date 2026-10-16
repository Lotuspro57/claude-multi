# Multi AI

One app, one home screen of icons: Claude 1 to 4, ChatGPT, Gemini, Grok, DeepSeek, Perplexity, Copilot, NotebookLM, Mistral, plus anything you add.

- Click an icon to open that service full-size.
- Each service has its own saved login (log in once, it stays after you close the app).
- Opened services keep running in the background. Switch between them with the tabs in the top bar, or press Home to go back to the icons.
- The x on a tab closes it (the login stays saved).
- Claude tiles show usage bars read from each account's claude.ai Settings > Usage page (refresh every 5 minutes).
- Hover a tile and click the pencil to rename it, change its address or remove it. The + tile adds a new service.

## Build the Windows app on GitHub

1. Upload these files to your GitHub repository (main.js, preload.js, index.html, package.json, README.md) and commit. Same names replace the old ones.
2. Open the Actions tab and wait for the green check (about 3 minutes).
3. Open the run, download `Claude-Multi-Windows` from Artifacts, unzip, and run the setup .exe. Installing over the old version keeps your saved logins.

## Run locally instead

```
npm install
npm start
```

Run these in the folder that contains `package.json`.

## Notes

- Google sign-in may still refuse in some cases. If so, use email login for that service.
- Usage bars rely on the text of claude.ai's usage page, so they may need a small update if that page changes.
