(() => {
  try {
    // Disable WebAuthn APIs to avoid prompts and compatibility issues inside embedded views.
    if (window.PublicKeyCredential) {
      try { delete window.PublicKeyCredential; } catch (e) { window.PublicKeyCredential = undefined; }
    }
    if (navigator.credentials) {
      navigator.credentials.create = () => Promise.reject(new Error('WebAuthn disabled by app'));
      navigator.credentials.get = () => Promise.reject(new Error('WebAuthn disabled by app'));
    } else {
      navigator.credentials = {
        create: () => Promise.reject(new Error('WebAuthn disabled by app')),
        get: () => Promise.reject(new Error('WebAuthn disabled by app'))
      };
    }
  } catch (e) {
    // best-effort, don't crash
  }
})();
