// vitest.setup.ts
// Dexie talks to IndexedDB directly and jsdom ships no implementation, so the
// db.ts helpers the sync engine calls would throw on import. This installs an
// in-memory IndexedDB on globalThis before any test module loads, which lets the
// tests exercise the real Dexie queries rather than a mock of them.
import 'fake-indexeddb/auto';
