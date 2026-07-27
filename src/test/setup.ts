// Vitest runs in jsdom so UI and IndexedDB behavior are exercised together.
// fake-indexeddb supplies the durable browser database API in Node.
import "fake-indexeddb/auto";
