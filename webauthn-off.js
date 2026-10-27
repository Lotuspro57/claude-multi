// Runs before any page script in each service view.
// Hides passkey (WebAuthn) support so Google and others show the normal password login
// instead of the Windows Security passkey box.
const { webFrame } = require('electron');

webFrame.executeJavaScript(`
(function () {
  try {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true });
  } catch (e) {}
  try {
    const cc = navigator.credentials;
    if (cc) {
      const deny = () => Promise.reject(new DOMException('The operation is not allowed.', 'NotAllowedError'));
      const origGet = cc.get ? cc.get.bind(cc) : null;
      const origCreate = cc.create ? cc.create.bind(cc) : null;
      cc.get = function (opts) {
        if (opts && opts.publicKey) return deny();
        return origGet ? origGet(opts) : deny();
      };
      cc.create = function (opts) {
        if (opts && opts.publicKey) return deny();
        return origCreate ? origCreate(opts) : deny();
      };
    }
  } catch (e) {}
})();
`);
