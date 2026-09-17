/**
 * MetadataService 服务层测试 —— 多角色删除权限 + 级联清理无孤儿数据。
 *
 * 对应 issue #1321「深入」阶段验收：
 *   - 覆盖 owner / team admin / system admin 的删除权限矩阵（delete / archive）
 *   - 验证成员移除 / 用户删除级联清理后无孤儿数据（agent 本体 / task_agents /
 *     agent_fixed_assets / chat_memory 资产）
 *
 * 用真实 SQLite（:memory:）store 驱动，V3AuthContext 手工构造 —— 与生产
 * authenticateV3 的唯一差别是不经过 key 解析，角色字段语义一致。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import type { V3AuthContext } from "../router/auth.js";
import type { CreateUserInput, UserEntity, TeamEntity, AgentEntity } from "../types.js";
import { DEFAULT_PAGINATION } from "../pagination.js";
import { newExternalAssetId } from "../utils/external-asset-id.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";

const P = DEFAULT_PAGINATION;

let userSeq = 0;
function uniqueUserInput(over: Partial<CreateUserInput> = {}): CreateUserInput {
  userSeq += 1;
  return {
    auth_provider: "local",
    external_id: `svc-ext-${userSeq}`,
    username: `svc-user${userSeq}`,
    ...over,
  };
}

function authCtx(userId: string | undefined, isSystemAdmin = false): V3AuthContext {
  return { token: "test-user-key", userId, isAdmin: false, isSystemAdmin };
}

let store: SqliteMetadataStore;
let svc: MetadataService;

beforeEach(() => {
  store = new SqliteMetadataStore(":memory:");
  store.init();
  svc = new MetadataService(store);
});

afterEach(() => {
  store.close();
});

interface World {
  owner: UserEntity; // team owner（createTeam 自动成为 team admin）
  admin: UserEntity; // 非 owner 的 team admin
  peer: UserEntity; // 同 team 普通成员
  member: UserEntity; // 同 team 普通成员，目标 agent 的 owner
  outsider: UserEntity; // 仅属于 otherTeam 的普通成员
  sysAdmin: UserEntity; // system_admin，无任何 team 成员身份
  team: TeamEntity;
  otherTeam: TeamEntity;
  agent: AgentEntity; // member 在 team 的 agent
  otherAgent: AgentEntity; // member 在 otherTeam 的 agent
}

async function setupWorld(): Promise<World> {
  const owner = await store.createUser(uniqueUserInput());
  const admin = await store.createUser(uniqueUserInput());
  const peer = await store.createUser(uniqueUserInput());
  const member = await store.createUser(uniqueUserInput());
  const outsider = await store.createUser(uniqueUserInput());
  const sysAdmin = await store.createUser(uniqueUserInput({ user_type: "system_admin" }));

  const team = await store.createTeam({ name: "Team", owner_user_id: owner.user_id });
  await store.addTeamMember({ team_id: team.team_id, user_id: admin.user_id, role: "admin" });
  await store.addTeamMember({ team_id: team.team_id, user_id: peer.user_id, role: "member" });
  await store.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });

  const otherTeam = await store.createTeam({ name: "Other", owner_user_id: owner.user_id });
  await store.addTeamMember({ team_id: otherTeam.team_id, user_id: member.user_id, role: "member" });
  await store.addTeamMember({ team_id: otherTeam.team_id, user_id: outsider.user_id, role: "member" });

  const agent = await store.createAgent({
    team_id: team.team_id,
    owner_user_id: member.user_id,
    name: "member-agent",
  });
  const otherAgent = await store.createAgent({
    team_id: otherTeam.team_id,
    owner_user_id: member.user_id,
    name: "member-agent-other",
  });

  return { owner, admin, peer, member, outsider, sysAdmin, team, otherTeam, agent, otherAgent };
}

/** 给 agent 挂上完整的关联数据：task 链接 + skill/chat_memory 固定资产。 */
async function attachFullLinks(
  teamId: string,
  agentId: string,
  ownerId: string,
): Promise<{ taskId: string; skillAssetId: string; chatMemoryId: string }> {
  const task = await store.createTask({ team_id: teamId, creator_user_id: ownerId, title: "T" });
  await store.linkTaskAgent(task.task_id, agentId);
  const skillAssetId = newExternalAssetId("skill");
  await store.createAsset({
    asset_id: skillAssetId,
    team_id: teamId,
    asset_type: "skill",
    name: "S",
    owner_user_id: ownerId,
    source_type: "manual",
  });
  const chatMemoryId = buildChatMemoryAssetId(teamId, agentId);
  await store.createAsset({
    asset_id: chatMemoryId,
    team_id: teamId,
    asset_type: "chat_memory",
    name: "Memory",
    owner_user_id: ownerId,
    source_type: "auto",
    visibility: "private",
    status: "active",
  });
  await store.setAgentFixedAssets(agentId, [
    { asset_id: skillAssetId, asset_type: "skill", created_by: ownerId },
    { asset_id: chatMemoryId, asset_type: "chat_memory", created_by: ownerId },
  ]);
  return { taskId: task.task_id, skillAssetId, chatMemoryId };
}

/** 断言 agent 及其全部关联数据已清空（无孤儿）。 */
async function expectAgentFullyCleaned(
  agentId: string,
  links: { taskId: string; chatMemoryId: string },
): Promise<void> {
  expect(await store.getAgentById(agentId)).toBeNull();
  expect((await store.listTaskAgents(links.taskId, P)).items).toHaveLength(0);
  expect((await store.listAgentFixedAssets(agentId, P)).items).toHaveLength(0);
  expect(await store.getAssetById(links.chatMemoryId)).toBeNull();
}

describe("MetadataService: deleteAgentsForCaller 权限矩阵", () => {
  it("owner 可删除自己的 agent", async () => {
    const w = await setupWorld();
    const res = await svc.deleteAgentsForCaller([w.agent.agent_id], authCtx(w.member.user_id));
    expect(res.deleted_ids).toContain(w.agent.agent_id);
    expect(await store.getAgentById(w.agent.agent_id)).toBeNull();
  });

  it("team admin（非 owner）可代删成员的 agent", async () => {
    const w = await setupWorld();
    const res = await svc.deleteAgentsForCaller([w.agent.agent_id], authCtx(w.admin.user_id));
    expect(res.deleted_ids).toContain(w.agent.agent_id);
    expect(await store.getAgentById(w.agent.agent_id)).toBeNull();
  });

  it("普通成员不能删除他人的 agent", async () => {
    const w = await setupWorld();
    await expect(
      svc.deleteAgentsForCaller([w.agent.agent_id], authCtx(w.peer.user_id)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "caller is not team admin" });
    expect(await store.getAgentById(w.agent.agent_id)).not.toBeNull();
  });

  it("非本 team 成员不能删除", async () => {
    const w = await setupWorld();
    await expect(
      svc.deleteAgentsForCaller([w.agent.agent_id], authCtx(w.outsider.user_id)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "not a team member" });
  });

  it("system_admin 无需 team 成员身份可删除任意 agent", async () => {
    const w = await setupWorld();
    const res = await svc.deleteAgentsForCaller([w.agent.agent_id], authCtx(w.sysAdmin.user_id, true));
    expect(res.deleted_ids).toContain(w.agent.agent_id);
    expect(await store.getAgentById(w.agent.agent_id)).toBeNull();
  });

  it("agent 不存在时抛 agent_not_found", async () => {
    const w = await setupWorld();
    await expect(
      svc.deleteAgentsForCaller(["agent_nonexistent"], authCtx(w.peer.user_id)),
    ).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("ctx 缺少 userId 时抛 permission_denied", async () => {
    const w = await setupWorld();
    await expect(
      svc.deleteAgentsForCaller([w.agent.agent_id], authCtx(undefined)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "authentication required" });
  });
});

describe("MetadataService: archiveAgentForCaller 权限矩阵", () => {
  it("owner 可归档自己的 agent：status → inactive 且 chat_memory 资产被删", async () => {
    const w = await setupWorld();
    const links = await attachFullLinks(w.team.team_id, w.agent.agent_id, w.member.user_id);
    const archived = await svc.archiveAgentForCaller(w.agent.agent_id, authCtx(w.member.user_id));
    expect(archived.status).toBe("inactive");
    expect(await store.getAssetById(links.chatMemoryId)).toBeNull();
    expect(await store.getAgentById(w.agent.agent_id)).not.toBeNull();
  });

  it("team admin（非 owner）可代归档成员的 agent", async () => {
    const w = await setupWorld();
    const links = await attachFullLinks(w.team.team_id, w.agent.agent_id, w.member.user_id);
    const archived = await svc.archiveAgentForCaller(w.agent.agent_id, authCtx(w.admin.user_id));
    expect(archived.status).toBe("inactive");
    expect(await store.getAssetById(links.chatMemoryId)).toBeNull();
  });

  it("普通成员不能归档他人的 agent", async () => {
    const w = await setupWorld();
    await expect(
      svc.archiveAgentForCaller(w.agent.agent_id, authCtx(w.peer.user_id)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "caller is not team admin" });
    expect((await store.getAgentById(w.agent.agent_id))?.status).toBe("active");
  });

  it("system_admin 无需 team 成员身份可归档任意 agent", async () => {
    const w = await setupWorld();
    const links = await attachFullLinks(w.team.team_id, w.agent.agent_id, w.member.user_id);
    const archived = await svc.archiveAgentForCaller(w.agent.agent_id, authCtx(w.sysAdmin.user_id, true));
    expect(archived.status).toBe("inactive");
    expect(await store.getAssetById(links.chatMemoryId)).toBeNull();
  });
});

describe("MetadataService: removeTeamMemberForCaller 级联清理", () => {
  it("移除成员后其在本 team 的 agent 及关联数据全部清空，无孤儿", async () => {
    const w = await setupWorld();
    const links = await attachFullLinks(w.team.team_id, w.agent.agent_id, w.member.user_id);

    await svc.removeTeamMemberForCaller(w.team.team_id, w.member.user_id, authCtx(w.admin.user_id));

    await expectAgentFullyCleaned(w.agent.agent_id, links);
    // 成员关系已删除
    expect(await store.getTeamMember(w.team.team_id, w.member.user_id)).toBeNull();
  });

  it("成员在其它 team 的 agent 不受影响", async () => {
    const w = await setupWorld();
    await attachFullLinks(w.team.team_id, w.agent.agent_id, w.member.user_id);

    await svc.removeTeamMemberForCaller(w.team.team_id, w.member.user_id, authCtx(w.admin.user_id));

    const survived = await store.getAgentById(w.otherAgent.agent_id);
    expect(survived).not.toBeNull();
    // member 在 otherTeam 的成员关系也不受影响
    expect(await store.getTeamMember(w.otherTeam.team_id, w.member.user_id)).not.toBeNull();
  });

  it("不能移除 team owner", async () => {
    const w = await setupWorld();
    await expect(
      svc.removeTeamMemberForCaller(w.team.team_id, w.owner.user_id, authCtx(w.admin.user_id)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "cannot remove team owner" });
  });

  it("普通成员调用被拒", async () => {
    const w = await setupWorld();
    await expect(
      svc.removeTeamMemberForCaller(w.team.team_id, w.member.user_id, authCtx(w.peer.user_id)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "caller is not team admin" });
    // agent 未被误删
    expect(await store.getAgentById(w.agent.agent_id)).not.toBeNull();
  });
});

describe("MetadataService: deleteUsersForCaller 级联清理", () => {
  it("删除用户后其跨所有 team 的 agent 及关联数据全部清空，无孤儿", async () => {
    const w = await setupWorld();
    const links = await attachFullLinks(w.team.team_id, w.agent.agent_id, w.member.user_id);

    const res = await svc.deleteUsersForCaller([w.member.user_id], authCtx(w.sysAdmin.user_id, true));

    expect(res.deleted_ids).toContain(w.member.user_id);
    expect(await store.getAgentById(w.agent.agent_id)).toBeNull();
    expect(await store.getAgentById(w.otherAgent.agent_id)).toBeNull();
    await expectAgentFullyCleaned(w.agent.agent_id, links);
  });

  it("非 system_admin 调用被拒", async () => {
    const w = await setupWorld();
    await expect(
      svc.deleteUsersForCaller([w.member.user_id], authCtx(w.owner.user_id)),
    ).rejects.toMatchObject({ code: "permission_denied", message: "user management requires system admin" });
    expect(await store.getAgentById(w.agent.agent_id)).not.toBeNull();
  });

  it("不能删除最后一个 system_admin", async () => {
    const w = await setupWorld();
    await expect(
      svc.deleteUsersForCaller([w.sysAdmin.user_id], authCtx(w.sysAdmin.user_id, true)),
    ).rejects.toMatchObject({ code: "last_system_admin" });
    expect(await store.getAgentById(w.agent.agent_id)).not.toBeNull();
  });
});
