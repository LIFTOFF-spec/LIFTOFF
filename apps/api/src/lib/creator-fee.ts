/**
 * Pencatatan trade + creator fee 80/20 kini dipakai bersama API dan indexer (Tahap 6) dan
 * berada di `@liftoff/db` (`trade-ledger.ts`); modul ini mempertahankan import lama.
 */
export { recordTradeAndCreatorFee } from "@liftoff/db";
