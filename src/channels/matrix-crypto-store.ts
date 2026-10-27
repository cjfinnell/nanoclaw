/**
 * Persistent Matrix device for the E2EE adapter.
 *
 * The adapter's Rust crypto keeps the device's Olm identity, Olm sessions and
 * inbound Megolm keys in IndexedDB. Node has none, so this module installs
 * fake-indexeddb (in memory) and mirrors every database to one file on disk:
 * restored before the crypto initializes, rewritten shortly after each
 * readwrite transaction commits, and flushed on shutdown.
 *
 * The same file holds the device's access token and device ID. Keys and login
 * have to travel together: reusing a device ID under fresh keys is rejected by
 * the homeserver, and old keys under a new device ID are useless. So either
 * the whole snapshot is restored, or none of it and the adapter logs in fresh.
 *
 * Why this matters: a new device on every start forces each of the user's
 * clients to notice the device-list change before it shares room keys. A
 * client that misses it encrypts to the old device and the bot cannot read
 * those messages (seen 2026-10-26 after five restarts in 30 minutes).
 */
import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import v8 from 'v8';

import { log } from '../log.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- IndexedDB types need lib "dom", which this project leaves out */
const idb = (): any => (globalThis as any).indexedDB;

export interface MatrixDeviceSession {
  userId: string;
  deviceId: string;
  accessToken: string;
}

interface IndexDump {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface StoreDump {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexDump[];
  keys: unknown[];
  values: unknown[];
}

interface DatabaseDump {
  name: string;
  version: number;
  stores: StoreDump[];
}

interface Snapshot {
  format: 1;
  savedAt: string;
  session: MatrixDeviceSession;
  databases: DatabaseDump[];
}

/** Coalesces bursts of writes (one sync can commit dozens of transactions). */
const SAVE_DEBOUNCE_MS = 250;

function requestResult<T>(req: any): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: any): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function dumpDatabase(name: string): Promise<DatabaseDump> {
  const db = await requestResult<any>(idb().open(name));
  try {
    const storeNames: string[] = Array.from(db.objectStoreNames);
    const stores: StoreDump[] = [];
    if (storeNames.length > 0) {
      // One readonly transaction across every store gives a consistent copy.
      const tx = db.transaction(storeNames, 'readonly');
      for (const storeName of storeNames) {
        const store = tx.objectStore(storeName);
        const indexes: IndexDump[] = Array.from(store.indexNames as string[]).map((indexName) => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        });
        const [keys, values] = await Promise.all([
          requestResult<unknown[]>(store.getAllKeys()),
          requestResult<unknown[]>(store.getAll()),
        ]);
        stores.push({
          name: storeName,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes,
          keys,
          values,
        });
      }
      await transactionDone(tx);
    }
    return { name, version: db.version, stores };
  } finally {
    db.close();
  }
}

async function loadDatabase(dump: DatabaseDump): Promise<void> {
  const open = idb().open(dump.name, dump.version);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const s of dump.stores) {
      const store = db.createObjectStore(s.name, { keyPath: s.keyPath ?? undefined, autoIncrement: s.autoIncrement });
      for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
    }
  };
  const db = await requestResult<any>(open);
  try {
    if (dump.stores.length === 0) return;
    const tx = db.transaction(
      dump.stores.map((s) => s.name),
      'readwrite',
    );
    for (const s of dump.stores) {
      const store = tx.objectStore(s.name);
      s.values.forEach((value, i) => (s.keyPath === null ? store.put(value, s.keys[i]) : store.put(value)));
    }
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function deleteAllDatabases(): Promise<void> {
  const dbs: { name: string }[] = await idb().databases();
  for (const { name } of dbs) await requestResult(idb().deleteDatabase(name));
}

export class MatrixCryptoStore {
  private session: MatrixDeviceSession | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private restoring = false;

  constructor(private readonly file: string) {}

  /**
   * Load the snapshot into IndexedDB. Returns the saved login, or null when
   * there is no usable snapshot (the adapter should then log in fresh).
   */
  async restore(): Promise<MatrixDeviceSession | null> {
    this.hookTransactions();
    if (!fs.existsSync(this.file)) return null;
    this.restoring = true;
    try {
      const snapshot = v8.deserialize(fs.readFileSync(this.file)) as Snapshot;
      if (snapshot.format !== 1 || !snapshot.session?.accessToken) throw new Error('unrecognized snapshot');
      for (const db of snapshot.databases) await loadDatabase(db);
      log.info('Matrix: restored crypto store', {
        deviceId: snapshot.session.deviceId,
        savedAt: snapshot.savedAt,
        databases: snapshot.databases.map((d) => d.name),
      });
      return snapshot.session;
    } catch (err) {
      log.error('Matrix: crypto store snapshot unreadable — starting a new device', { err, file: this.file });
      await this.discard();
      return null;
    } finally {
      this.restoring = false;
    }
  }

  /** Throw away the snapshot and anything already loaded from it. */
  async discard(): Promise<void> {
    await deleteAllDatabases();
    const aside = `${this.file}.discarded-${Date.now()}`;
    if (fs.existsSync(this.file)) fs.renameSync(this.file, aside);
  }

  /** Start saving: from now on every committed write rewrites the snapshot. */
  track(session: MatrixDeviceSession): void {
    this.session = session;
    this.scheduleSave();
  }

  /** Write any pending change now (shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.dirty = true;
    }
    if (this.dirty) this.queueSave();
    await this.saving;
  }

  private hookTransactions(): void {
    const proto = (globalThis as any).IDBDatabase.prototype;
    if (proto.__nanoclawHooked) return;
    const origTransaction = proto.transaction;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    proto.transaction = function (this: any, ...args: any[]) {
      const tx = origTransaction.apply(this, args);
      if (tx.mode !== 'readonly' && !store.restoring) tx.addEventListener('complete', () => store.scheduleSave());
      return tx;
    };
    proto.__nanoclawHooked = true;
  }

  private scheduleSave(): void {
    if (!this.session || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.queueSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private queueSave(): void {
    this.dirty = false;
    this.saving = this.saving
      .then(() => this.write())
      .catch((err) => {
        this.dirty = true;
        log.error('Matrix: saving crypto store failed', { err, file: this.file });
      });
  }

  private async write(): Promise<void> {
    if (!this.session) return;
    const names: { name: string }[] = await idb().databases();
    const databases: DatabaseDump[] = [];
    for (const { name } of names) databases.push(await dumpDatabase(name));
    const snapshot: Snapshot = { format: 1, savedAt: new Date().toISOString(), session: this.session, databases };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, v8.serialize(snapshot));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}
