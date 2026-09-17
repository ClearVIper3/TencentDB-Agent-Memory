/**
 * IMetadataStore 契约测试 —— SQLite 驱动。
 *
 * runMetadataStoreContract 的设计是「同一套用例跑在多后端上」，本文件是
 * SQLite 侧入口：每个用例拿一个干净的 :memory: 库，跑完即关。
 */
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runMetadataStoreContract } from "./metadata-store.contract.js";

runMetadataStoreContract(
  "SQLite (:memory:)",
  async () => {
    const store = new SqliteMetadataStore(":memory:");
    store.init();
    return store;
  },
  async (store) => {
    store.close();
  },
);
