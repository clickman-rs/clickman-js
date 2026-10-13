import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
} from "idb";
import type { Scalar } from "./privacy";
export interface Event {
  type: "track";
  messageId: string;
  event: string;
  externalId: string;
  timestamp: string;
  properties: Record<string, Scalar>;
  context: Record<string, Scalar>;
}
export type Command =
  | { kind: "track"; event: Event }
  | { kind: "identify"; anonymousId: string; externalId: string };
export interface Entry {
  id?: number;
  created: number;
  bytes: number;
  command: Command;
}
export interface State {
  anonymousId: string;
  externalId: string;
  count: number;
  bytes: number;
  owner?: string;
  leaseUntil: number;
  failures: number;
  nextAttempt: number;
}
interface Schema extends DBSchema {
  entries: { key: number; value: Entry; indexes: { created: number } };
  meta: { key: string; value: State };
}
export function uuidv7(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function fresh(): State {
  const anonymousId = `anon:${uuidv7()}`;
  return {
    anonymousId,
    externalId: anonymousId,
    count: 0,
    bytes: 0,
    leaseUntil: 0,
    failures: 0,
    nextAttempt: 0,
  };
}
export class Queue {
  private constructor(
    readonly db: IDBPDatabase<Schema>,
    readonly maxCount: number,
    readonly maxBytes: number,
  ) {}
  static async open(scope: string, maxCount: number, maxBytes: number) {
    const db = await openDB<Schema>(`clickman-v1-${scope}`, 2, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore("entries", {
            keyPath: "id",
            autoIncrement: true,
          });
          db.createObjectStore("meta");
        }
        transaction.objectStore("entries").createIndex("created", "created");
      },
      blocking() {
        db.close();
      },
    });
    const queue = new Queue(db, maxCount, maxBytes);
    await queue.change(async (state) => state);
    return queue;
  }
  async change<T>(
    work: (
      state: State,
      entries: IDBPObjectStore<
        Schema,
        ["entries", "meta"],
        "entries",
        "readwrite"
      >,
    ) => Promise<T>,
  ) {
    const tx = this.db.transaction(["entries", "meta"], "readwrite");
    try {
      const meta = tx.objectStore("meta");
      const state = (await meta.get("state")) ?? fresh();
      const result = await work(state, tx.objectStore("entries"));
      await meta.put(state, "state");
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* A failed IndexedDB request may already have aborted the transaction. */
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async append(make: (state: State) => Command | null) {
    return this.change(async (state, entries) => {
      const command = make(state);
      if (!command) return { command, dropped: 0, count: state.count };
      const bytes = new TextEncoder().encode(JSON.stringify(command)).length;
      if (bytes > 64000 || bytes > this.maxBytes)
        throw new Error("Event exceeds the queue item size limit.");
      const id = await entries.add({ created: Date.now(), bytes, command });
      state.count++;
      state.bytes += bytes;
      let dropped = 0;
      while (state.count > this.maxCount || state.bytes > this.maxBytes) {
        let cursor = await entries.openCursor();
        // A pending identity link must survive event queue pressure.
        while (cursor?.value.command.kind === "identify")
          cursor = await cursor.continue();
        if (!cursor || cursor.primaryKey === id)
          throw new Error(
            "Queue capacity is occupied by pending identity links.",
          );
        state.count--;
        state.bytes -= cursor.value.bytes;
        await cursor.delete();
        dropped++;
      }
      return { command, dropped, count: state.count };
    });
  }
  async take(owner: string) {
    return this.change(async (state, entries) => {
      const now = Date.now();
      // Expiry follows device time, which can differ from insertion order after a clock correction.
      let expired = await entries
        .index("created")
        .openCursor(IDBKeyRange.upperBound(now - 30 * 86400000, true));
      let dropped = 0;
      while (expired) {
        state.count--;
        state.bytes -= expired.value.bytes;
        await expired.delete();
        dropped++;
        expired = await expired.continue();
      }
      if (
        state.nextAttempt > now ||
        (state.leaseUntil > now && state.owner !== owner)
      ) {
        const oldest = await entries.index("created").openKeyCursor();
        const untilExpiry = oldest
          ? oldest.key + 30 * 86400000 + 1 - now
          : Infinity;
        return {
          rows: [] as Entry[],
          wait: Math.min(
            Math.max(state.nextAttempt, state.leaseUntil) - now,
            untilExpiry,
          ),
          dropped,
        };
      }
      let cursor = await entries.openCursor();
      const rows: Entry[] = [];
      let bytes = 0;
      while (
        cursor &&
        rows.length < 100 &&
        bytes + cursor.value.bytes <= 900000
      ) {
        if (
          rows.length &&
          (cursor.value.command.kind === "identify" ||
            rows[0].command.kind === "identify")
        )
          break;
        rows.push(cursor.value);
        bytes += cursor.value.bytes;
        if (cursor.value.command.kind === "identify") break;
        cursor = await cursor.continue();
      }
      if (rows.length) {
        state.owner = owner;
        state.leaseUntil = now + 60000;
      }
      return { rows, wait: 0, dropped };
    });
  }
  async finish(
    owner: string,
    rows: Entry[],
    delivered: boolean,
    retryAfter: number,
  ) {
    return this.change(async (state, entries) => {
      if (state.owner !== owner) return 0;
      if (delivered) {
        for (const row of rows)
          if (row.id !== undefined && (await entries.get(row.id))) {
            await entries.delete(row.id);
            state.count--;
            state.bytes -= row.bytes;
          }
        state.failures = 0;
        state.nextAttempt = 0;
      } else {
        state.failures++;
        const delay =
          Math.min(600000, 5000 * 2 ** Math.min(state.failures - 1, 7)) *
          (0.8 + Math.random() * 0.4);
        state.nextAttempt = Date.now() + Math.max(delay, retryAfter);
      }
      state.owner = undefined;
      state.leaseUntil = 0;
      return state.nextAttempt ? state.nextAttempt - Date.now() : 0;
    });
  }
  async clear() {
    await this.change(async (state, entries) => {
      await entries.clear();
      Object.assign(state, fresh(), { owner: undefined });
    });
  }
  async release(owner: string) {
    await this.change(async (state) => {
      if (state.owner === owner) {
        state.owner = undefined;
        state.leaseUntil = 0;
      }
    });
  }
}
