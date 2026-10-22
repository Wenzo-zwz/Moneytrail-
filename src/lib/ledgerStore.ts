import type { LedgerStore } from "./cloudStore";
import {
  loadData,
  saveData,
  restoreData,
  readStoredRaw,
  STORAGE_KEY,
} from "./storage";

/** Legacy device-only storage remains separate from every authenticated account. */
export const localLedgerStore: LedgerStore = {
  loadData,
  saveData,
  restoreData,
  readStoredRaw,
  subscribe(listener) {
    const handle = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) listener();
    };
    window.addEventListener("storage", handle);
    return () => window.removeEventListener("storage", handle);
  },
};
