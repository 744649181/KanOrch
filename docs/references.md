# Reference material

The product implementation is self-contained. These sources inform compatibility and future
distribution work:

- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security):
  isolated renderer and restricted navigation.
- [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules):
  ABI implications for a packaged desktop runtime.
- [Electron headless CI](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci):
  Xvfb for Linux window tests.
- [node-pty](https://github.com/microsoft/node-pty): platform support and Linux build tools.
- [Node SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html):
  embedded database API used by the runtime.

Herdr's agent communication may be studied as interface reference. It is not a build, test,
runtime, or publishing dependency. Historical K-now documents and uncommitted experiments
remain in their original worktrees until individually reviewed and imported.
