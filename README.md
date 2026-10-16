# Claude Multi

Four Claude accounts side by side in one window. Each pane keeps its own saved login, so you sign in once per account.

## Run

1. Install Node.js (https://nodejs.org) if you don't have it.
2. In this folder:

```
npm install
npm start
```

## Use

- Log in to each of the four panes once. Logins are stored on your computer and stay after you close the app.
- The strip above each pane shows that account's usage bars, read from its claude.ai Settings > Usage page. It refreshes every 5 minutes, or press "usage".
- Click the account name to rename it. "zoom" enlarges one pane; click it again to go back.
- "home" returns a pane to claude.ai.

## Notes

- Usage is read from the text of the usage page, so if claude.ai changes that page the bars may need a small update in `fetchUsage` in `main.js`.
- This does not use the browser extension; it reads the same page directly.
- Sign-in with Google may refuse to work inside embedded apps. If so, use email login for that account.
