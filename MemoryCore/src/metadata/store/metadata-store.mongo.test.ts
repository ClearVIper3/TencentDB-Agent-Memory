/**
 * IMetadataStore 契约测试 —— MongoDB 驱动（可选）。
 *
 * 默认跳过：mongodb-memory-server 首次运行需下载 mongod 二进制，且生产
 * 级联依赖副本集事务。显式设置 TDAI_TEST_MONGO=1 启用：
 *
 *   TDAI_TEST_MONGO=1 npm test
 *
 * 共享一个内存 mongod，每个用例用独立 dbName 隔离数据；适配器以
 * useTransactions=false + ownsClient=false 接入（standalone 无事务能力，
 * 由契约用例保证行为而非原子性）。
 */
import { describe, beforeAll, afterAll } from "vitest";
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import type { IMetadataStore } from "./interface.js";

const enabled = process.env.TDAI_TEST_MONGO === "1";

describe.runIf(enabled)("MongoDB contract driver", () => {
  let client: import("mongodb").MongoClient;
  let mongod: import("mongodb-memory-server").MongoMemoryServer;
  let dbSeq = 0;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const mongodb = await import("mongodb");
    mongod = await MongoMemoryServer.create();
    client = await mongodb.MongoClient.connect(mongod.getUri());
  });

  afterAll(async () => {
    await client?.close();
    await mongod?.stop();
  });

  runMetadataStoreContract(
    "MongoDB (memory-server)",
    async (): Promise<IMetadataStore> => {
      const { MongoMetadataStore } = await import("./mongodb-adapter.js");
      dbSeq += 1;
      const dbName = `meta-contract-${process.pid}-${dbSeq}`;
      return new MongoMetadataStore(client, dbName, {
        useTransactions: false,
        ownsClient: false,
      });
    },
    async (store) => {
      await store.close();
    },
  );
});
